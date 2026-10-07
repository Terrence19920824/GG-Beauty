'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { CHANNELS } = require('../public/booking-channel');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = (...parts) => fs.readFileSync(path.join(ROOT, 'migrations', ...parts), 'utf8');
const preflightSql = migration('108_booking_channel_attribution_preflight_readonly.sql');
const schemaSql = migration('109_booking_channel_attribution_schema.sql');
const verificationSql = migration('110_booking_channel_attribution_verification_readonly.sql');
const rollbackSql = migration('rollback', '109_booking_channel_attribution_rollback.sql');

const connectWhenReady = async (config, postgres, stderr) => {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (postgres.exitCode !== null || postgres.signalCode !== null) {
      throw new Error(`local PostgreSQL exited before readiness: ${stderr()}`);
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
};

test('booking channel migration lifecycle is idempotent, constrained, indexed and rollback-safe', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-booking-channel-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const port = 59600 + Math.floor(Math.random() * 200);
  const init = spawnSync(
    path.join(PG_BIN, 'initdb'),
    ['-D', data, '-A', 'trust', '--no-locale'],
    { encoding: 'utf8' }
  );
  assert.equal(init.status, 0, init.stderr);

  let stderrText = '';
  const postgres = spawn(
    path.join(PG_BIN, 'postgres'),
    ['-D', data, '-k', socket, '-p', String(port)],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  postgres.stderr.on('data', chunk => { stderrText += chunk; });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  let db;

  try {
    db = await connectWhenReady(
      { host: socket, port, database: 'postgres', user: os.userInfo().username, ssl: false },
      postgres,
      () => stderrText
    );
    await db.query(`
      CREATE TABLE public.appointments (
        id UUID PRIMARY KEY,
        shop_id UUID NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        booking_source TEXT NOT NULL
      )
    `);
    const shopId = '11111111-1111-4111-8111-111111111111';
    const historicalId = '22222222-2222-4222-8222-000000000001';
    await db.query(
      `INSERT INTO public.appointments (id, shop_id, start_at, booking_source)
       VALUES ($1, $2, '2025-01-01T00:00:00Z', 'online')`,
      [historicalId, shopId]
    );

    await db.query(preflightSql);
    await db.query(schemaSql);
    await db.query(verificationSql);
    await db.query(preflightSql);
    await db.query(schemaSql);
    await db.query(verificationSql);

    const historical = await db.query(
      'SELECT booking_channel FROM public.appointments WHERE id = $1',
      [historicalId]
    );
    assert.equal(historical.rows[0].booking_channel, null, 'migration must not backfill history');

    for (let index = 0; index < CHANNELS.length; index += 1) {
      await db.query(
        `INSERT INTO public.appointments
           (id, shop_id, start_at, booking_source, booking_channel)
         VALUES ($1, $2, $3, 'online', $4)`,
        [
          `22222222-2222-4222-8222-${String(index + 2).padStart(12, '0')}`,
          shopId,
          `2030-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
          CHANNELS[index]
        ]
      );
    }
    await db.query(
      `INSERT INTO public.appointments
         (id, shop_id, start_at, booking_source, booking_channel)
       VALUES ('22222222-2222-4222-8222-000000000099', $1, '2030-02-01T00:00:00Z', 'online', NULL)`,
      [shopId]
    );

    for (const [index, invalid] of ['invalid', 'Instagram', '', 'instagram-ad'].entries()) {
      await assert.rejects(
        db.query(
          `INSERT INTO public.appointments
             (id, shop_id, start_at, booking_source, booking_channel)
           VALUES ($1, $2, '2031-01-01T00:00:00Z', 'online', $3)`,
          [
            `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
            shopId,
            invalid
          ]
        ),
        error => error.code === '23514'
      );
    }

    const indexResult = await db.query(`
      SELECT index_row.indisvalid, index_row.indisready,
             pg_get_indexdef(index_row.indexrelid) AS definition
      FROM pg_index index_row
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      WHERE index_class.relname = 'appointments_booking_channel_report_idx'
    `);
    assert.equal(indexResult.rows[0].indisvalid, true);
    assert.equal(indexResult.rows[0].indisready, true);
    assert.match(indexResult.rows[0].definition, /\(shop_id, booking_channel, start_at, id\)/);

    await assert.rejects(db.query(rollbackSql), /booking channel rollback refused/);
    await db.query('ROLLBACK');
    const preserved = await db.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM public.appointments
      WHERE booking_channel IS NOT NULL
    `);
    assert.equal(preserved.rows[0].count, CHANNELS.length);

    await db.query('UPDATE public.appointments SET booking_channel = NULL');
    await db.query(rollbackSql);
    const removed = await db.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'appointments'
        AND column_name = 'booking_channel'
    `);
    assert.equal(removed.rows[0].count, 0);
    await assert.rejects(db.query(verificationSql), /nullable text column is missing/);
    await db.query('ROLLBACK');
  } finally {
    if (db) await db.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
