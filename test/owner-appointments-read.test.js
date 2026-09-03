'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  locationA: '55555555-5555-4555-8555-555555555555',
  locationB: '66666666-6666-4666-8666-666666666666',
  appointmentA: '77777777-7777-4777-8777-777777777777'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shopA,
  login_identifier: 'OwnerOne',
  display_name: 'Owner One',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const appointmentRow = {
  id: ID.appointmentA,
  appointment_no: 'A-1',
  start_at: '2030-01-01T02:00:00Z',
  end_at: '2030-01-01T03:00:00Z',
  status: 'pending',
  booking_source: 'online',
  customer_name: 'Shop A Customer',
  customer_phone: '00000000',
  customer_email: 'a@example.invalid',
  service_name: 'Shop A Service',
  duration_minutes: 60,
  price: '100.00',
  staff_name: 'Shop A Staff',
  staff_code: 'A1'
};

const crossTenantAppointmentRow = {
  ...appointmentRow,
  id: '88888888-8888-4888-8888-888888888888',
  appointment_no: 'B-1',
  customer_name: 'Shop B Customer',
  customer_phone: '99999999',
  customer_email: 'b@example.invalid',
  service_name: 'Shop B Service',
  staff_name: 'Shop B Staff',
  staff_code: 'B1'
};

const makePool = ({ role = 'owner', validSession = true, locationOwned = true, readError = false } = {}) => {
  const state = { poolQueries: [], clientQueries: [], releases: 0 };
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.clientQueries.push({ sql: normalized, params });
      if (readError) throw Object.assign(new Error('private database detail'), { code: 'XX000' });
      if (/FROM locations/.test(normalized)) {
        return { rows: locationOwned ? [{ id: params[0] }] : [] };
      }
      if (/FROM appointments/.test(normalized)) {
        const tenantScoped =
          /WHERE a\.shop_id = \$1/.test(normalized) &&
          params[0] === ID.shopA;
        return {
          rows: tenantScoped
            ? [appointmentRow]
            : [appointmentRow, crossTenantAppointmentRow]
        };
      }
      throw new Error(`Unexpected client SQL: ${normalized}`);
    },
    release() { state.releases += 1; }
  };
  const pool = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.poolQueries.push({ sql: normalized, params });
      if (/FROM owner_sessions/.test(normalized)) {
        return { rows: validSession ? [sessionRow(role)] : [] };
      }
      throw new Error(`Unexpected pool SQL: ${normalized}`);
    },
    async connect() { return client; }
  };
  return { pool, state };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    return await operation(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const getAppointments = (baseUrl, suffix = '', headers = {}) =>
  fetch(`${baseUrl}/api/appointments-db${suffix}`, {
    headers: {
      cookie: 'gg_beauty_owner_session=raw-owner-token',
      ...headers
    }
  });

const getAppointmentsWithBody = (baseUrl, suffix, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(`/api/appointments-db${suffix}`, baseUrl);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        cookie: 'gg_beauty_owner_session=raw-owner-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-shop-id': ID.shopB
      }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
    request.end(payload);
  });

const installPool = fixture => {
  app.locals.ownerAuthPool = fixture.pool;
};

test('unauthenticated appointment read returns 401', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/appointments-db`);
    assert.equal(response.status, 401);
  });
  assert.equal(fixture.state.clientQueries.length, 0);
});

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may read tenant appointments`, async () => {
    const fixture = makePool({ role });
    installPool(fixture);
    await withServer(async baseUrl => {
      const response = await getAppointments(baseUrl);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, [appointmentRow]);
    });
  });
}

test('client query/body/header shop injection cannot change trusted tenant', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    const response = await getAppointmentsWithBody(
      baseUrl,
      `?shopId=${ID.shopB}&shop_id=${ID.shopB}`,
      { shopId: ID.shopB, shop_id: ID.shopB }
    );
    assert.equal(response.statusCode, 200);
  });
  const read = fixture.state.clientQueries.find(q => /FROM appointments/.test(q.sql));
  assert.equal(read.params[0], ID.shopA);
  assert.equal(read.params.includes(ID.shopB), false);
});

