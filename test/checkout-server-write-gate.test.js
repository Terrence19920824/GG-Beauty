'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');

const APPOINTMENT_ID = '55555555-5555-4555-8555-555555555555';
const SESSION = {
  owner_account_id: '11111111-1111-4111-8111-111111111111',
  membership_id: '22222222-2222-4222-8222-222222222222',
  shop_id: '33333333-3333-4333-8333-333333333333',
  login_identifier: 'owner',
  display_name: 'Owner',
  role: 'owner',
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

const fixture = ({ role = 'owner' } = {}) => {
  const state = { authQueries: 0, connects: 0, businessQueries: [] };
  return {
    state,
    pool: {
      async query(sql) {
        if (!/FROM owner_sessions/.test(sql)) throw new Error(`Unexpected auth SQL: ${sql}`);
        state.authQueries += 1;
        return { rows: [{ ...SESSION, role }] };
      },
      async connect() {
        state.connects += 1;
        return {
          async query(sql) {
            state.businessQueries.push(sql);
            if (sql === 'BEGIN READ ONLY' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (/FROM appointments a/.test(sql)) return { rows: [{
              id: APPOINTMENT_ID,
              status: 'in_service',
              start_at: '2030-01-01T02:00:00Z',
              end_at: '2030-01-01T03:00:00Z',
              customer_name: 'Test Customer',
              customer_phone: '+6500000000',
              member_code: null
            }] };
            if (/FROM appointment_items i/.test(sql)) return { rows: [{
              id: '77777777-7777-4777-8777-777777777777',
              sequence_no: 1,
              service_name_snapshot: 'Test Service',
              quote_price_minor: '1000',
              staff_assignments: []
            }] };
            if (/FROM checkout_transactions/.test(sql)) return { rows: [] };
            throw new Error('normal checkout processing reached');
          },
          release() {}
        };
      }
    }
  };
};

const checkout = (base, { authenticated = true, body = {} } = {}) => fetch(
  `${base}/api/owner/appointments/${APPOINTMENT_ID}/checkout`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { cookie: 'gg_beauty_owner_session=local-token' } : {})
    },
    body: JSON.stringify(body)
  }
);

const checkoutRead = base => fetch(
  `${base}/api/owner/appointments/${APPOINTMENT_ID}/checkout-session`,
  { headers: { cookie: 'gg_beauty_owner_session=local-token' } }
);

test('unset, false, empty, and invalid checkout gate values fail closed before checkout DB access', async () => {
  const original = process.env.CHECKOUT_WRITE_ENABLED;
  try {
    for (const value of [undefined, 'false', '', 'TRUE', '1', ' true ']) {
      if (value === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
      else process.env.CHECKOUT_WRITE_ENABLED = value;
      const current = fixture();
      app.locals.ownerAuthPool = current.pool;
      await withServer(async base => {
        const response = await checkout(base);
        assert.equal(response.status, 503, `value ${JSON.stringify(value)}`);
        assert.deepEqual(await response.json(), { success: false, code: 'CHECKOUT_WRITE_DISABLED' });
      });
      assert.equal(current.state.authQueries, 1);
      assert.equal(current.state.connects, 0);
      assert.deepEqual(current.state.businessQueries, []);
    }
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
    else process.env.CHECKOUT_WRITE_ENABLED = original;
  }
});

test('authentication and role checks precede the checkout write gate', async () => {
  const original = process.env.CHECKOUT_WRITE_ENABLED;
  delete process.env.CHECKOUT_WRITE_ENABLED;
  try {
    const unauthenticated = fixture();
    app.locals.ownerAuthPool = unauthenticated.pool;
    await withServer(async base => {
      const response = await checkout(base, { authenticated: false });
      assert.equal(response.status, 401);
      assert.notEqual((await response.json()).code, 'CHECKOUT_WRITE_DISABLED');
    });
    assert.equal(unauthenticated.state.authQueries, 0);
    assert.equal(unauthenticated.state.connects, 0);

    const unauthorized = fixture({ role: 'admin' });
    app.locals.ownerAuthPool = unauthorized.pool;
    await withServer(async base => {
      const response = await checkout(base);
      assert.equal(response.status, 403);
      assert.notEqual((await response.json()).code, 'CHECKOUT_WRITE_DISABLED');
    });
    assert.equal(unauthorized.state.authQueries, 1);
    assert.equal(unauthorized.state.connects, 0);
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
    else process.env.CHECKOUT_WRITE_ENABLED = original;
  }
});

test("only exact 'true' enters the existing checkout handler", async () => {
  const original = process.env.CHECKOUT_WRITE_ENABLED;
  process.env.CHECKOUT_WRITE_ENABLED = 'true';
  try {
    const current = fixture();
    app.locals.ownerAuthPool = current.pool;
    await withServer(async base => {
      const response = await checkout(base, { body: {} });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'CHECKOUT_IDEMPOTENCY_KEY_INVALID');
    });
    assert.equal(current.state.authQueries, 1);
    assert.equal(current.state.connects, 0, 'existing request validation runs before a checkout DB connection');
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
    else process.env.CHECKOUT_WRITE_ENABLED = original;
  }
});

test('checkout read route remains available when writes are gated off', async () => {
  const original = process.env.CHECKOUT_WRITE_ENABLED;
  process.env.CHECKOUT_WRITE_ENABLED = 'false';
  try {
    const current = fixture();
    app.locals.ownerAuthPool = current.pool;
    await withServer(async base => {
      const response = await checkoutRead(base);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
    });
    assert.equal(current.state.connects, 1, 'read handler is reached instead of the write gate');
    assert.equal(current.state.businessQueries[0], 'BEGIN READ ONLY');
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_WRITE_ENABLED;
    else process.env.CHECKOUT_WRITE_ENABLED = original;
  }
});

test('every implemented checkout financial mutation route is protected', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mutationRoutes = [...serverSource.matchAll(/app\.(post|patch|put|delete)\(\s*['"]([^'"]*checkout[^'"]*)['"]([\s\S]*?)\n\);/gi)];
  assert.equal(mutationRoutes.length, 1);
  assert.equal(mutationRoutes[0][1].toLowerCase(), 'post');
  assert.equal(mutationRoutes[0][2], '/api/owner/appointments/:appointmentId/checkout');
  assert.match(mutationRoutes[0][3], /requireOwnerAuth[\s\S]*requireOwnerRole\(\['owner', 'manager'\]\)[\s\S]*requireCheckoutWriteEnabled[\s\S]*checkoutPos\.create/);
});
