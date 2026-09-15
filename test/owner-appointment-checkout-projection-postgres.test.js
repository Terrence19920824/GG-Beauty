'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { app } = require('../server');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '11111111-1111-4111-8111-222222222222',
  locationA: '22222222-2222-4222-8222-111111111111',
  locationB: '22222222-2222-4222-8222-222222222222',
  customerA: '33333333-3333-4333-8333-111111111111',
  customerB: '33333333-3333-4333-8333-222222222222',
  serviceA: '44444444-4444-4444-8444-111111111111',
  serviceB: '44444444-4444-4444-8444-222222222222',
  staffA: '55555555-5555-4555-8555-111111111111',
  staffB: '55555555-5555-4555-8555-222222222222',
  appointmentA: '66666666-6666-4666-8666-111111111111',
  appointmentB: '66666666-6666-4666-8666-222222222222',
  itemA1: '77777777-7777-4777-8777-111111111111',
  itemA2: '77777777-7777-4777-8777-333333333333',
  itemB: '77777777-7777-4777-8777-222222222222',
  assignmentA1: '88888888-8888-4888-8888-111111111111',
  assignmentA2: '88888888-8888-4888-8888-333333333333',
  assistantA2: '88888888-8888-4888-8888-444444444444',
  checkoutA: '99999999-9999-4999-8999-111111111111'
};

