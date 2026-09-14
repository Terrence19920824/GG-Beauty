'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111', membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333', shopB: '44444444-4444-4444-8444-444444444444',
  appointmentA: '55555555-5555-4555-8555-555555555555', appointmentB: '66666666-6666-4666-8666-666666666666'
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

function fixture({ existingCheckout = null } = {}) {
  const state = { queries: [], released: 0 };
  const session = {
    owner_account_id: ID.account, membership_id: ID.membership, shop_id: ID.shopA,
    login_identifier: 'owner', display_name: 'Owner', role: 'owner', shop_slug: 'shop-a', shop_name: 'Shop A'
  };
  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (/FROM appointments a/.test(sql)) {
        return { rows: params[0] === ID.appointmentA && params[1] === ID.shopA ? [{
          id: ID.appointmentA, status: 'in_service', start_at: '2030-01-01T02:00:00Z', end_at: '2030-01-01T04:00:00Z',
          customer_name: 'Checkout Customer', customer_phone: '+6581234567', member_code: 'GG-000012'
        }] : [] };
      }
      if (/FROM appointment_items i/.test(sql)) return { rows: [
        { id: '77777777-7777-4777-8777-777777777777', sequence_no: 1, service_name_snapshot: 'Facial', quote_price_minor: '9800', staff_assignments: [{ role: 'primary', staffId: 'staff-a', name: 'Alice' }] },
        { id: '88888888-8888-4888-8888-888888888888', sequence_no: 2, service_name_snapshot: 'Balayage', quote_price_minor: '23800', staff_assignments: [{ role: 'primary', staffId: 'staff-b', name: 'Bea' }, { role: 'assistant', staffId: 'staff-c', name: 'Chris' }] }
      ] };
      if (/FROM checkout_transactions/.test(sql)) return { rows: existingCheckout ? [existingCheckout] : [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { state.released += 1; }
  };
  return {
    state,
    pool: {
      async query(sql) { if (/FROM owner_sessions/.test(sql)) return { rows: [session] }; throw new Error(`Unexpected pool SQL: ${sql}`); },
      async connect() { return client; }
    }
  };
}

const get = (base, id, authenticated = true) => fetch(`${base}/api/owner/appointments/${id}/checkout-session`, {
  headers: authenticated ? { cookie: 'gg_beauty_owner_session=local-token' } : {}
});

test('checkout session read is owner-authenticated, tenant-safe and minimal', async () => {
  const unauth = fixture(); app.locals.ownerAuthPool = unauth.pool;
  await withServer(async base => assert.equal((await get(base, ID.appointmentA, false)).status, 401));
  assert.equal(unauth.state.queries.length, 0);

  const own = fixture(); app.locals.ownerAuthPool = own.pool;
  await withServer(async base => {
    const response = await get(base, ID.appointmentA);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.appointmentId, ID.appointmentA);
    assert.equal(data.currencyCode, 'SGD');
    assert.deepEqual(Object.keys(data.customer).sort(), ['memberCode', 'name', 'phone']);
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].quotePriceMinor, 9800);
    assert.equal(data.items[1].quotePriceMinor, 23800);
    assert.equal(data.items[0].primaryStaff.name, 'Alice');
    assert.deepEqual(data.items[1].assistantStaff, [{ id: 'staff-c', name: 'Chris' }]);
    assert.equal(data.checkout, null);
    assert.equal(data.checkoutLocked, false);
  });
  assert.equal(own.state.queries.every(entry => /^\s*SELECT/i.test(entry.sql)), true);
  assert.equal(own.state.queries.some(entry => entry.params.includes(ID.shopB)), false);

  const denied = fixture(); app.locals.ownerAuthPool = denied.pool;
  await withServer(async base => assert.equal((await get(base, ID.appointmentB)).status, 404));
  assert.equal(denied.state.queries.length, 1);

  const unknown = fixture(); app.locals.ownerAuthPool = unknown.pool;
  await withServer(async base => assert.equal((await get(base, '99999999-9999-4999-8999-999999999999')).status, 404));
});

test('checkout session read exposes paid state without permitting a new checkout', async () => {
  const paid = fixture({ existingCheckout: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'paid', currency_code: 'SGD',
    quote_total_minor: '33600', actual_total_minor: '33600', discount_total_minor: '0', final_due_minor: '33600', paid_minor: '33600'
  } });
  app.locals.ownerAuthPool = paid.pool;
  await withServer(async base => {
    const response = await get(base, ID.appointmentA);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.checkout.isPaid, true);
    assert.equal(data.checkoutLocked, true);
    assert.equal(data.checkout.finalDueMinor, 33600);
  });
});
