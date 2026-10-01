'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const preflightSql = fs.readFileSync(path.join(ROOT, 'migrations', '093_merchant_tenant_mode_preflight_readonly.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(ROOT, 'migrations', '094_merchant_tenant_mode_schema.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(ROOT, 'migrations', '095_merchant_tenant_mode_verification_readonly.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '094_merchant_tenant_mode_rollback.sql'), 'utf8');

test('PostgreSQL 17 merchant tenant_mode migration lifecycle is idempotent and safe', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-tenant-mode-'));
  const data = path.join(temp, 'data');
  const port = 54100 + Math.floor(Math.random() * 800);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port), '-k', temp], { stdio: 'ignore' });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  const connectionString = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Client({ connectionString });
      try {
        await candidate.connect();
        db = candidate;
        break;
      } catch (error) {
        await candidate.end().catch(() => {});
        if (attempt === 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(db, 'local PostgreSQL test server must accept a connection');
    db.on('error', () => {});

    // 1. Create baseline shops table without tenant_mode
    await db.query(`
      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);

    // Insert existing Shop A (representative development shop)
    await db.query(`
      INSERT INTO public.shops (id, slug, name, status)
      VALUES ('5e002f26-1267-4bb6-8c73-d60f11985799', 'gg-beauty', 'GG-Beauty', 'active')
    `);

    // 2. Run Preflight
    await db.query(preflightSql);

    // 3. Run Forward Schema Migration
    await db.query(schemaSql);

    // Verify existing Shop A received default 'live' without error
    const shopAResult = await db.query(
      `SELECT tenant_mode FROM public.shops WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`
    );
    assert.equal(shopAResult.rows[0].tenant_mode, 'live');

    // 4. Run Verification Migration
    await db.query(verifySql);

    // 5. Test Check Constraints for tenant_mode
    // Allowed values: 'demo', 'test', 'live'
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-demo', 'Demo Shop', 'demo')
    `);
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-test', 'Test Shop', 'test')
    `);
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-live', 'Live Shop', 'live')
    `);

    // Disallowed value: 'production', 'staging', 'other' -> must fail with 23514
    await assert.rejects(
      db.query(`
        INSERT INTO public.shops (slug, name, tenant_mode)
        VALUES ('shop-invalid', 'Invalid Shop', 'production')
      `),
      error => error.code === '23514'
    );

    // Idempotent schema execution
    await db.query(schemaSql);
    await db.query(verifySql);

    // 6. Test Rollback Migration
    await db.query(rollbackSql);

    // Verify tenant_mode column is removed
    const columns = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shops' AND column_name = 'tenant_mode'
    `);
    assert.equal(columns.rows.length, 0);

    // Verify shops table and data remain intact
    const remainingShops = await db.query(`SELECT slug FROM public.shops ORDER BY slug`);
    assert.deepEqual(
      remainingShops.rows.map(r => r.slug),
      ['gg-beauty', 'shop-demo', 'shop-live', 'shop-test']
    );

    // Re-apply forward migration and verification for complete round-trip proof
    await db.query(schemaSql);
    await db.query(verifySql);
  } finally {
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGINT');
    const forceKill = setTimeout(() => {
      postgres.kill('SIGKILL');
    }, 3000);
    await exited;
    clearTimeout(forceKill);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
