'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const root = path.resolve(__dirname, '..');
const preflightSql = fs.readFileSync(
  path.join(root, 'migrations/098_merchant_onboarding_invitation_preflight_readonly.sql'),
  'utf8'
);
const schemaSql = fs.readFileSync(
  path.join(root, 'migrations/099_merchant_onboarding_invitation_schema.sql'),
  'utf8'
);
const verifySql = fs.readFileSync(
  path.join(root, 'migrations/100_merchant_onboarding_invitation_verification_readonly.sql'),
  'utf8'
);
const rollbackSql = fs.readFileSync(
  path.join(root, 'migrations/rollback/099_merchant_onboarding_invitation_rollback.sql'),
  'utf8'
);

async function connectWhenReady(config, postgres, stderr) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (postgres.exitCode !== null || postgres.signalCode !== null) {
      throw new Error(`PostgreSQL exited before readiness: ${stderr()}`);
    }
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function waitForPendingShareLock(client) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await client.query(`
      SELECT lock.mode
      FROM pg_locks AS lock
      JOIN pg_class AS relation ON relation.oid = lock.relation
      JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
      WHERE activity.application_name = 'merchant-invitation-rollback-test'
        AND relation.relname = 'merchant_onboarding_invitations'
        AND lock.granted = false
    `);
    if (result.rows.length > 0) return result.rows[0].mode;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

