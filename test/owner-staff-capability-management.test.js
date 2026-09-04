'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  staffA: '55555555-5555-4555-8555-555555555555',
  staffB: '66666666-6666-4666-8666-666666666666',
  serviceA: '77777777-7777-4777-8777-777777777777',
  serviceA2: '88888888-8888-4888-8888-888888888888',
  serviceB: '99999999-9999-4999-8999-999999999999',
  serviceInactive: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  serviceUnbookable: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shopA,
  login_identifier: 'owner-a',
  display_name: 'Owner A',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const makePool = ({
  role = 'owner',
  validSession = true,
  futureStatus = null,
  futureRole = 'primary',
  dbError = false,
  deactivateMismatch = false,
  upsertMismatch = false,
  staffBookable = false
} = {}) => {
  const state = {
    staff: {
      [ID.staffA]: { id: ID.staffA, shop_id: ID.shopA, bookable: staffBookable },
      [ID.staffB]: { id: ID.staffB, shop_id: ID.shopB, bookable: true }
    },
    services: {
      [ID.serviceA]: { id: ID.serviceA, shop_id: ID.shopA, name: 'Cut', category: 'Hair', is_active: true, bookable: true, sort_order: 1 },
      [ID.serviceA2]: { id: ID.serviceA2, shop_id: ID.shopA, name: 'Colour', category: 'Hair', is_active: true, bookable: true, sort_order: 2 },
      [ID.serviceB]: { id: ID.serviceB, shop_id: ID.shopB, name: 'Other Shop', category: null, is_active: true, bookable: true, sort_order: 1 },
      [ID.serviceInactive]: { id: ID.serviceInactive, shop_id: ID.shopA, name: 'Inactive', category: null, is_active: false, bookable: false, sort_order: 3 },
      [ID.serviceUnbookable]: { id: ID.serviceUnbookable, shop_id: ID.shopA, name: 'Not online', category: null, is_active: true, bookable: false, sort_order: 4 }
    },
    mappings: [
      { id: 'map-a', shop_id: ID.shopA, staff_id: ID.staffA, service_id: ID.serviceA, is_active: true },
      { id: 'map-a2', shop_id: ID.shopA, staff_id: ID.staffA, service_id: ID.serviceA2, is_active: false }
    ],
    queries: [], releases: 0, committed: false, rolledBack: false,
    snapshot: null, appointmentWrites: 0
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });
      if (normalized === 'BEGIN') {
        state.snapshot = structuredClone(state.mappings);
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        state.mappings = state.snapshot;
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/^SET LOCAL lock_timeout/.test(normalized)) return { rows: [] };
      if (dbError) throw Object.assign(new Error('private SQL detail'), { code: 'XX000' });
      if (/^(UPDATE|INSERT|DELETE).*appointment/im.test(normalized)) state.appointmentWrites += 1;

      if (/^SELECT id\s+FROM staff/.test(normalized)) {
        const row = state.staff[params[0]];
        return { rows: row && row.shop_id === params[1] ? [{ id: row.id }] : [] };
      }
      if (/^SELECT[\s\S]+FROM services AS service/.test(normalized)) {
        return {
          rows: Object.values(state.services)
            .filter(service => service.shop_id === params[0])
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(service => ({
              service_id: service.id,
              name: service.name,
              category: service.category,
              is_active: service.is_active,
              bookable: service.bookable,
              assigned: Boolean(state.mappings.find(mapping =>
                mapping.shop_id === params[0] &&
                mapping.staff_id === params[1] &&
                mapping.service_id === service.id &&
                mapping.is_active
              ))
            }))
        };
      }
      if (/^SELECT service_id, is_active\s+FROM staff_services/.test(normalized)) {
        return { rows: state.mappings.filter(mapping =>
          mapping.shop_id === params[0] && mapping.staff_id === params[1]
        ).map(mapping => ({ service_id: mapping.service_id, is_active: mapping.is_active })) };
      }
      if (/^SELECT id, is_active, bookable\s+FROM services/.test(normalized)) {
        return { rows: params[1].filter(id => {
          const service = state.services[id];
          return service && service.shop_id === params[0];
        }).map(id => ({
          id,
          is_active: state.services[id].is_active,
          bookable: state.services[id].bookable
        })) };
      }
      if (/^SELECT item\.id/.test(normalized)) {
        const blocks = ['pending', 'confirmed'].includes(futureStatus) &&
          ['primary', 'assistant'].includes(futureRole);
        return { rows: blocks ? [{ id: 'future-item' }] : [] };
      }
      if (/^UPDATE staff_services/.test(normalized)) {
        const removed = [];
        for (const mapping of state.mappings) {
          if (mapping.shop_id === params[0] && mapping.staff_id === params[1] && mapping.is_active && !params[2].includes(mapping.service_id)) {
            mapping.is_active = false;
            removed.push({ service_id: mapping.service_id });
          }
        }
        return { rows: deactivateMismatch ? removed.slice(1) : removed };
      }
      if (/^INSERT INTO staff_services/.test(normalized)) {
        for (const serviceId of params[2]) {
          const existing = state.mappings.find(mapping =>
            mapping.shop_id === params[0] && mapping.staff_id === params[1] && mapping.service_id === serviceId
          );
          if (existing) existing.is_active = true;
          else state.mappings.push({ id: `new-${serviceId}`, shop_id: params[0], staff_id: params[1], service_id: serviceId, is_active: true });
        }
        const rows = params[2].map(service_id => ({ service_id }));
        return { rows: upsertMismatch ? rows.slice(1) : rows };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { state.releases += 1; }
  };

  return { state, pool: {
    async query(sql) {
      if (/FROM owner_sessions/.test(sql)) return { rows: validSession ? [sessionRow(role)] : [] };
      throw new Error(`Unexpected pool SQL: ${sql.trim()}`);
    },
    async connect() { return client; }
  } };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

