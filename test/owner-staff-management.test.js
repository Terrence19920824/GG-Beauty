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
  locationA: '77777777-7777-4777-8777-777777777777',
  locationA2: '88888888-8888-4888-8888-888888888888',
  locationB: '99999999-9999-4999-8999-999999999999'
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

const staffRow = (id, shopId, name) => ({
  id,
  shop_id: shopId,
  name,
  phone: null,
  email: null,
  staff_code: null,
  bookable: true,
  is_active: true,
  created_at: '2030-01-01T00:00:00Z',
  updated_at: '2030-01-01T00:00:00Z'
});

const makePool = ({
  role = 'owner',
  validSession = true,
  hasFutureAppointment = false,
  dbError = false,
  locationUpsertMismatch = false
} = {}) => {
  const state = {
    staff: {
      [ID.staffA]: staffRow(ID.staffA, ID.shopA, 'Amy'),
      [ID.staffB]: staffRow(ID.staffB, ID.shopB, 'Bob')
    },
    locations: {
      [ID.locationA]: {
        id: ID.locationA,
        shop_id: ID.shopA,
        name: 'Main',
        timezone: 'Asia/Singapore',
        is_active: true
      },
      [ID.locationA2]: {
        id: ID.locationA2,
        shop_id: ID.shopA,
        name: 'Branch A',
        timezone: 'Asia/Singapore',
        is_active: true
      },
      [ID.locationB]: {
        id: ID.locationB,
        shop_id: ID.shopB,
        name: 'Other Shop',
        timezone: 'Asia/Singapore',
        is_active: true
      }
    },
    assignments: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      shop_id: ID.shopA,
      staff_id: ID.staffA,
      location_id: ID.locationA,
      is_active: true,
      is_primary: true
    }],
    queries: [],
    releases: 0,
    committed: false,
    rolledBack: false,
    snapshot: null,
    staffAccountsWrites: 0,
    appointmentWrites: 0
  };

  const safeStaff = row => {
    const { shop_id: _shopId, ...safe } = row;
    return safe;
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      if (normalized === 'BEGIN') {
        state.snapshot = structuredClone({
          staff: state.staff,
          assignments: state.assignments
        });
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        state.staff = state.snapshot.staff;
        state.assignments = state.snapshot.assignments;
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/^SET LOCAL lock_timeout/.test(normalized)) {
        return { rows: [] };
      }
      if (dbError) {
        throw Object.assign(new Error('private database detail'), {
          code: 'XX000'
        });
      }
      if (/staff_accounts/.test(normalized) && /^(INSERT|UPDATE|DELETE)/.test(normalized)) {
        state.staffAccountsWrites += 1;
      }
      if (/(appointments|appointment_items|appointment_item_staff_assignments)/.test(normalized) && /^(INSERT|UPDATE|DELETE)/.test(normalized)) {
        state.appointmentWrites += 1;
      }

      if (/^SELECT[\s\S]+JSONB_AGG/.test(normalized)) {
        return {
          rows: Object.values(state.staff)
            .filter(row => row.shop_id === params[0])
            .map(row => ({
              ...safeStaff(row),
              locations: state.assignments
                .filter(a =>
                  a.shop_id === params[0] &&
                  a.staff_id === row.id &&
                  a.is_active
                )
                .map(a => ({
                  id: a.location_id,
                  name: state.locations[a.location_id].name,
                  isPrimary: a.is_primary
                }))
            }))
        };
      }

      if (/^INSERT INTO staff \(/.test(normalized)) {
        const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const row = {
          id,
          shop_id: params[0],
          name: params[1],
          phone: params[2],
          email: params[3],
          staff_code: params[4],
          bookable: params[5],
          is_active: params[6],
          created_at: '2030-01-02T00:00:00Z',
          updated_at: '2030-01-02T00:00:00Z'
        };
        state.staff[id] = row;
        return { rows: [safeStaff(row)] };
      }

      if (/^SELECT id, is_active\s+FROM staff/.test(normalized)) {
        const row = state.staff[params[0]];
        return {
          rows: row && row.shop_id === params[1]
            ? [{ id: row.id, is_active: row.is_active }]
            : []
        };
      }

      if (/^SELECT appointment\.id/.test(normalized)) {
        return { rows: hasFutureAppointment ? [{ id: 'future' }] : [] };
      }

      if (/^UPDATE staff\s+SET/.test(normalized)) {
        const staffId = params.at(-2);
        const shopId = params.at(-1);
        const row = state.staff[staffId];
        if (!row || row.shop_id !== shopId) return { rows: [] };
        const setClause = normalized.match(/SET\s+([\s\S]+?)\s+WHERE/)[1];
        const map = {
          name: 'name', phone: 'phone', email: 'email',
          staff_code: 'staff_code', bookable: 'bookable',
          is_active: 'is_active'
        };
        for (const match of setClause.matchAll(
          /(name|phone|email|staff_code|bookable|is_active) = \$(\d+)/g
        )) {
          row[map[match[1]]] = params[Number(match[2]) - 1];
        }
        row.updated_at = '2030-01-03T00:00:00Z';
        return { rows: [safeStaff(row)] };
      }

      if (/^SELECT id\s+FROM staff\s+WHERE/.test(normalized)) {
        const row = state.staff[params[0]];
        return {
          rows: row && row.shop_id === params[1] ? [{ id: row.id }] : []
        };
      }

      if (/^SELECT[\s\S]+FROM locations AS location/.test(normalized)) {
        return {
          rows: Object.values(state.locations)
            .filter(location => location.shop_id === params[0])
            .map(location => {
              const assignment = state.assignments.find(a =>
                a.shop_id === params[0] &&
                a.staff_id === params[1] &&
                a.location_id === location.id
              );
              return {
                id: location.id,
                name: location.name,
                timezone: location.timezone,
                is_active: location.is_active,
                assigned: assignment ? assignment.is_active : false,
                is_primary: assignment ? assignment.is_primary : false
              };
            })
        };
      }

      if (/^SELECT id\s+FROM locations/.test(normalized)) {
        return {
          rows: params[1]
            .filter(id => {
              const location = state.locations[id];
              return location &&
                location.shop_id === params[0] &&
                location.is_active;
            })
            .map(id => ({ id }))
        };
      }

      if (/^SELECT id\s+FROM staff_location_assignments/.test(normalized)) {
        return {
          rows: state.assignments
            .filter(a => a.shop_id === params[0] && a.staff_id === params[1])
            .map(a => ({ id: a.id }))
        };
      }

      if (/^UPDATE staff_location_assignments/.test(normalized)) {
        for (const assignment of state.assignments) {
          if (
            assignment.shop_id === params[0] &&
            assignment.staff_id === params[1] &&
            assignment.is_active &&
            !params[2].includes(assignment.location_id)
          ) {
            assignment.is_active = false;
            assignment.is_primary = false;
          }
        }
        return { rows: [] };
      }

      if (/^INSERT INTO staff_location_assignments/.test(normalized)) {
        for (const locationId of params[2]) {
          let assignment = state.assignments.find(a =>
            a.shop_id === params[0] &&
            a.staff_id === params[1] &&
            a.location_id === locationId
          );
          if (assignment) {
            assignment.is_active = true;
          } else {
            assignment = {
              id: `new-${locationId}`,
              shop_id: params[0],
              staff_id: params[1],
              location_id: locationId,
              is_active: true,
              is_primary: false
            };
            state.assignments.push(assignment);
          }
        }
        const rows = params[2].map(location_id => ({ location_id }));
        return {
          rows: locationUpsertMismatch ? rows.slice(1) : rows
        };
      }

      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { state.releases += 1; }
  };

  return {
    state,
    pool: {
      async query(sql) {
        if (/FROM owner_sessions/.test(sql)) {
          return { rows: validSession ? [sessionRow(role)] : [] };
        }
        throw new Error(`Unexpected pool SQL: ${sql.trim()}`);
      },
      async connect() { return client; }
    }
  };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
  }
};

