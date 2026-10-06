'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shop: '33333333-3333-4333-8333-333333333333',
  otherShop: '44444444-4444-4444-8444-444444444444',
  location: '55555555-5555-4555-8555-555555555555',
  otherLocation: '66666666-6666-4666-8666-666666666666',
  workingStaff: '77777777-7777-4777-8777-111111111111',
  inactiveStaff: '77777777-7777-4777-8777-222222222222',
  unbookableStaff: '77777777-7777-4777-8777-333333333333'
};

const makePool = ({ role = 'front_desk' } = {}) => {
  const state = { connects: 0, loaderQueries: [] };
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.loaderQueries.push({ sql: normalized, params });
      if (/^SELECT id, timezone FROM locations/i.test(normalized)) {
        assert.equal(params[1], ID.shop, 'tenant comes from authenticated session');
        if (params[0] !== ID.location) return { rows: [] };
        return { rows: [{ id: ID.location, timezone: 'Asia/Singapore' }] };
      }
      if (/^SELECT staff\.id AS staff_id/i.test(normalized)) {
        assert.match(normalized, /staff\.is_active = TRUE/);
        assert.match(normalized, /staff\.bookable = TRUE/);
        assert.match(normalized, /assignment\.location_id = \$2::UUID/);
        return { rows: [
          { staff_id: ID.workingStaff, name: 'Working', is_active: true, bookable: true },
          { staff_id: ID.inactiveStaff, name: 'Inactive', is_active: false, bookable: true },
          { staff_id: ID.unbookableStaff, name: 'Not bookable', is_active: true, bookable: false }
        ] };
      }
      if (/^SELECT staff_id, day_of_week/i.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.equal(params[1], ID.location);
        return { rows: [
          { staff_id: ID.workingStaff, day_of_week: 1, start_time: '10:00:00', end_time: '12:00:00', effective_from: null, effective_to: null, is_active: true },
          { staff_id: ID.inactiveStaff, day_of_week: 1, start_time: '10:00:00', end_time: '12:00:00', effective_from: null, effective_to: null, is_active: true },
          { staff_id: ID.unbookableStaff, day_of_week: 1, start_time: '10:00:00', end_time: '12:00:00', effective_from: null, effective_to: null, is_active: true }
        ] };
      }
      if (/^SELECT id, staff_id, schedule_date::TEXT/i.test(normalized)) return { rows: [] };
      throw new Error(`Unexpected loader query: ${normalized}`);
    },
    release() {}
  };
  const pool = {
    async query(sql) {
      if (/FROM owner_sessions/i.test(sql)) {
        return { rows: [{
          owner_account_id: ID.account,
          membership_id: ID.membership,
          shop_id: ID.shop,
          login_identifier: 'frontdesk',
          display_name: 'Front Desk',
          role,
          shop_slug: 'shop-a',
          shop_name: 'Shop A'
        }] };
      }
      throw new Error('Unexpected auth query');
    },
    async connect() {
      state.connects += 1;
      return client;
    }
  };
  return { pool, state };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const get = (base, query) => fetch(`${base}/api/owner/calendar-staff-availability?${query}`, {
  headers: { cookie: 'gg_beauty_owner_session=test-owner-token' }
});

test('calendar staff API is front_desk-readable, tenant/location scoped, and filters inactive/bookable=false', async () => {
  const fixture = makePool();
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async base => {
    const response = await get(base, `locationId=${ID.location}&date=2030-01-07`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.locationId, ID.location);
    assert.deepEqual(payload.data.businessWindows, [{ start: '10:00', end: '21:00' }]);
    assert.equal(payload.data.businessHoursSource, 'fallback');
    assert.deepEqual(payload.data.staff, [{
      id: ID.workingStaff,
      name: 'Working',
      status: 'working',
      workingWindows: [{ start: '10:00', end: '12:00' }],
      reason: 'WEEKLY_HOURS',
      source: 'weekly+fallback'
    }]);
  });
});

test('calendar staff API clips working hours extending outside fallback business hours (09:00-12:00 -> 10:00-12:00)', async () => {
  const fixture = makePool();
  // Override client query for working hours to return 09:00-12:00
  const originalConnect = fixture.pool.connect.bind(fixture.pool);
  fixture.pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT staff_id, day_of_week/i.test(normalized)) {
        return { rows: [
          { staff_id: ID.workingStaff, day_of_week: 1, start_time: '09:00:00', end_time: '12:00:00', effective_from: null, effective_to: null, is_active: true }
        ] };
      }
      return originalQuery(sql, params);
    };
    return client;
  };
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async base => {
    const response = await get(base, `locationId=${ID.location}&date=2030-01-07`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.businessWindows, [{ start: '10:00', end: '21:00' }]);
    assert.equal(payload.data.businessHoursSource, 'fallback');
    assert.deepEqual(payload.data.staff, [{
      id: ID.workingStaff,
      name: 'Working',
      status: 'working',
      workingWindows: [{ start: '10:00', end: '12:00' }],
      reason: 'WEEKLY_HOURS',
      source: 'weekly+fallback'
    }]);
  });
});

test('calendar staff API clips working hours extending past 21:00 (20:00-22:00 -> 20:00-21:00)', async () => {
  const fixture = makePool();
  const originalConnect = fixture.pool.connect.bind(fixture.pool);
  fixture.pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT staff_id, day_of_week/i.test(normalized)) {
        return { rows: [
          { staff_id: ID.workingStaff, day_of_week: 1, start_time: '20:00:00', end_time: '22:00:00', effective_from: null, effective_to: null, is_active: true }
        ] };
      }
      return originalQuery(sql, params);
    };
    return client;
  };
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async base => {
    const response = await get(base, `locationId=${ID.location}&date=2030-01-07`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.businessWindows, [{ start: '10:00', end: '21:00' }]);
    assert.equal(payload.data.businessHoursSource, 'fallback');
    assert.deepEqual(payload.data.staff, [{
      id: ID.workingStaff,
      name: 'Working',
      status: 'working',
      workingWindows: [{ start: '20:00', end: '21:00' }],
      reason: 'WEEKLY_HOURS',
      source: 'weekly+fallback'
    }]);
  });
});

test('calendar staff API rejects a location outside the authenticated tenant', async () => {
  const fixture = makePool();
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async base => {
    const response = await get(base, `locationId=${ID.otherLocation}&date=2030-01-07`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'LOCATION_NOT_FOUND');
  });
});

test('calendar staff API never accepts a client-supplied shopId', async () => {
  const fixture = makePool();
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async base => {
    const response = await get(base, `locationId=${ID.location}&date=2030-01-07&shopId=${ID.otherShop}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'CLIENT_SHOP_ID_NOT_ALLOWED');
    assert.equal(fixture.state.connects, 0);
  });
});

test('calendar API route and appointment query keep front desk and location isolation wired', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(source, /calendar-staff-availability[\s\S]*requireOwnerRole\(\['owner', 'manager', 'admin', 'front_desk'\]\)/);
  assert.match(adminSource, /fetch\(`\/api\/appointments-db\$\{locationQuery\}`/);
});