const send = (baseUrl, path, { method = 'GET', body, authenticated = true, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    ...(authenticated ? { cookie: 'gg_beauty_owner_session=token' } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

const run = (fixture, path, options) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => send(baseUrl, path, options));
};

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may read only tenant staff capability choices`, async () => {
    const fixture = makePool({ role });
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.some(row => row.service_id === ID.serviceB), false);
    assert.equal(data.find(row => row.service_id === ID.serviceA).assigned, true);
    assert.equal(data.find(row => row.service_id === ID.serviceA2).assigned, false);
    assert.equal(fixture.state.releases, 1);
    const serviceQuery = fixture.state.queries.find(query =>
      /FROM services AS service/.test(query.sql)
    );
    assert.match(serviceQuery.sql, /capability\.shop_id = service\.shop_id/);
    assert.match(serviceQuery.sql, /WHERE service\.shop_id = \$1/);
    assert.deepEqual(serviceQuery.params, [ID.shopA, ID.staffA]);
  });
}

for (const role of ['owner', 'manager']) {
  test(`${role} may atomically replace staff capabilities`, async () => {
    const fixture = makePool({ role });
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
      method: 'PUT', body: { serviceIds: [ID.serviceA2, ID.serviceUnbookable] }
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.state.committed, true);
    assert.equal(fixture.state.mappings.find(m => m.service_id === ID.serviceA).is_active, false);
    assert.equal(fixture.state.mappings.find(m => m.service_id === ID.serviceA2).is_active, true);
    assert.equal(fixture.state.mappings.find(m => m.service_id === ID.serviceUnbookable).is_active, true);
  });
}

test('admin PUT is denied before capability transaction', async () => {
  const fixture = makePool({ role: 'admin' });
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [] }
  });
  assert.equal(response.status, 403);
  assert.equal(fixture.state.queries.length, 0);
});

test('unauthenticated and invalid current sessions fail closed', async () => {
  for (const authenticated of [false, true]) {
    const fixture = makePool({ validSession: authenticated ? false : true });
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, { authenticated });
    assert.equal(response.status, 401);
    assert.equal(fixture.state.queries.length, 0);
  }
});

test('cross-tenant staff GET and PUT return safe 404', async () => {
  for (const method of ['GET', 'PUT']) {
    const fixture = makePool();
    const response = await run(fixture, `/api/owner/staff/${ID.staffB}/services`, {
      method, ...(method === 'PUT' ? { body: { serviceIds: [ID.serviceA] } } : {})
    });
    assert.equal(response.status, 404);
    assert.equal(JSON.stringify(await response.json()).includes('Other Shop'), false);
  }
});

test('client shop identity cannot change authenticated tenant', async () => {
  const fixture = makePool();
  const listed = await run(fixture, `/api/owner/staff/${ID.staffA}/services?shopId=${ID.shopB}`, {
    headers: { 'x-shop-id': ID.shopB }
  });
  assert.equal(listed.status, 200);
  const rejected = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA], shop_id: ID.shopB }
  });
  assert.equal(rejected.status, 400);
});

for (const serviceId of [ID.serviceB, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']) {
  test(`invalid tenant/nonexistent service ${serviceId.slice(0, 4)} rolls back all capability changes`, async () => {
    const fixture = makePool();
    const before = structuredClone(fixture.state.mappings);
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
      method: 'PUT', body: { serviceIds: [ID.serviceA2, serviceId] }
    });
    assert.equal(response.status, 404);
    assert.equal(fixture.state.rolledBack, true);
    assert.deepEqual(fixture.state.mappings, before);
  });
}

test('inactive mapping is reactivated without duplicate', async () => {
  const fixture = makePool();
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceA2] }
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.mappings.filter(m => m.service_id === ID.serviceA2).length, 1);
  assert.equal(fixture.state.mappings.find(m => m.service_id === ID.serviceA2).is_active, true);
});

test('duplicate service IDs are normalized safely', async () => {
  const fixture = makePool();
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceA] }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.serviceIds, [ID.serviceA]);
});

test('empty capability set soft-deactivates mappings without DELETE', async () => {
  const fixture = makePool();
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [] }
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.mappings.find(m => m.service_id === ID.serviceA).is_active, false);
  assert.doesNotMatch(fixture.state.queries.map(q => q.sql).join('\n'), /DELETE FROM staff_services/i);
});

test('staff bookable=false still permits capability configuration', async () => {
  const fixture = makePool({ staffBookable: false });
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceA2] }
  });
  assert.equal(response.status, 200);
});

test('service bookable=false still permits capability configuration', async () => {
  const fixture = makePool();
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceUnbookable] }
  });
  assert.equal(response.status, 200);
});

test('inactive service active mapping may be preserved', async () => {
  const fixture = makePool();
  fixture.state.mappings.push({ id: 'inactive-existing', shop_id: ID.shopA, staff_id: ID.staffA, service_id: ID.serviceInactive, is_active: true });
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceInactive] }
  });
  assert.equal(response.status, 200);
});

test('inactive service cannot be newly assigned or reactivated', async () => {
  for (const hasInactiveMapping of [false, true]) {
    const fixture = makePool();
    if (hasInactiveMapping) fixture.state.mappings.push({ id: 'inactive-old', shop_id: ID.shopA, staff_id: ID.staffA, service_id: ID.serviceInactive, is_active: false });
    const before = structuredClone(fixture.state.mappings);
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
      method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceInactive] }
    });
    assert.equal(response.status, 409);
    assert.deepEqual(fixture.state.mappings, before);
  }
});

for (const status of ['pending', 'confirmed']) {
  for (const role of ['primary', 'assistant']) {
    test(`future ${status} ${role} assignment blocks capability removal`, async () => {
      const fixture = makePool({ futureStatus: status, futureRole: role });
      const before = structuredClone(fixture.state.mappings);
      const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
        method: 'PUT', body: { serviceIds: [] }
      });
      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.code, 'STAFF_SERVICE_HAS_FUTURE_APPOINTMENTS');
      assert.equal(fixture.state.rolledBack, true);
      assert.deepEqual(fixture.state.mappings, before);
    });
  }
}

for (const status of ['completed', 'cancelled']) {
  test(`${status} appointment does not block capability removal`, async () => {
    const fixture = makePool({ futureStatus: status });
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
      method: 'PUT', body: { serviceIds: [] }
    });
    assert.equal(response.status, 200);
  });
}

for (const mismatch of ['deactivate', 'upsert']) {
  test(`${mismatch} rowcount mismatch fails closed and rolls back`, async () => {
    const fixture = makePool({
      deactivateMismatch: mismatch === 'deactivate',
      upsertMismatch: mismatch === 'upsert'
    });
    const before = structuredClone(fixture.state.mappings);
    const original = console.error;
    console.error = () => {};
    try {
      const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
        method: 'PUT',
        body: { serviceIds: mismatch === 'deactivate' ? [] : [ID.serviceA, ID.serviceA2] }
      });
      assert.equal(response.status, 500);
    } finally { console.error = original; }
    assert.equal(fixture.state.rolledBack, true);
    assert.deepEqual(fixture.state.mappings, before);
  });
}

const invalidBodies = [
  {},
  { serviceIds: 'not-array' },
  { serviceIds: ['not-a-uuid'] },
  { serviceIds: [], role: 'owner' },
  { serviceIds: Array(501).fill(ID.serviceA) }
];

for (const body of invalidBodies) {
  test('invalid capability input returns 400 before transaction', async () => {
    const fixture = makePool();
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, { method: 'PUT', body });
    assert.equal(response.status, 400);
    assert.equal(fixture.state.queries.length, 0);
  });
}

test('invalid staff UUID returns 400', async () => {
  const fixture = makePool();
  const response = await run(fixture, '/api/owner/staff/not-a-uuid/services');
  assert.equal(response.status, 400);
});

test('database error rolls back and response hides SQL details', async () => {
  const fixture = makePool({ dbError: true });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
      method: 'PUT', body: { serviceIds: [ID.serviceA] }
    });
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(payload).includes('private SQL'), false);
  } finally { console.error = original; }
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(fixture.state.releases, 1);
});

test('capability replacement never mutates appointments or historical assignments', async () => {
  const fixture = makePool();
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}/services`, {
    method: 'PUT', body: { serviceIds: [ID.serviceA, ID.serviceA2] }
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.appointmentWrites, 0);
  const sql = fixture.state.queries.map(q => q.sql).join('\n');
  assert.doesNotMatch(sql, /(UPDATE|INSERT|DELETE)\s+(appointments|appointment_items|appointment_item_staff_assignments)/i);
});