const send = (baseUrl, path, {
  method = 'GET', body, authenticated = true, headers = {}
} = {}) => fetch(`${baseUrl}${path}`, {
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

test('unauthenticated staff routes fail closed with 401', async () => {
  const fixture = makePool();
  for (const [method, path, body] of [
    ['GET', '/api/owner/staff'],
    ['POST', '/api/owner/staff', { name: 'New' }],
    ['PATCH', `/api/owner/staff/${ID.staffA}`, { name: 'Changed' }],
    ['GET', `/api/owner/staff/${ID.staffA}/locations`],
    ['PUT', `/api/owner/staff/${ID.staffA}/locations`, { locationIds: [] }]
  ]) {
    const response = await run(fixture, path, {
      method, body, authenticated: false
    });
    assert.equal(response.status, 401);
  }
  assert.equal(fixture.state.queries.length, 0);
});

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may list only authenticated tenant staff`, async () => {
    const fixture = makePool({ role });
    const response = await run(fixture, '/api/owner/staff');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.map(row => row.id), [ID.staffA]);
    assert.equal(JSON.stringify(payload).includes(ID.staffB), false);
    assert.equal(JSON.stringify(payload).includes('shop_id'), false);
    assert.deepEqual(fixture.state.queries[0].params, [ID.shopA]);
  });
}

for (const role of ['owner', 'manager']) {
  test(`${role} may create and update tenant staff`, async () => {
    const fixture = makePool({ role });
    const created = await run(fixture, '/api/owner/staff', {
      method: 'POST', body: { name: ' New Staff ', email: 'new@example.com' }
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.data.name, 'New Staff');
    assert.equal(createdBody.data.bookable, false);
    assert.equal(createdBody.data.is_active, true);
    const insert = fixture.state.queries.find(q => /^INSERT INTO staff \(/.test(q.sql));
    assert.equal(insert.params[0], ID.shopA);
    assert.equal(insert.params[5], false);

    const updated = await run(fixture, `/api/owner/staff/${ID.staffA}`, {
      method: 'PATCH', body: { name: 'Amy Updated', bookable: false }
    });
    assert.equal(updated.status, 200);
    assert.equal(fixture.state.staff[ID.staffA].name, 'Amy Updated');
  });
}

test('admin may read locations but cannot mutate staff or assignments', async () => {
  const fixture = makePool({ role: 'admin' });
  const locations = await run(
    fixture,
    `/api/owner/staff/${ID.staffA}/locations`
  );
  assert.equal(locations.status, 200);
  for (const [method, path, body] of [
    ['POST', '/api/owner/staff', { name: 'Denied' }],
    ['PATCH', `/api/owner/staff/${ID.staffA}`, { name: 'Denied' }],
    ['PUT', `/api/owner/staff/${ID.staffA}/locations`, { locationIds: [] }]
  ]) {
    assert.equal((await run(fixture, path, { method, body })).status, 403);
  }
});

test('revoked expired or inactive owner auth blocks every staff route', async () => {
  const fixture = makePool({ validSession: false });
  const response = await run(fixture, '/api/owner/staff');
  assert.equal(response.status, 401);
  assert.equal(fixture.state.queries.length, 0);
});

test('client tenant injection cannot change staff read or create scope', async () => {
  const fixture = makePool();
  const listed = await run(
    fixture,
    `/api/owner/staff?shopId=${ID.shopB}&shop_id=${ID.shopB}`,
    { headers: { 'x-shop-id': ID.shopB } }
  );
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.map(row => row.id), [ID.staffA]);

  const rejected = await run(fixture, '/api/owner/staff', {
    method: 'POST', body: { name: 'Injected', shopId: ID.shopB }
  });
  assert.equal(rejected.status, 400);

  const created = await run(fixture, '/api/owner/staff', {
    method: 'POST', body: { name: 'Safe' },
    headers: { 'x-tenant-id': ID.shopB }
  });
  assert.equal(created.status, 201);
  const insert = fixture.state.queries.findLast(q => /^INSERT INTO staff \(/.test(q.sql));
  assert.equal(insert.params[0], ID.shopA);
});

test('cross-tenant staff PATCH is a safe 404 and changes nothing', async () => {
  const fixture = makePool();
  const before = structuredClone(fixture.state.staff[ID.staffB]);
  const response = await run(fixture, `/api/owner/staff/${ID.staffB}`, {
    method: 'PATCH', body: { name: 'Blocked' }
  });
  assert.equal(response.status, 404);
  assert.deepEqual(fixture.state.staff[ID.staffB], before);
  assert.equal(fixture.state.rolledBack, true);
});

test('cross-tenant staff locations read is a safe 404', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/staff/${ID.staffB}/locations`
  );
  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(await response.json()).includes('Other Shop'), false);
});

