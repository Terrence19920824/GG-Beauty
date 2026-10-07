'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCheckoutPos, isMinor, ABSTRACT_PAYMENT_METHODS, DB_PAYMENT_METHOD_MAP } = require('../lib/checkout-pos');
const root = path.join(__dirname, '..');
const sql = n => fs.readFileSync(path.join(root, 'migrations', n), 'utf8');
const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  appt: '22222222-2222-4222-8222-222222222222',
  customer: '33333333-3333-4333-8333-333333333333',
  item: '44444444-4444-4444-8444-444444444444',
  owner: '55555555-5555-4555-8555-555555555555',
  checkout: '66666666-6666-4666-8666-666666666666'
};

function fixture(status = 'in_service', currencyCode = 'SGD') {
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) {
        return { rows: [{ id: ID.appt, shop_id: ID.shop, status, customer_id: ID.customer, currency_code: currencyCode }] };
      }
      if (/FROM appointment_items i/.test(q)) {
        return { rows: [{ id: ID.item, sequence_no: 1, service_id: 's', service_name_snapshot: 'Service', quote_minor: '8800' }] };
      }
      if (/^INSERT INTO checkout_transactions/.test(q)) {
        return { rows: [{ id: ID.checkout, status: 'paid', final_due_minor: 8800, paid_minor: 8800 }] };
      }
      if (/^INSERT INTO checkout_(line_items|payments|financial_audit)/.test(q)) return { rows: [] };
      throw Error(q);
    },
    release() {}
  };
  return { calls, pool: { connect: async () => client } };
}

const request = (body = {}) => ({
  params: { appointmentId: ID.appt },
  body,
  ownerAuth: { shopId: ID.shop, ownerAccountId: ID.owner }
});

const response = () => {
  const r = {
    statusCode: 200,
    status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; return this; }
  };
  return r;
};

test('checkout migration chain is staged, tenant-safe and preserves future financial distinctions', () => {
  const pre = sql('047_checkout_pos_preflight_readonly.sql');
  const schema = sql('048_checkout_pos_schema.sql');
  const verify = sql('049_checkout_pos_verification_readonly.sql');
  const auditPre = sql('050_checkout_financial_audit_preflight_readonly.sql');
  const audit = sql('051_checkout_financial_audit_schema.sql');
  const auditVerify = sql('052_checkout_financial_audit_verification_readonly.sql');

  assert.doesNotMatch(pre, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(pre, /GROUP BY shop_id,id/);
  assert.match(schema, /appointment_items_shop_id_id_key UNIQUE \(shop_id,id\)/);
  assert.match(schema, /UNIQUE\(shop_id,appointment_id\)/);
  assert.match(schema, /FOREIGN KEY\(shop_id,appointment_id\)/);
  assert.match(schema, /cash_collected/);
  assert.match(schema, /stored_value_bonus/);
  assert.match(schema, /package_redemption/);
  assert.match(schema, /checkout_staff_attributions/);
  assert.doesNotMatch(verify, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.doesNotMatch(auditPre, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(audit, /checkout_financial_audit/);
  assert.match(audit, /immutable/);
  assert.doesNotMatch(auditVerify, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
});

test('minor units reject floats and checkout derives trusted appointment scope', async () => {
  assert.equal(isMinor(1000), true);
  assert.equal(isMinor(1.1), false);
  const f = fixture();
  const h = createCheckoutPos({ pool: f.pool }).create;
  const r = response();
  await h(request({ idempotencyKey: 'a'.repeat(16), paymentMethod: 'cash' }), r);
  assert.equal(r.statusCode, 201);
  assert.equal(f.calls.some(x => /shop_id=\$2/.test(x.q) && /FROM appointments/.test(x.q)), true);
  assert.equal(f.calls.some(x => /INSERT INTO checkout_financial_audit/.test(x.q)), true);
});

test('checkout rejects client-supplied items, payments, custom amounts and providerReference before writes', async () => {
  const forbiddenBodies = [
    { idempotencyKey: 'b'.repeat(16), paymentMethod: 'cash', items: [{ appointmentItemId: ID.item }] },
    { idempotencyKey: 'c'.repeat(16), paymentMethod: 'cash', payments: [{ method: 'cash' }] },
    { idempotencyKey: 'd'.repeat(16), paymentMethod: 'cash', actualPriceMinor: 8800 },
    { idempotencyKey: 'e'.repeat(16), paymentMethod: 'cash', discountMinor: 100 },
    { idempotencyKey: 'f'.repeat(16), paymentMethod: 'cash', amountMinor: 8800 },
    { idempotencyKey: 'g'.repeat(16), paymentMethod: 'cash', paidMinor: 8800 },
    { idempotencyKey: 'h'.repeat(16), paymentMethod: 'cash', cashCollectedMinor: 8800 },
    { idempotencyKey: 'i'.repeat(16), paymentMethod: 'cash', providerReference: 'forged' },
    { idempotencyKey: 'j'.repeat(16), paymentMethod: 'cash', provider_reference: 'forged' },
    { idempotencyKey: 'k'.repeat(16), paymentMethod: 'cash', currency: 'USD' },
    { idempotencyKey: 'l'.repeat(16), paymentMethod: 'cash', currencyCode: 'USD' },
    { idempotencyKey: 'm'.repeat(16), paymentMethod: 'cash', finalDueMinor: 8800 }
  ];

  for (const body of forbiddenBodies) {
    const f = fixture();
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request(body), r);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.code, 'CHECKOUT_CLIENT_MUTATION_FORBIDDEN');
    assert.equal(f.calls.some(x => /^INSERT INTO checkout_transactions/.test(x.q)), false);
  }
});

test('checkout rejects invalid body keys, missing or unrecognized paymentMethod', async () => {
  const invalidBodies = [
    { idempotencyKey: 'x'.repeat(16), paymentMethod: 'cash', unknownField: true },
    { idempotencyKey: 'x'.repeat(16), paymentMethod: 'unsupported_method' },
    { idempotencyKey: 'x'.repeat(16) },
    { idempotencyKey: 'x'.repeat(16), paymentMethod: 'bitcoin' },
    { idempotencyKey: 'short', paymentMethod: 'cash' }
  ];

  for (const body of invalidBodies) {
    const f = fixture();
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request(body), r);
    assert.equal(r.statusCode, 400);
    assert.ok(r.body.code.startsWith('CHECKOUT_'));
    assert.equal(f.calls.some(x => /^INSERT INTO checkout_transactions/.test(x.q)), false);
  }
});

test('checkout API server-side status guard allows arrived, in_service, completed and rejects pending, confirmed, cancelled, no_show, void', async () => {
  for (const legalStatus of ['arrived', 'in_service', 'completed']) {
    const f = fixture(legalStatus);
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request({
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      paymentMethod: 'cash'
    }), r);
    assert.equal(r.statusCode, 201, `Status ${legalStatus} must succeed`);
  }
  for (const illegalStatus of ['pending', 'confirmed', 'cancelled', 'no_show', 'void', 'unknown', '']) {
    const f = fixture(illegalStatus);
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request({
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      paymentMethod: 'cash'
    }), r);
    assert.equal(r.statusCode, 409, `Status ${illegalStatus} must fail closed`);
    assert.equal(r.body.code, 'CHECKOUT_APPOINTMENT_STATUS_INVALID');
    assert.equal(f.calls.some(x => /^INSERT INTO checkout_transactions/.test(x.q)), false);
  }
});

