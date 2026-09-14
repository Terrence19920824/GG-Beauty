'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const sql048 = fs.readFileSync(path.join(ROOT, 'migrations/048_checkout_pos_schema.sql'), 'utf8');

async function connect(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const db = new Client({ connectionString: url });
    try { await db.connect(); return db; }
    catch (error) { lastError = error; await db.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw lastError;
}

async function withDatabase(t, setup, verify) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-checkout-048-'));
  const data = path.join(temp, 'data');
  const port = 58000 + Math.floor(Math.random() * 120);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  let db;
  try {
    db = await connect(`postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`);
    await db.query(`
      CREATE EXTENSION pgcrypto;
      CREATE TABLE shops (id uuid PRIMARY KEY);
      CREATE TABLE customers (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id,id));
      CREATE TABLE staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id,id));
      CREATE TABLE appointments (id uuid PRIMARY KEY, shop_id uuid NOT NULL, recipient_customer_id uuid NOT NULL, UNIQUE(shop_id,id));
      CREATE TABLE appointment_items (id uuid PRIMARY KEY, shop_id uuid NOT NULL, appointment_id uuid NOT NULL);
    `);
    await setup(db);
    await verify(db);
  } finally {
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('048 safely recognizes every composite uniqueness prerequisite state', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  await withDatabase(t, async () => {}, async db => {
    await db.query(sql048);
    assert.equal((await db.query(`SELECT count(*) FROM pg_constraint WHERE conrelid='appointment_items'::regclass AND conname='appointment_items_shop_id_id_key'`)).rows[0].count, '1');
  });
  await withDatabase(t, async db => {
    await db.query('ALTER TABLE appointment_items ADD CONSTRAINT existing_shop_item_unique UNIQUE(shop_id,id)');
  }, async db => {
    await db.query(sql048);
    assert.equal((await db.query(`SELECT count(*) FROM pg_constraint WHERE conrelid='appointment_items'::regclass AND contype='u'`)).rows[0].count, '1');
  });
  await withDatabase(t, async db => {
    await db.query('CREATE UNIQUE INDEX external_shop_item_unique ON appointment_items(shop_id,id)');
  }, async db => {
    await db.query(sql048);
    assert.equal((await db.query(`SELECT to_regclass('appointment_items_shop_id_id_key')`)).rows[0].to_regclass, null);
    assert.equal((await db.query(`SELECT to_regclass('checkout_transactions')`)).rows[0].to_regclass, 'checkout_transactions');
  });
  await withDatabase(t, async db => {
    await db.query('CREATE UNIQUE INDEX appointment_items_shop_id_id_key ON appointment_items(appointment_id,id)');
  }, async db => {
    await assert.rejects(db.query(sql048), error => /not an equivalent valid unique index/.test(error.message));
    await db.query('ROLLBACK');
    assert.equal((await db.query(`SELECT to_regclass('checkout_transactions')`)).rows[0].to_regclass, null);
  });
  await withDatabase(t, async () => {}, async db => {
    await db.query(sql048);
    await assert.rejects(db.query(sql048), error => /already exists; do not rerun 048/.test(error.message));
  });
});