test('staff location read returns only authenticated shop locations', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/staff/${ID.staffA}/locations`
  );
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.deepEqual(data.map(row => row.id).sort(), [ID.locationA, ID.locationA2].sort());
  assert.equal(data.some(row => row.id === ID.locationB), false);
});

test('location replacement normalizes duplicates and commits atomically', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/staff/${ID.staffA}/locations`,
    {
      method: 'PUT',
      body: { locationIds: [ID.locationA2, ID.locationA2] }
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.locationIds, [ID.locationA2]);
  assert.equal(fixture.state.committed, true);
  assert.equal(fixture.state.assignments.find(a => a.location_id === ID.locationA).is_active, false);
  assert.equal(fixture.state.assignments.find(a => a.location_id === ID.locationA2).is_active, true);
});

test('cross-tenant or nonexistent location fails closed and rolls back all changes', async () => {
  for (const locationId of [
    ID.locationB,
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  ]) {
    const fixture = makePool();
    const before = structuredClone(fixture.state.assignments);
    const response = await run(
      fixture,
      `/api/owner/staff/${ID.staffA}/locations`,
      { method: 'PUT', body: { locationIds: [locationId] } }
    );
    assert.equal(response.status, 404);
    assert.deepEqual(fixture.state.assignments, before);
    assert.equal(fixture.state.rolledBack, true);
  }
});

