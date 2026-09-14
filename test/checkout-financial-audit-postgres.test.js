'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { createCheckoutPos } = require('../lib/checkout-pos');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');
const ID = {
  shopA: '11111111-1111-4111-8111-111111111111', shopB: '11111111-1111-4111-8111-222222222222',
  customerA: '22222222-2222-4222-8222-111111111111', customerB: '22222222-2222-4222-8222-222222222222',
  appointmentA: '33333333-3333-4333-8333-111111111111', appointmentB: '33333333-3333-4333-8333-222222222222',
  itemA: '44444444-4444-4444-8444-111111111111', itemB: '44444444-4444-4444-8444-222222222222',
  owner: '55555555-5555-4555-8555-555555555555'
};

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (appointmentId, shopId, idempotencyKey) => ({
  params: { appointmentId }, body: { idempotencyKey, payments: [] }, ownerAuth: { shopId, ownerAccountId: ID.owner }
});

async function connectWhenReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new Client({ connectionString: url });
    try { await client.connect(); return client; }
    catch (error) { lastError = error; await client.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw lastError || new Error('PostgreSQL did not start');
}

test('PostgreSQL checkout financial audit is immutable, idempotent and transactional', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-checkout-pg-'));
  const data = path.join(temp, 'data');
  const port = 57900 + Math.floor(Math.random() * 80);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db; let pool;
  try {
    db = await connectWhenReady(url);
    await db.query(`
      CREATE EXTENSION pgcrypto;
      CREATE TABLE shops (id uuid PRIMARY KEY);
      CREATE TABLE customers (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE appointments (id uuid PRIMARY KEY, shop_id uuid NOT NULL, recipient_customer_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, appointment_id uuid NOT NULL,
        sequence_no integer NOT NULL, service_id uuid NOT NULL, service_name_snapshot text NOT NULL,
        price_snapshot numeric, UNIQUE (shop_id, id)
      );
    `);
    await db.query('INSERT INTO shops VALUES ($1), ($2)', [ID.shopA, ID.shopB]);
    await db.query('INSERT INTO customers VALUES ($1, $2), ($3, $4)', [ID.customerA, ID.shopA, ID.customerB, ID.shopB]);
    await db.query('INSERT INTO appointments VALUES ($1, $2, $3), ($4, $5, $6)', [
      ID.appointmentA, ID.shopA, ID.customerA, ID.appointmentB, ID.shopB, ID.customerB
    ]);
    await db.query(`INSERT INTO appointment_items VALUES
      ($1, $2, $3, 1, $4, 'Service A', 88.00),
      ($5, $6, $7, 1, $8, 'Service B', 98.00)`, [
      ID.itemA, ID.shopA, ID.appointmentA, '66666666-6666-4666-8666-111111111111',
      ID.itemB, ID.shopB, ID.appointmentB, '66666666-6666-4666-8666-222222222222'
    ]);
    await db.query(migration('048_checkout_pos_schema.sql'));
    await db.query(migration('051_checkout_financial_audit_schema.sql'));

    pool = new Pool({ connectionString: url, ssl: false });
    const create = createCheckoutPos({ pool }).create;
    const keyA = 'checkout-a-idempotency-key';
    const first = response(); await create(request(ID.appointmentA, ID.shopA, keyA), first);
    assert.equal(first.statusCode, 201);
    const replay = response(); await create(request(ID.appointmentA, ID.shopA, keyA), replay);
    assert.equal(replay.statusCode, 200); assert.equal(replay.body.idempotent, true);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_transactions')).rows[0].count), 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_line_items')).rows[0].count), 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_payments')).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_financial_audit')).rows[0].count), 1);

    const auditId = (await db.query('SELECT id FROM checkout_financial_audit')).rows[0].id;
    await assert.rejects(db.query('UPDATE checkout_financial_audit SET source=$1 WHERE id=$2', ['changed', auditId]), error => /immutable/.test(error.message));
    await assert.rejects(db.query('DELETE FROM checkout_financial_audit WHERE id=$1', [auditId]), error => /immutable/.test(error.message));

    const crossTenant = response();
    await create(request(ID.appointmentA, ID.shopB, 'checkout-cross-tenant-key'), crossTenant);
    assert.equal(crossTenant.statusCode, 404);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_transactions WHERE shop_id=$1', [ID.shopB])).rows[0].count), 0);

    await db.query('ALTER TABLE checkout_financial_audit ADD CONSTRAINT force_audit_failure CHECK (false) NOT VALID');
    const failing = response();
    await create(request(ID.appointmentB, ID.shopB, 'checkout-audit-failure-key'), failing);
    assert.equal(failing.statusCode, 500);
    assert.equal(Number((await db.query("SELECT COUNT(*) FROM checkout_transactions WHERE idempotency_key='checkout-audit-failure-key'")).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_line_items WHERE shop_id=$1', [ID.shopB])).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_payments WHERE shop_id=$1', [ID.shopB])).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM checkout_financial_audit WHERE shop_id=$1', [ID.shopB])).rows[0].count), 0);
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