test('same appointment_id + same idempotency_key safely replays original checkout', async () => {
  const existingTx = {
    id: ID.checkout,
    appointment_id: ID.appt,
    status: 'paid',
    final_due_minor: 8800,
    paid_minor: 8800
  };
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status: 'in_service', customer_id: ID.customer }] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const r = response();
  await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
    idempotencyKey: 'k'.repeat(16),
    paymentMethod: 'cash'
  }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.idempotent, true);
  assert.equal(r.body.data.id, ID.checkout);
  assert.equal(r.body.data.final_due_minor, 8800);
  const apptQueryIdx = calls.findIndex(x => /FROM appointments a/.test(x.q));
  const txQueryIdx = calls.findIndex(x => /FROM checkout_transactions/.test(x.q));
  const commitIdx = calls.findIndex(x => x.q === 'COMMIT');
  assert.ok(apptQueryIdx !== -1, 'Appointment must be queried');
  assert.ok(txQueryIdx !== -1, 'Idempotency transaction must be queried');
  assert.ok(apptQueryIdx < txQueryIdx, 'Appointment must be validated BEFORE idempotency lookup');
  assert.ok(txQueryIdx < commitIdx, 'Transaction must be committed after validation');
});

test('different appointment_id + same idempotency_key must fail closed with 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
  const differentApptId = '99999999-9999-4999-8999-999999999999';
  const existingTx = {
    id: ID.checkout,
    appointment_id: differentApptId,
    status: 'paid',
    final_due_minor: 8800,
    paid_minor: 8800
  };
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status: 'in_service', customer_id: ID.customer }] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const r = response();
  await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
    idempotencyKey: 'k'.repeat(16),
    paymentMethod: 'cash'
  }), r);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(calls.some(x => x.q === 'ROLLBACK'), true);
  assert.equal(r.body.data, undefined);
});