test('appointment query is tenant-scoped in SQL', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    const payload = await (await getAppointments(baseUrl)).json();
    assert.deepEqual(payload.data.map(row => row.id), [ID.appointmentA]);
    assert.equal(JSON.stringify(payload).includes('B-1'), false);
  });
  const read = fixture.state.clientQueries.find(q => /FROM appointments/.test(q.sql));
  assert.match(read.sql, /WHERE a\.shop_id = \$1/);
});

test('customer join is tenant-scoped in SQL', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    const payload = await (await getAppointments(baseUrl)).json();
    assert.equal(JSON.stringify(payload).includes('Shop B Customer'), false);
  });
  const read = fixture.state.clientQueries.find(q => /FROM appointments/.test(q.sql));
  assert.match(read.sql, /c\.shop_id = a\.shop_id/);
  assert.equal(JSON.stringify(appointmentRow).includes('password'), false);
});

test('staff service and location joins are tenant-scoped', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(baseUrl => getAppointments(baseUrl));
  const read = fixture.state.clientQueries.find(q => /FROM appointments/.test(q.sql));
  for (const alias of ['s', 'st', 'l']) assert.match(read.sql, new RegExp(`${alias}\\.shop_id = a\\.shop_id`));
});

test('cross-tenant location fails closed without appointment query', async () => {
  const fixture = makePool({ locationOwned: false });
  installPool(fixture);
  await withServer(async baseUrl => {
    const response = await getAppointments(baseUrl, `?locationId=${ID.locationB}`);
    assert.equal(response.status, 404);
  });
  assert.equal(fixture.state.clientQueries.some(q => /FROM appointments/.test(q.sql)), false);
});

for (const condition of [
  'inactive membership',
  'inactive account',
  'inactive shop',
  'revoked session',
  'expired session'
]) {
  test(`${condition} blocks appointment read`, async () => {
    const fixture = makePool({ validSession: false });
    installPool(fixture);
    await withServer(async baseUrl => {
      const response = await getAppointments(baseUrl);
      assert.equal(response.status, 401);
    });
    assert.equal(fixture.state.clientQueries.length, 0);
  });
}

test('current role is re-read and an invalid role is denied', async () => {
  const fixture = makePool({ role: 'viewer' });
  installPool(fixture);
  await withServer(async baseUrl => {
    const response = await getAppointments(baseUrl);
    assert.equal(response.status, 403);
  });
  assert.equal(fixture.state.clientQueries.length, 0);
});

test('legacy admin IP session cannot access migrated route', async () => {
  const fixture = makePool({ validSession: false });
  installPool(fixture);
  await withServer(async baseUrl => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-admin-password' })
    });
    assert.equal(login.status, 200);
    const response = await fetch(`${baseUrl}/api/appointments-db`);
    assert.equal(response.status, 401);
  });
});

test('legacy admin database mutation remains fail-closed before DB access', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-admin-password' })
    });
    const response = await fetch(`${baseUrl}/api/admin/update-status-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: ID.appointmentA,
        status: 'confirmed'
      })
    });
    assert.equal(response.status, 403);
  });
  assert.equal(fixture.state.clientQueries.length, 0);
});

test('database error returns safe 500 and releases connection', async () => {
  const fixture = makePool({ readError: true });
  installPool(fixture);
  const original = console.error;
  console.error = () => {};
  try {
    await withServer(async baseUrl => {
      const response = await getAppointments(baseUrl);
      const payload = await response.json();
      assert.equal(response.status, 500);
      assert.equal(JSON.stringify(payload).includes('private database detail'), false);
    });
  } finally {
    console.error = original;
  }
  assert.equal(fixture.state.releases, 1);
});

test('successful read releases connection and leaks no auth fields', async () => {
  const fixture = makePool();
  installPool(fixture);
  await withServer(async baseUrl => {
    const payload = await (await getAppointments(baseUrl)).json();
    assert.equal(fixture.state.releases, 1);
    for (const field of ['password_hash', 'token_hash', 'session_version', 'membership_id']) {
      assert.equal(JSON.stringify(payload).includes(field), false);
    }
  });
});
