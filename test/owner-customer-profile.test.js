'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listCustomers, getCustomer, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, CUSTOMER_READ_ROLES } = require('../lib/owner-customer-profile');

const IDS = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '22222222-2222-4222-8222-222222222222',
  customerA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customerB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};

test('customer list is tenant-scoped, compact, server searched, and bounded', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: IDS.customerA, name: 'Alice', phone: '+6581111111', member_code: 'MEM-1', identity_status: 'verified_member', last_visit_at: '2026-09-01T01:00:00.000Z' }] };
  }};
  const data = await listCustomers(pool, { shopId: IDS.shopA, query: { page: '2', pageSize: '999', q: 'Ali%' } });
  assert.equal(data.pageSize, MAX_PAGE_SIZE);
  assert.equal(data.customers[0].email, undefined);
  assert.equal(calls[0].params[0], IDS.shopA);
  assert.equal(calls[0].params[1], '%Ali\\%%');
  assert.match(calls[0].sql, /a\.recipient_customer_id = c\.id/);
  assert.match(calls[0].sql, /a\.status IN \('completed','arrived','in_service'\)/);
  assert.doesNotMatch(calls[0].sql, /profile_notes/);
});

test('customer list defaults and never accepts a caller-selected shop', async () => {
  const pool = { query: async (_sql, params) => {
    assert.equal(params[0], IDS.shopA);
    assert.equal(params[2], DEFAULT_PAGE_SIZE);
    return { rows: [] };
  }};
  const data = await listCustomers(pool, { shopId: IDS.shopA, query: { shopId: IDS.shopB } });
  assert.equal(data.page, 1);
  assert.equal(data.customers.length, 0);
});

test('customer detail fails closed for invalid or cross-shop customer lookup', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [] }; } };
  assert.equal(await getCustomer(pool, { shopId: IDS.shopA, customerId: 'not-a-uuid' }), null);
  assert.equal(calls, 0);
  assert.equal(await getCustomer(pool, { shopId: IDS.shopA, customerId: IDS.customerB }), null);
  assert.equal(calls, 1);
});

test('customer detail visits use recipient-only tenant-scoped snapshots with a legacy fallback', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return { rows: [{ id: IDS.customerA, name: 'Alice', phone: '+6581111111', email: null, date_of_birth: null, member_code: 'MEM-1', identity_status: 'verified_member', phone_verified_at: null, gender: null, profile_notes: 'Careful' }] };
    return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', appointment_no: 'GG-1', start_at: '2026-09-01T01:00:00.000Z', end_at: '2026-09-01T02:00:00.000Z', status: 'completed', booking_source: 'online', items: [] }] };
  }};
  const data = await getCustomer(pool, { shopId: IDS.shopA, customerId: IDS.customerA });
  assert.equal(data.customer.profileNotes, 'Careful');
  assert.match(calls[0].sql, /id = \$1 AND shop_id = \$2/);
  assert.match(calls[1].sql, /a\.shop_id = \$1 AND a\.recipient_customer_id = \$2/);
  assert.match(calls[1].sql, /appointment_items i/);
  assert.match(calls[1].sql, /appointment_item_staff_assignments x/);
  assert.match(calls[1].sql, /'legacy', true/);
  assert.doesNotMatch(calls[1].sql, /booker_customer_id = \$2/);
});

test('Customer 360 role matrix is owner-side only and notes authority remains narrower', () => {
  assert.deepEqual(CUSTOMER_READ_ROLES, ['owner', 'manager', 'admin', 'front_desk']);
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /OWNER_CUSTOMER_PROFILE_NOTES_WRITE_ROLES = Object\.freeze\(\['owner', 'manager'\]\)/);
  assert.match(server, /requireOwnerRole\(CUSTOMER_READ_ROLES\)/);
  assert.doesNotMatch(server, /app\.get\('\/api\/staff\/customers/);
  assert.doesNotMatch(server, /app\.get\('\/api\/customer\/customers/);
});