test('duplicate checkout for same appointment under different idempotency key returns 409 CHECKOUT_ALREADY_EXISTS', async () => {
  const existingTx = {
    id: ID.checkout,
    appointment_id: ID.appt,
    status: 'paid',
    final_due_minor: 8800,
    paid_minor: 8800
  };
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status: 'in_service', customer_id: ID.customer }] };
      if (/idempotency_key = \$2/.test(q)) return { rows: [] }; // New key, not found in idempotency lookup
      if (/appointment_id = \$2/.test(q)) return { rows: [existingTx] }; // Appointment already checked out!
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const r = response();
  await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
    idempotencyKey: 'new_key_' + 'x'.repeat(16),
    paymentMethod: 'cash'
  }), r);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'CHECKOUT_ALREADY_EXISTS');
  assert.equal(calls.some(x => x.q === 'ROLLBACK'), true);
  assert.equal(calls.some(x => /^INSERT INTO checkout_transactions/.test(x.q)), false);
});

test('DB unique constraint violation on checkout_appointment_one maps to 409 CHECKOUT_ALREADY_EXISTS', async () => {
  const client = {
    async query(q) {
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status: 'in_service', customer_id: ID.customer }] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [] };
      if (/FROM appointment_items i/.test(q)) return { rows: [{ id: ID.item, sequence_no: 1, service_id: 's', service_name_snapshot: 'Service', quote_minor: '8800' }] };
      if (/^INSERT INTO checkout_transactions/.test(q)) {
        const err = new Error('duplicate key value violates unique constraint "checkout_appointment_one"');
        err.code = '23505';
        err.constraint = 'checkout_appointment_one';
        throw err;
      }
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const r = response();
  await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
    idempotencyKey: 'unique_race_' + 'x'.repeat(16),
    paymentMethod: 'cash'
  }), r);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'CHECKOUT_ALREADY_EXISTS');
});

test('authoritative currency is read from DB and not hardcoded to SGD', async () => {
  for (const curr of ['MYR', 'THB', 'IDR', 'PHP']) {
    const f = fixture('in_service', curr);
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request({
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      paymentMethod: 'card'
    }), r);
    assert.equal(r.statusCode, 201);
    const txInsert = f.calls.find(c => /^INSERT INTO checkout_transactions/.test(c.q));
    assert.ok(txInsert);
    assert.equal(txInsert.p[4], curr, `currency_code parameter must match authoritative DB currency (${curr})`);
  }
});

test('server-generated provider_reference is stored for all abstract payment methods', async () => {
  for (const method of ['cash', 'qr_payment', 'card', 'ewallet', 'bank_transfer', 'other']) {
    const f = fixture('in_service');
    const r = response();
    await createCheckoutPos({ pool: f.pool }).create(request({
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      paymentMethod: method
    }), r);
    assert.equal(r.statusCode, 201);
    const paymentInsert = f.calls.find(c => /^INSERT INTO checkout_payments/.test(c.q));
    assert.ok(paymentInsert);
    assert.equal(paymentInsert.p[2], DB_PAYMENT_METHOD_MAP[method]);
    assert.equal(paymentInsert.p[6], `method:${method}`, 'provider_reference must be generated by server');
  }
});

test('pending/confirmed/cancelled/no_show using existing idempotency_key must fail closed with 409 CHECKOUT_APPOINTMENT_STATUS_INVALID', async () => {
  for (const illegalStatus of ['pending', 'confirmed', 'cancelled', 'no_show', 'void']) {
    const existingTx = {
      id: ID.checkout,
      appointment_id: ID.appt,
      status: 'paid',
      final_due_minor: 8800,
      paid_minor: 8800
    };
    const calls = [];
    const client = {
      async query(q, p = []) {
        calls.push({ q, p });
        if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
        if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status: illegalStatus, customer_id: ID.customer }] };
        if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
        throw new Error(`Unexpected query: ${q}`);
      },
      release() {}
    };
    const r = response();
    await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
      idempotencyKey: 'k'.repeat(16),
      paymentMethod: 'cash'
    }), r);
    assert.equal(r.statusCode, 409, `Illegal status ${illegalStatus} with existing key must fail closed`);
    assert.equal(r.body.code, 'CHECKOUT_APPOINTMENT_STATUS_INVALID');
    assert.equal(r.body.success, false);
    assert.equal(calls.some(x => x.q === 'ROLLBACK'), true);
    assert.equal(calls.some(x => /FROM checkout_transactions/.test(x.q)), false);
  }
});

test('replay path validates appointment existence and tenant isolation before idempotency check', async () => {
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [{ id: ID.checkout, appointment_id: ID.appt }] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const r = response();
  await createCheckoutPos({ pool: { connect: async () => client } }).create(request({
    idempotencyKey: 'k'.repeat(16),
    paymentMethod: 'cash'
  }), r);
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.code, 'APPOINTMENT_NOT_FOUND');
  assert.equal(calls.some(x => /FROM checkout_transactions/.test(x.q)), false);
});