test('12. migration files structure and syntax validation', () => {
  // Preflight 098 checks
  assert.match(preflightSql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(preflightSql, /public\.shops/);
  assert.match(preflightSql, /public\.merchant_onboarding_invitations/);
  assert.match(preflightSql, /COMMIT/i);

  // Schema 099 checks
  assert.match(schemaSql, /BEGIN;/i);
  assert.match(schemaSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(schemaSql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.merchant_onboarding_invitations/i);
  assert.match(schemaSql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(schemaSql, /token_hash TEXT NOT NULL/);
  assert.match(schemaSql, /status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(schemaSql, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(schemaSql, /consumed_at TIMESTAMPTZ/);
  assert.match(schemaSql, /revoked_at TIMESTAMPTZ/);
  assert.match(schemaSql, /resulting_shop_id UUID/);
  assert.match(schemaSql, /merchant_name_hint TEXT/);
  assert.match(schemaSql, /contact_email TEXT/);
  assert.match(schemaSql, /contact_phone TEXT/);
  assert.match(schemaSql, /created_by TEXT NOT NULL DEFAULT 'platform_cli'/);
  assert.match(schemaSql, /consumed_ip TEXT/);
  assert.match(schemaSql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(schemaSql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);

  // Check constraints and foreign keys
  assert.match(schemaSql, /CONSTRAINT merchant_onboarding_invitations_token_hash_key\s+UNIQUE \(token_hash\)/i);
  assert.match(schemaSql, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(schemaSql, /CHECK \(status IN \('pending', 'consumed', 'revoked', 'expired'\)\)/i);
  assert.match(schemaSql, /FOREIGN KEY \(resulting_shop_id\)\s+REFERENCES public\.shops \(id\)\s+ON DELETE SET NULL/i);

  // Indexes
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_status_expires_idx/i);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_resulting_shop_idx/i);
  assert.match(schemaSql, /COMMIT;/i);

  // Verification 100 checks
  assert.match(verifySql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(verifySql, /merchant_onboarding_invitations_status_check/);
  assert.match(verifySql, /merchant_onboarding_invitations_token_hash_key/);
  assert.match(verifySql, /merchant_onboarding_invitations_resulting_shop_fkey/);
  assert.match(verifySql, /COMMIT/i);

  // Rollback 099 checks
  assert.match(rollbackSql, /SAFETY WARNING/i);
  assert.match(rollbackSql, /099 merchant onboarding invitation rollback is permitted ONLY before/i);
  assert.match(rollbackSql, /DO NOT DROP merchant_onboarding_invitations/i);
  assert.match(rollbackSql, /Use forward repair instead/i);
  assert.match(rollbackSql, /BEGIN;/i);
  assert.match(rollbackSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(rollbackSql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(rollbackSql, /LOCK TABLE public\.merchant_onboarding_invitations IN SHARE MODE/i);
  assert.match(rollbackSql, /DO \$rollback\$/);
  assert.match(rollbackSql, /SELECT EXISTS \(SELECT 1 FROM public\.merchant_onboarding_invitations\)/);
  assert.match(rollbackSql, /RAISE EXCEPTION.*refuse to drop table.*forward repair/i);
  assert.match(rollbackSql, /DROP TABLE IF EXISTS public\.merchant_onboarding_invitations CASCADE/i);
  assert.match(rollbackSql, /COMMIT;/i);

  const transactionIndex = rollbackSql.search(/\bBEGIN\s*;/i);
  const lockIndex = rollbackSql.search(/LOCK TABLE public\.merchant_onboarding_invitations IN SHARE MODE/i);
  const checkIndex = rollbackSql.search(/SELECT EXISTS \(SELECT 1 FROM public\.merchant_onboarding_invitations\)/i);
  const failClosedIndex = rollbackSql.search(/RAISE EXCEPTION.*refuse to drop table.*forward repair/i);
  const dropIndex = rollbackSql.search(/DROP TABLE IF EXISTS public\.merchant_onboarding_invitations CASCADE/i);
  const commitIndex = rollbackSql.search(/\bCOMMIT\s*;/i);
  assert.equal((rollbackSql.match(/\bBEGIN\s*;/gi) || []).length, 1, 'Rollback must start exactly one SQL transaction');
  assert.equal((rollbackSql.match(/\bCOMMIT\s*;/gi) || []).length, 1, 'Rollback must commit exactly one SQL transaction');
  assert.ok(transactionIndex < lockIndex, 'Transaction must start before invitation table lock');
  assert.ok(lockIndex < checkIndex, 'Invitation table lock must be acquired before row existence check');
  assert.ok(checkIndex < failClosedIndex, 'Row existence check must precede fail-closed exception');
  assert.ok(failClosedIndex < dropIndex, 'Fail-closed guard must precede invitation table drop');
  assert.ok(dropIndex < commitIndex, 'Invitation table drop must remain inside the same transaction');
  assert.doesNotMatch(rollbackSql, /\bDELETE\s+FROM\s+(?:ONLY\s+)?public\.merchant_onboarding_invitations/i, 'Rollback must never delete invitation rows');
  assert.doesNotMatch(rollbackSql, /\bTRUNCATE(?:\s+TABLE)?\s+(?:ONLY\s+)?public\.merchant_onboarding_invitations/i, 'Rollback must never truncate invitation rows');
  for (const table of ['shops', 'customers', 'appointments', 'staff', 'services']) {
    assert.doesNotMatch(
      rollbackSql,
      new RegExp(`\\b(?:DROP(?:\\s+TABLE)?|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|ALTER\\s+TABLE|UPDATE)\\s+(?:IF\\s+EXISTS\\s+)?public\\.${table}\\b`, 'i'),
      `Rollback must leave public.${table} untouched`
    );
  }
});

test('rollback SHARE lock closes the concurrent invitation insert race and fails closed', { timeout: 20000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-invitation-rollback-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const port = 59000 + Math.floor(Math.random() * 500);
  let postgresStderr = '';
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-k', socket, '-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  postgres.stderr.on('data', chunk => { postgresStderr += chunk; });
  const postgresExit = new Promise(resolve => postgres.once('exit', resolve));
  const config = { host: socket, port, database: 'postgres', user: os.userInfo().username };
  let observer;
  let writer;
  let rollback;

  try {
    observer = await connectWhenReady(config, postgres, () => postgresStderr);
    writer = new Client(config);
    rollback = new Client({ ...config, application_name: 'merchant-invitation-rollback-test' });
    await Promise.all([writer.connect(), rollback.connect()]);

    await observer.query(`
      CREATE TABLE public.merchant_onboarding_invitations (id integer PRIMARY KEY);
      CREATE TABLE public.shops (marker integer);
      CREATE TABLE public.customers (marker integer);
      CREATE TABLE public.appointments (marker integer);
      CREATE TABLE public.staff (marker integer);
      CREATE TABLE public.services (marker integer);
      INSERT INTO public.shops VALUES (1);
      INSERT INTO public.customers VALUES (1);
      INSERT INTO public.appointments VALUES (1);
      INSERT INTO public.staff VALUES (1);
      INSERT INTO public.services VALUES (1);
    `);

    await writer.query('BEGIN');
    await writer.query('INSERT INTO public.merchant_onboarding_invitations (id) VALUES (1)');

    const rollbackResult = rollback.query(rollbackSql).then(
      () => ({ error: null }),
      error => ({ error })
    );
    const waitingMode = await waitForPendingShareLock(observer);
    assert.equal(waitingMode, 'ShareLock', 'Rollback must wait for the concurrent ROW EXCLUSIVE writer with SHARE lock');

    await writer.query('COMMIT');
    const { error } = await rollbackResult;
    assert.ok(error, 'Rollback must fail after the concurrent invitation commits');
    assert.match(error.message, /rollback blocked: real merchant invitations exist/i);
    await rollback.query('ROLLBACK');

    const invitationState = await observer.query('SELECT COUNT(*)::integer AS count FROM public.merchant_onboarding_invitations');
    assert.equal(invitationState.rows[0].count, 1, 'Committed invitation and its table must survive failed rollback');
    for (const table of ['shops', 'customers', 'appointments', 'staff', 'services']) {
      const marker = await observer.query(`SELECT marker FROM public.${table}`);
      assert.deepEqual(marker.rows, [{ marker: 1 }], `public.${table} must remain untouched`);
    }
  } finally {
    if (writer) await writer.query('ROLLBACK').catch(() => {});
    await Promise.all([
      observer ? observer.end().catch(() => {}) : Promise.resolve(),
      writer ? writer.end().catch(() => {}) : Promise.resolve(),
      rollback ? rollback.end().catch(() => {}) : Promise.resolve()
    ]);
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await postgresExit;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Migration numbering continuity verification', () => {
  const migrationsDir = path.join(root, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => /^\d{3}_/.test(f)).sort();

  const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
  const maxNumber = Math.max(...numbers);

  assert.equal(maxNumber, 106, 'Highest migration number must now be 106');

  // Verify strict continuity from 000 to 106 without any gaps or omissions
  const uniqueNumbers = new Set(numbers);
  assert.equal(uniqueNumbers.size, 107, 'Must have exactly 107 migration versions from 000 to 106 without gaps');
  for (let i = 0; i <= 106; i += 1) {
    assert.ok(uniqueNumbers.has(i), `Migration number ${String(i).padStart(3, '0')} must exist without gaps`);
  }

  assert.ok(files.includes('098_merchant_onboarding_invitation_preflight_readonly.sql'));
  assert.ok(files.includes('099_merchant_onboarding_invitation_schema.sql'));
  assert.ok(files.includes('100_merchant_onboarding_invitation_verification_readonly.sql'));
  assert.ok(files.includes('101_merchant_business_defaults_preflight_readonly.sql'));
  assert.ok(files.includes('102_merchant_business_defaults_schema.sql'));
  assert.ok(files.includes('103_merchant_business_defaults_verification_readonly.sql'));
  assert.ok(files.includes('104_staff_front_desk_activation_preflight_readonly.sql'));
  assert.ok(files.includes('105_staff_front_desk_activation_schema.sql'));
  assert.ok(files.includes('106_staff_front_desk_activation_verification_readonly.sql'));

  const rollbackFiles = fs.readdirSync(path.join(migrationsDir, 'rollback'));
  assert.ok(rollbackFiles.includes('099_merchant_onboarding_invitation_rollback.sql'));
  assert.ok(rollbackFiles.includes('102_merchant_business_defaults_rollback.sql'));
  assert.ok(rollbackFiles.includes('105_staff_front_desk_activation_rollback.sql'));
});