test('cross-tenant staff cannot be assigned to tenant location', async () => {
  const fixture = makePool();
  const before = structuredClone(fixture.state.assignments);
  const response = await run(
    fixture,
    `/api/owner/staff/${ID.staffB}/locations`,
    { method: 'PUT', body: { locationIds: [ID.locationA] } }
  );
  assert.equal(response.status, 404);
  assert.deepEqual(fixture.state.assignments, before);
});

test('assignment rowcount mismatch rolls back replacement', async () => {
  const fixture = makePool({ locationUpsertMismatch: true });
  const before = structuredClone(fixture.state.assignments);
  const original = console.error;
  console.error = () => {};
  try {
    const response = await run(
      fixture,
      `/api/owner/staff/${ID.staffA}/locations`,
      { method: 'PUT', body: { locationIds: [ID.locationA2] } }
    );
    assert.equal(response.status, 500);
  } finally {
    console.error = original;
  }
  assert.equal(fixture.state.rolledBack, true);
  assert.deepEqual(fixture.state.assignments, before);
});

test('deactivating staff with future appointments returns explicit 409', async () => {
  const fixture = makePool({ hasFutureAppointment: true });
  const response = await run(fixture, `/api/owner/staff/${ID.staffA}`, {
    method: 'PATCH', body: { isActive: false }
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.code, 'STAFF_HAS_FUTURE_APPOINTMENTS');
  assert.equal(fixture.state.staff[ID.staffA].is_active, true);
  assert.equal(fixture.state.rolledBack, true);
});

test('bookable false and safe deactivation never mutate appointments', async () => {
  const fixture = makePool();
  assert.equal((await run(fixture, `/api/owner/staff/${ID.staffA}`, {
    method: 'PATCH', body: { bookable: false }
  })).status, 200);
  assert.equal((await run(fixture, `/api/owner/staff/${ID.staffA}`, {
    method: 'PATCH', body: { isActive: false }
  })).status, 200);
  assert.equal(fixture.state.appointmentWrites, 0);
});

const invalidRequests = [
  ['empty name', 'POST', '/api/owner/staff', { name: '' }],
  ['whitespace name', 'POST', '/api/owner/staff', { name: '  ' }],
  ['unknown field', 'POST', '/api/owner/staff', { name: 'A', role: 'owner' }],
  ['invalid UUID', 'PATCH', '/api/owner/staff/not-a-uuid', { name: 'A' }],
  ['empty PATCH', 'PATCH', `/api/owner/staff/${ID.staffA}`, {}],
  ['invalid location list', 'PUT', `/api/owner/staff/${ID.staffA}/locations`, { locationIds: 'bad' }],
  ['invalid location UUID', 'PUT', `/api/owner/staff/${ID.staffA}/locations`, { locationIds: ['bad'] }]
];

for (const [label, method, path, body] of invalidRequests) {
  test(`validation rejects ${label}`, async () => {
    const fixture = makePool();
    const response = await run(fixture, path, { method, body });
    assert.equal(response.status, 400);
    assert.equal(fixture.state.queries.length, 0);
  });
}

test('staff creation never creates staff account and no hard delete exists', async () => {
  const fixture = makePool();
  const response = await run(fixture, '/api/owner/staff', {
    method: 'POST', body: { name: 'No Login Account' }
  });
  assert.equal(response.status, 201);
  assert.equal(fixture.state.staffAccountsWrites, 0);
  const sql = fixture.state.queries.map(q => q.sql).join('\n');
  assert.doesNotMatch(sql, /DELETE FROM staff/i);
  assert.doesNotMatch(sql, /staff_accounts/i);
});

test('database errors return safe 500 and release connections', async () => {
  const fixture = makePool({ dbError: true });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await run(fixture, '/api/owner/staff');
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(payload).includes('private database'), false);
  } finally {
    console.error = original;
  }
  assert.equal(fixture.state.releases, 1);
});