const connectWhenReady = async url => {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new Client({ connectionString: url });
    try { await client.connect(); return client; }
    catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('PostgreSQL did not start');
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('owner appointment checkout projection executes once on PostgreSQL and isolates tenants', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-owner-checkout-projection-'));
  const data = path.join(temp, 'data');
  const port = 58300 + Math.floor(Math.random() * 150);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db; let pool;
  const originalGate = process.env.CHECKOUT_WRITE_ENABLED;
  try {
    db = await connectWhenReady(url);
    await db.query(`
      CREATE TABLE locations (id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text, is_active boolean NOT NULL);
      CREATE TABLE customers (id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text, phone text, email text);
      CREATE TABLE services (id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text, duration_minutes integer, price numeric);
      CREATE TABLE staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text, staff_code text);
      CREATE TABLE appointments (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
        customer_id uuid NOT NULL, service_id uuid NOT NULL, staff_id uuid NOT NULL,
        appointment_no text, start_at timestamptz, end_at timestamptz,
        status text, booking_source text
      );
      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
        appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL,
        service_name_snapshot text NOT NULL, service_locale_snapshot text,
        duration_minutes_snapshot integer NOT NULL, price_snapshot numeric,
        start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL
      );
      CREATE TABLE appointment_item_staff_assignments (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
        appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL,
        start_at timestamptz NOT NULL, end_at timestamptz NOT NULL
      );
      CREATE TABLE checkout_transactions (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, appointment_id uuid NOT NULL,
        status text NOT NULL, currency_code char(3) NOT NULL,
        quote_total_minor bigint NOT NULL, actual_total_minor bigint NOT NULL,
        discount_total_minor bigint NOT NULL, final_due_minor bigint NOT NULL,
        paid_minor bigint NOT NULL
      );
      CREATE TABLE checkout_line_items (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, checkout_id uuid NOT NULL,
        quote_price_minor bigint NOT NULL, actual_price_minor bigint NOT NULL,
        discount_minor bigint NOT NULL, final_value_minor bigint NOT NULL
      );
      CREATE TABLE checkout_payments (
        id uuid PRIMARY KEY, shop_id uuid NOT NULL, checkout_id uuid NOT NULL,
        value_kind text NOT NULL, amount_minor bigint NOT NULL
      );
    `);
    await db.query(`INSERT INTO locations VALUES ($1,$2,'A',true),($3,$4,'B',true)`, [ID.locationA, ID.shopA, ID.locationB, ID.shopB]);
    await db.query(`INSERT INTO customers VALUES ($1,$2,'A Customer','0000','a@example.invalid'),($3,$4,'B Customer','9999','b@example.invalid')`, [ID.customerA, ID.shopA, ID.customerB, ID.shopB]);
    await db.query(`INSERT INTO services VALUES ($1,$2,'A Service',60,60),($3,$4,'B Service',60,80)`, [ID.serviceA, ID.shopA, ID.serviceB, ID.shopB]);
    await db.query(`INSERT INTO staff VALUES ($1,$2,'A Staff','A1'),($3,$4,'B Staff','B1')`, [ID.staffA, ID.shopA, ID.staffB, ID.shopB]);
    await db.query(`INSERT INTO appointments VALUES
      ($1,$2,$3,$4,$5,$6,'A-1','2030-01-01T02:00Z','2030-01-01T04:00Z','in_service','online'),
      ($7,$8,$9,$10,$11,$12,'B-1','2030-01-02T02:00Z','2030-01-02T03:00Z','in_service','online')`, [
      ID.appointmentA, ID.shopA, ID.locationA, ID.customerA, ID.serviceA, ID.staffA,
      ID.appointmentB, ID.shopB, ID.locationB, ID.customerB, ID.serviceB, ID.staffB
    ]);
    await db.query(`INSERT INTO appointment_items VALUES
      ($1,$2,$3,$4,$5,1,'A Service','en',60,60,'2030-01-01T02:00Z','2030-01-01T03:00Z','in_service'),
      ($6,$2,$3,$4,$5,2,'A Service 2','en',60,80,'2030-01-01T03:00Z','2030-01-01T04:00Z','in_service'),
      ($7,$8,$9,$10,$11,1,'B Service','en',60,80,'2030-01-02T02:00Z','2030-01-02T03:00Z','in_service')`, [
      ID.itemA1, ID.shopA, ID.locationA, ID.appointmentA, ID.serviceA, ID.itemA2,
      ID.itemB, ID.shopB, ID.locationB, ID.appointmentB, ID.serviceB
    ]);
    await db.query(`INSERT INTO appointment_item_staff_assignments VALUES
      ($1,$2,$3,$4,$5,'primary','2030-01-01T02:00Z','2030-01-01T03:00Z'),
      ($6,$2,$3,$7,$5,'primary','2030-01-01T03:00Z','2030-01-01T04:00Z'),
      ($8,$2,$3,$7,$9,'assistant','2030-01-01T03:00Z','2030-01-01T04:00Z')`, [
      ID.assignmentA1, ID.shopA, ID.locationA, ID.itemA1, ID.staffA,
      ID.assignmentA2, ID.itemA2, ID.assistantA2, ID.staffA
    ]);
    await db.query(`INSERT INTO checkout_transactions VALUES ($1,$2,$3,'paid','SGD',14000,14000,0,14000,14000)`, [ID.checkoutA, ID.shopA, ID.appointmentA]);
    await db.query(`INSERT INTO checkout_line_items VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-111111111111',$1,$2,6000,6000,0,6000),
      ('aaaaaaaa-aaaa-4aaa-8aaa-222222222222',$1,$2,8000,8000,0,8000)`, [ID.shopA, ID.checkoutA]);
    await db.query(`INSERT INTO checkout_payments VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-111111111111',$1,$2,'cash_collected',14000)`, [ID.shopA, ID.checkoutA]);

    pool = new Pool({ connectionString: url, ssl: false });
    let connectCount = 0;
    app.locals.ownerAuthPool = {
      async query(sql) {
        assert.match(sql, /FROM owner_sessions/);
        return { rows: [{
          owner_account_id: 'account-a', membership_id: 'membership-a', shop_id: ID.shopA,
          login_identifier: 'owner', display_name: 'Owner', role: 'owner',
          shop_slug: 'shop-a', shop_name: 'Shop A'
        }] };
      },
      async connect() { connectCount += 1; return pool.connect(); }
    };
    process.env.CHECKOUT_WRITE_ENABLED = 'true';
    await withServer(async base => {
      const response = await fetch(`${base}/api/appointments-db?shopId=${ID.shopB}`, {
        headers: { cookie: 'gg_beauty_owner_session=local-token', 'x-shop-id': ID.shopB }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].id, ID.appointmentA);
      assert.equal(JSON.stringify(body).includes('B Customer'), false);
      assert.deepEqual(body.data[0].items.map(item => item.sequence_no), [1, 2]);
      assert.deepEqual(body.data[0].items[1].staff_assignments.map(row => row.role), ['primary', 'assistant']);
      assert.equal(body.data[0].checkout.payment_state, 'paid');
      assert.equal(body.data[0].checkout.reconciliation_valid, true);
      assert.equal(body.data[0].can_start_checkout, false);
    });
    assert.equal(connectCount, 1, 'one appointment projection query connection, no N+1 connection');
  } finally {
    if (originalGate === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
    else process.env.CHECKOUT_WRITE_ENABLED = originalGate;
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
