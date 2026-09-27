'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { listCustomerTransactions } = require('../lib/owner-customer-transactions');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const sql = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');
const ID = {
  shopA: '11111111-1111-4111-8111-111111111111', shopB: '22222222-2222-4222-8222-222222222222',
  customerA: '33333333-3333-4333-8333-111111111111', customerB: '33333333-3333-4333-8333-222222222222',
  customerOther: '33333333-3333-4333-8333-333333333333', staffA: '44444444-4444-4444-8444-111111111111'
};
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

async function connect(url) {
  let last;
  for (let i = 0; i < 50; i += 1) {
    const db = new Client({ connectionString: url });
    try { await db.connect(); return db; } catch (error) { last = error; await db.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw last;
}

async function insertTransaction(db, n, options = {}) {
  const shopId = options.shopId || ID.shopA;
  const customerId = options.customerId || ID.customerA;
  const appointmentId = uuid(n * 10 + 1), itemId = uuid(n * 10 + 2), checkoutId = uuid(n * 10 + 3), lineId = uuid(n * 10 + 4);
  const status = options.status || 'paid';
  const paid = status === 'void' || status === 'draft' ? 0 : 10000;
  await db.query(`INSERT INTO appointments(id,shop_id,customer_id,recipient_customer_id,booker_customer_id,appointment_no,status) VALUES($1,$2,$3,$3,$4,$5,'completed')`, [appointmentId, shopId, customerId, options.bookerId || ID.customerB, `GG-${n}`]);
  await db.query(`INSERT INTO appointment_items(id,shop_id,appointment_id) VALUES($1,$2,$3)`, [itemId, shopId, appointmentId]);
  await db.query(`INSERT INTO checkout_transactions(id,shop_id,appointment_id,customer_id,status,currency_code,quote_total_minor,actual_total_minor,discount_total_minor,final_due_minor,paid_minor,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,'SGD',12000,12000,2000,10000,$6,$7,$8)`, [checkoutId, shopId, appointmentId, customerId, status, paid, `key-${n}-abcdefghijklmnop`, options.createdAt || `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`]);
  if (!options.noChildren) {
    await db.query(`INSERT INTO checkout_line_items(id,shop_id,checkout_id,appointment_item_id,line_type,description_snapshot,quote_price_minor,actual_price_minor,discount_minor,final_value_minor) VALUES($1,$2,$3,$4,'service',$5,12000,12000,2000,10000)`, [lineId, shopId, checkoutId, itemId, options.description || 'Service']);
    if (paid) await db.query(`INSERT INTO checkout_payments(shop_id,checkout_id,payment_method,value_kind,amount_minor) VALUES($1,$2,'card','cash_collected',10000)`, [shopId, checkoutId]);
    if (options.refund) await db.query(`INSERT INTO checkout_payments(shop_id,checkout_id,payment_method,value_kind,amount_minor) VALUES($1,$2,'other','refund',$3)`, [shopId, checkoutId, options.refund]);
    if (options.refund) await db.query(`INSERT INTO checkout_financial_audit(shop_id,checkout_id,appointment_id,event_type,after_snapshot,operator_type,source) VALUES($1,$2,$3,'refund','{}','owner','test')`, [shopId, checkoutId, appointmentId]);
    if (status === 'void') await db.query(`INSERT INTO checkout_financial_audit(shop_id,checkout_id,appointment_id,event_type,after_snapshot,operator_type,source) VALUES($1,$2,$3,'void','{}','owner','test')`, [shopId, checkoutId, appointmentId]);
    if (options.attribution) await db.query(`INSERT INTO checkout_staff_attributions(shop_id,checkout_line_item_id,staff_id,attribution_role,attribution_minor) VALUES($1,$2,$3,'primary',10000)`, [shopId, lineId, ID.staffA]);
  }
  return checkoutId;
}

test('Customer Transactions executes real PostgreSQL aggregation, tenant filtering, reconciliation, and migration chain', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-customer-transactions-'));
  const data = path.join(temp, 'data'); const port = 58600 + Math.floor(Math.random() * 100);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  let db;
  try {
    db = await connect(`postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`);
    await db.query(`CREATE EXTENSION pgcrypto; CREATE TABLE shops(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY,shop_id uuid NOT NULL,UNIQUE(shop_id,id)); CREATE TABLE staff(id uuid PRIMARY KEY,shop_id uuid NOT NULL,name text NOT NULL,UNIQUE(shop_id,id)); CREATE TABLE appointments(id uuid PRIMARY KEY,shop_id uuid NOT NULL,customer_id uuid NOT NULL,recipient_customer_id uuid NOT NULL,booker_customer_id uuid NOT NULL,appointment_no text,status text,UNIQUE(shop_id,id)); CREATE TABLE appointment_items(id uuid PRIMARY KEY,shop_id uuid NOT NULL,appointment_id uuid NOT NULL);`);
    await db.query(`INSERT INTO shops VALUES($1),($2); INSERT INTO customers VALUES($3,$1),($4,$1),($5,$2); INSERT INTO staff VALUES($6,$1,'Staff A')`, [ID.shopA, ID.shopB, ID.customerA, ID.customerB, ID.customerOther, ID.staffA]);
    await db.query(sql('048_checkout_pos_schema.sql')); await db.query(sql('051_checkout_financial_audit_schema.sql'));
    await db.query(sql('075_customer_transactions_index_preflight_readonly.sql')); await db.query(sql('076_customer_transactions_index_schema.sql')); await db.query(sql('077_customer_transactions_index_verification_readonly.sql'));
    const definition = (await db.query(`SELECT pg_get_indexdef('checkout_transactions_shop_customer_created_id_idx'::regclass) AS definition`)).rows[0].definition;
    assert.match(definition, /\(shop_id, customer_id, created_at DESC, id DESC\)/);
    const paid = await insertTransaction(db, 1, { attribution: true });
    await insertTransaction(db, 2, { status: 'draft' }); await insertTransaction(db, 3, { status: 'partially_refunded', refund: 4000 }); await insertTransaction(db, 4, { status: 'refunded', refund: 10000 }); await insertTransaction(db, 5, { status: 'void' }); await insertTransaction(db, 6, { refund: 1 }); await insertTransaction(db, 7, { noChildren: true });
    await insertTransaction(db, 8, { shopId: ID.shopB, customerId: ID.customerOther });
    const all = await listCustomerTransactions(db, { shopId: ID.shopA, customerId: ID.customerA, query: { pageSize: 100 } });
    const paidTransaction = all.transactions.find(transaction => transaction.id === paid);
    assert.equal(Boolean(paidTransaction), true);
    assert.equal(paidTransaction.lineItems.length, 1);
    assert.equal(paidTransaction.payments[0].method, 'card');
    assert.equal(paidTransaction.staffAttributions.length, 1);
    assert.equal(all.transactions.find(transaction => transaction.checkoutStatus === 'draft').paymentState, 'unpaid');
    const partial = all.transactions.find(transaction => transaction.checkoutStatus === 'partially_refunded');
    const refunded = all.transactions.find(transaction => transaction.checkoutStatus === 'refunded');
    assert.equal(partial.paymentState, 'partially_refunded'); assert.equal(partial.refundTotalMinor, 4000);
    assert.equal(refunded.paymentState, 'refunded'); assert.equal(refunded.refundTotalMinor, 10000);
    assert.equal(all.transactions.find(transaction => transaction.checkoutStatus === 'void').paymentState, 'void');
    assert.equal(all.transactions.filter(transaction => transaction.paymentState === 'inconsistent').length >= 2, true);
    assert.equal(all.transactions.some(transaction => transaction.appointmentNo === 'GG-8'), false);
    const bookerOnly = await listCustomerTransactions(db, { shopId: ID.shopA, customerId: ID.customerB, query: {} });
    assert.deepEqual(bookerOnly.transactions, []);
    assert.equal(await listCustomerTransactions(db, { shopId: ID.shopA, customerId: ID.customerOther, query: {} }), null);
    const first = await listCustomerTransactions(db, { shopId: ID.shopA, customerId: ID.customerA, query: { page: 1, pageSize: 2 } }); const second = await listCustomerTransactions(db, { shopId: ID.shopA, customerId: ID.customerA, query: { page: 2, pageSize: 2 } });
    assert.equal(first.hasMore, true); assert.equal(first.transactions.length, 2); assert.equal(second.transactions.length, 2);
    assert.equal(first.transactions[0].createdAt >= first.transactions[1].createdAt, true);
    await db.query(sql('rollback/076_customer_transactions_index_rollback.sql'));
    assert.equal((await db.query(`SELECT to_regclass('public.checkout_transactions_shop_customer_created_id_idx') AS index`)).rows[0].index, null);
    assert.equal((await db.query(`SELECT to_regclass('public.checkout_transactions_appointment_idx') AS index`)).rows[0].index, 'checkout_transactions_appointment_idx');
    assert.equal((await db.query('SELECT count(*) FROM checkout_transactions')).rows[0].count, '8');
  } finally { if (db) await db.end().catch(() => {}); postgres.kill('SIGTERM'); await new Promise(resolve => postgres.once('exit', resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
});
