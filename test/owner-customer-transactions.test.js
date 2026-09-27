'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listCustomerTransactions, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../lib/owner-customer-transactions');
const { CUSTOMER_READ_ROLES } = require('../lib/owner-customer-profile');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111', shopB: '22222222-2222-4222-8222-222222222222',
  customerA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  checkout: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', appointment: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
};

const row = (status = 'paid', extra = {}) => ({
  transaction_id: ID.checkout, checkout_id: ID.checkout, created_at: '2026-09-27T01:00:00.000Z', appointment_id: ID.appointment, appointment_no: 'GG-1', checkout_status: status, currency_code: 'SGD',
  checkout_quote_total_minor: '12000', checkout_actual_total_minor: '12000', checkout_discount_total_minor: '2000', checkout_final_due_minor: '10000', checkout_recorded_paid_minor: status === 'void' ? '0' : '10000',
  line_item_count: '1', line_quote_total_minor: '12000', line_actual_total_minor: '12000', line_discount_total_minor: '2000', line_final_total_minor: '10000',
  payment_total_minor: status === 'void' ? '0' : '10000', refund_total_minor: '0', refund_audit_count: '0', void_audit_count: status === 'void' ? '1' : '0',
  line_items: [{ description: '<img src=x>', finalValueMinor: 10000 }], payments: [{ method: 'card', valueKind: 'cash_collected', amountMinor: 10000 }], staff_attributions: [], ...extra
});

const fixture = ({ customer = true, rows = [row()] } = {}) => {
  const calls = [];
  return { calls, pool: { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM customers')) return { rows: customer ? [{ id: ID.customerA }] : [] };
    return { rows };
  }}};
};

test('customer transactions validates same-shop ownership before tenant-scoped aggregate read', async () => {
  const f = fixture();
  const data = await listCustomerTransactions(f.pool, { shopId: ID.shopA, customerId: ID.customerA, query: {} });
  assert.equal(data.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(data.transactions[0].paymentState, 'paid');
  assert.equal(data.transactions[0].reconciliationValid, true);
  assert.equal(f.calls[0].params[0], ID.customerA);
  assert.equal(f.calls[0].params[1], ID.shopA);
  assert.equal(f.calls[1].params[0], ID.shopA);
  assert.equal(f.calls[1].params[1], ID.customerA);
  assert.match(f.calls[1].sql, /checkout\.shop_id=\$1 AND checkout\.customer_id=\$2/);
  assert.match(f.calls[1].sql, /appointment\.shop_id=checkout\.shop_id/);
  assert.match(f.calls[1].sql, /ORDER BY checkout\.created_at DESC,checkout\.id DESC/);
});

test('unknown, cross-shop, and invalid customer IDs fail identically without transaction query', async () => {
  const unknown = fixture({ customer: false });
  assert.equal(await listCustomerTransactions(unknown.pool, { shopId: ID.shopA, customerId: ID.customerB, query: {} }), null);
  assert.equal(unknown.calls.length, 1);
  const invalid = fixture();
  assert.equal(await listCustomerTransactions(invalid.pool, { shopId: ID.shopA, customerId: 'bad', query: {} }), null);
  assert.equal(invalid.calls.length, 0);
});

test('transaction pagination is bounded and requests one extra row for deterministic hasMore', async () => {
  const f = fixture({ rows: [row(), row('paid', { transaction_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })] });
  const data = await listCustomerTransactions(f.pool, { shopId: ID.shopA, customerId: ID.customerA, query: { page: '2', pageSize: '999' } });
  assert.equal(data.page, 2); assert.equal(data.pageSize, MAX_PAGE_SIZE);
  assert.equal(f.calls[1].params[2], MAX_PAGE_SIZE + 1);
  assert.equal(f.calls[1].params[3], MAX_PAGE_SIZE);
});

test('draft, void, partial refund, full refund, and invalid reconciliation use shared fail-closed semantics', async () => {
  const states = [
    ['draft', row('draft', { checkout_recorded_paid_minor: '0', payment_total_minor: '0', checkout_final_due_minor: '10000', line_final_total_minor: '10000' }), 'unpaid', true],
    ['void', row('void'), 'void', true],
    ['partial', row('partially_refunded', { refund_total_minor: '4000', refund_audit_count: '1' }), 'partially_refunded', true],
    ['full', row('refunded', { refund_total_minor: '10000', refund_audit_count: '1' }), 'refunded', true],
    ['invalid', row('paid', { refund_total_minor: '1' }), 'inconsistent', false]
  ];
  for (const [, source, paymentState, valid] of states) {
    const f = fixture({ rows: [source] });
    const data = await listCustomerTransactions(f.pool, { shopId: ID.shopA, customerId: ID.customerA, query: {} });
    assert.equal(data.transactions[0].paymentState, paymentState);
    assert.equal(data.transactions[0].reconciliationValid, valid);
  }
});

test('route uses owner Customer 360 roles and UI preserves escaped server data without client-side state derivation', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-self-service.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared-i18n.js'), 'utf8');
  assert.match(server, /\/api\/owner\/customers\/:customerId\/transactions/);
  assert.match(server, /requireOwnerRole\(CUSTOMER_READ_ROLES\)/);
  assert.match(server, /code: 'CUSTOMER_NOT_FOUND'/);
  assert.deepEqual(CUSTOMER_READ_ROLES, ['owner', 'manager', 'admin', 'front_desk']);
  assert.equal(CUSTOMER_READ_ROLES.includes('staff'), false);
  assert.doesNotMatch(server, /api\/staff\/customers\/:customerId\/transactions/);
  assert.doesNotMatch(server, /api\/customer\/customers\/:customerId\/transactions/);
  assert.match(ui, /escapeHtml\(item\.description/);
  assert.match(ui, /transaction\.paymentState/);
  assert.doesNotMatch(ui, /appointment\.status.*paid/i);
  assert.match(i18n, /customerTransactions: '交易记录'/);
  assert.match(i18n, /customerTransactions: 'Transactions'/);
});
