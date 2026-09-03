'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  locationA: '55555555-5555-4555-8555-555555555555',
  appointmentA: '77777777-7777-4777-8777-777777777777',
  appointmentB: '88888888-8888-4888-8888-888888888888'
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

const makePool = ({
  role = 'owner',
  validSession = true,
  appointmentFound = true,
  currentStatus = 'pending',
  structureValid = true,
  itemCount = 2,
  returnedItemCount = itemCount,
  itemUpdateError = false,
  readError = false,
  lockError = false
} = {}) => {
  const initial = {
    parentStatus: currentStatus,
    itemStatuses: Array(itemCount).fill(currentStatus),
    cancelledAt: null
  };
  const state = {
    ...structuredClone(initial),
    queries: [],
    releases: 0,
    committed: false,
    rolledBack: false,
    assignmentsChanged: false,
    customerChanged: false,
    snapshot: null
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      if (normalized === 'BEGIN') {
        state.snapshot = {
          parentStatus: state.parentStatus,
          itemStatuses: [...state.itemStatuses],
          cancelledAt: state.cancelledAt
        };
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        Object.assign(state, state.snapshot);
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/^SET LOCAL lock_timeout/.test(normalized)) {
        return { rows: [] };
      }
      if (/FROM appointments\s+WHERE id = \$1/.test(normalized)) {
        if (readError) {
          throw Object.assign(new Error('private database detail'), { code: 'XX000' });
        }
        if (lockError) {
          throw Object.assign(new Error('lock timeout detail'), { code: '55P03' });
        }
        const tenantMatch = params[1] === ID.shopA;
        const targetMatch = params[0] === ID.appointmentA;
        return {
          rows: appointmentFound && tenantMatch && targetMatch
            ? [{
                id: ID.appointmentA,
                shop_id: ID.shopA,
                location_id: ID.locationA,
                service_id: '99999999-9999-4999-8999-999999999999',
                staff_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                start_at: '2030-01-01T02:00:00Z',
                end_at: '2030-01-01T03:00:00Z',
                status: state.parentStatus,
                cancelled_at: state.cancelledAt,
                service_completed_at: null,
                updated_at: '2030-01-01T00:00:00Z'
              }]
            : []
        };
      }
      if (/^SELECT id\s+FROM appointment_items/.test(normalized)) {
        return {
          rows: Array.from({ length: itemCount }, (_, index) => ({ id: `item-${index}` }))
        };
      }
      if (/^SELECT assignment\.id/.test(normalized)) {
        return {
          rows: Array.from({ length: itemCount }, (_, index) => ({ id: `assignment-${index}` }))
        };
      }
      if (/^WITH parent AS/.test(normalized)) {
        return {
          rows: [{
            item_count: itemCount,
            assignment_count: itemCount,
            structure_valid: structureValid
          }]
        };
      }
      if (/^UPDATE appointments/.test(normalized)) {
        state.parentStatus = params[0];
        if (params[0] === 'cancelled') state.cancelledAt = '2030-01-02T00:00:00Z';
        return {
          rows: [{
            id: ID.appointmentA,
            status: state.parentStatus,
            start_at: '2030-01-01T02:00:00Z',
            end_at: '2030-01-01T03:00:00Z',
            updated_at: '2030-01-02T00:00:00Z'
          }]
        };
      }
      if (/^UPDATE appointment_items/.test(normalized)) {
        if (itemUpdateError) throw new Error('private item update detail');
        state.itemStatuses = Array(itemCount).fill(params[3]);
        return {
          rows: Array.from({ length: returnedItemCount }, (_, index) => ({ id: `item-${index}` }))
        };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { state.releases += 1; }
  };

  const pool = {
    async query(sql) {
      if (/FROM owner_sessions/.test(sql)) {
        return { rows: validSession ? [sessionRow(role)] : [] };
      }
      throw new Error(`Unexpected pool SQL: ${sql.trim()}`);
    },
    async connect() { return client; }
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

const updateStatus = (baseUrl, body, { authenticated = true, headers = {} } = {}) =>
  fetch(`${baseUrl}/api/admin/update-status-db`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { cookie: 'gg_beauty_owner_session=raw-owner-token' } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });

const runRequest = async (fixture, body, options) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => updateStatus(baseUrl, body, options));
};

test('unauthenticated status update returns 401 before DB mutation', async () => {
  const fixture = makePool();
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' }, { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(fixture.state.queries.length, 0);
});

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may update a tenant appointment`, async () => {
    const fixture = makePool({ role });
    const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
    assert.equal(response.status, 200);
    assert.equal(fixture.state.parentStatus, 'confirmed');
    assert.deepEqual(fixture.state.itemStatuses, ['confirmed', 'confirmed']);
    assert.equal(fixture.state.committed, true);
  });
}

test('invalid current role is denied before transaction', async () => {
  const fixture = makePool({ role: 'viewer' });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 403);
  assert.equal(fixture.state.queries.length, 0);
});

for (const condition of [
  'inactive account',
  'inactive membership',
  'inactive shop',
  'revoked session',
  'expired session'
]) {
  test(`${condition} is denied before mutation`, async () => {
    const fixture = makePool({ validSession: false });
    const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
    assert.equal(response.status, 401);
    assert.equal(fixture.state.queries.length, 0);
  });
}

test('invalid appointment UUID and status return 400', async () => {
  const fixture = makePool();
  assert.equal((await runRequest(fixture, { id: "' OR 1=1 --", status: 'confirmed' })).status, 400);
  assert.equal((await runRequest(fixture, { id: ID.appointmentA, status: 'invented' })).status, 400);
  assert.equal(fixture.state.queries.length, 0);
});

test('appointmentId is accepted but conflicting compatibility ids are rejected', async () => {
  const fixture = makePool();
  assert.equal((await runRequest(fixture, { appointmentId: ID.appointmentA, status: 'confirmed' })).status, 200);
  const conflict = makePool();
  assert.equal((await runRequest(conflict, {
    appointmentId: ID.appointmentA,
    id: ID.appointmentB,
    status: 'confirmed'
  })).status, 400);
});

test('cross-tenant appointment and items remain unchanged with a safe 404', async () => {
  const fixture = makePool();
  const response = await runRequest(fixture, {
    id: ID.appointmentB,
    status: 'cancelled',
    shopId: ID.shopB,
    shop_id: ID.shopB
  }, { headers: { 'x-shop-id': ID.shopB } });
  assert.equal(response.status, 404);
  assert.equal(fixture.state.parentStatus, 'pending');
  assert.deepEqual(fixture.state.itemStatuses, ['pending', 'pending']);
  const lookup = fixture.state.queries.find(query => /FROM appointments/.test(query.sql));
  assert.deepEqual(lookup.params, [ID.appointmentB, ID.shopA]);
  assert.equal(fixture.state.rolledBack, true);
});

test('parent and all items update atomically and unrelated records are untouched', async () => {
  const fixture = makePool();
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'confirmed');
  assert.deepEqual(fixture.state.itemStatuses, ['confirmed', 'confirmed']);
  assert.equal(fixture.state.assignmentsChanged, false);
  assert.equal(fixture.state.customerChanged, false);
  assert.equal(
    fixture.state.queries.some(query =>
      /^UPDATE (customers|appointment_item_staff_assignments)/.test(query.sql)
    ),
    false
  );
  assert.equal(fixture.state.releases, 1);
});

test('item update error rolls back the parent update', async () => {
  const fixture = makePool({ itemUpdateError: true });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 500);
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(fixture.state.parentStatus, 'pending');
  assert.deepEqual(fixture.state.itemStatuses, ['pending', 'pending']);
  assert.equal(JSON.stringify(await response.json()).includes('private item update detail'), false);
});

test('item row-count mismatch rolls back with 409', async () => {
  const fixture = makePool({ returnedItemCount: 1 });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 409);
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(fixture.state.parentStatus, 'pending');
});

test('initial parent/item inconsistency fails closed', async () => {
  const fixture = makePool({ structureValid: false });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 409);
  assert.equal(fixture.state.parentStatus, 'pending');
  assert.equal(fixture.state.rolledBack, true);
});

test('cancellation synchronizes parent and items and preserves cancellation timestamp semantics', async () => {
  const fixture = makePool();
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'cancelled' });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'cancelled');
  assert.deepEqual(fixture.state.itemStatuses, ['cancelled', 'cancelled']);
  assert.ok(fixture.state.cancelledAt);
  const parentUpdate = fixture.state.queries.find(query => /^UPDATE appointments/.test(query.sql));
  assert.match(parentUpdate.sql, /WHEN \$1 = 'cancelled'\s+THEN NOW\(\)\s+ELSE cancelled_at/);
});

test('same status is a validated no-op success', async () => {
  const fixture = makePool({ currentStatus: 'confirmed' });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.queries.some(query => /^UPDATE/.test(query.sql)), false);
  assert.equal(fixture.state.committed, true);
});

for (const [from, to] of [
  ['pending', 'completed'],
  ['pending', 'no_show'],
  ['confirmed', 'pending'],
  ['completed', 'pending'],
  ['cancelled', 'pending'],
  ['no_show', 'confirmed']
]) {
  test(`illegal transition ${from} -> ${to} fails closed`, async () => {
    const fixture = makePool({ currentStatus: from });
    const response = await runRequest(fixture, { id: ID.appointmentA, status: to });
    assert.equal(response.status, 409);
    assert.equal(fixture.state.parentStatus, from);
    assert.equal(fixture.state.rolledBack, true);
  });
}

test('confirmed may transition to completed cancelled or no_show', async () => {
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const fixture = makePool({ currentStatus: 'confirmed' });
    const response = await runRequest(fixture, { id: ID.appointmentA, status });
    assert.equal(response.status, 200);
    assert.equal(fixture.state.parentStatus, status);
    assert.deepEqual(fixture.state.itemStatuses, [status, status]);
  }
});

test('transaction configures lock timeout and locks tenant-scoped parent', async () => {
  const fixture = makePool();
  await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.ok(fixture.state.queries.some(query => query.sql === "SET LOCAL lock_timeout = '5s'"));
  const lookup = fixture.state.queries.find(query => /FROM appointments/.test(query.sql));
  assert.match(lookup.sql, /shop_id = \$2/);
  assert.match(lookup.sql, /FOR UPDATE/);
});

test('lock conflict returns safe 409 without retry', async () => {
  const fixture = makePool({ lockError: true });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 409);
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(fixture.state.queries.filter(query => /FROM appointments/.test(query.sql)).length, 1);
});

test('unknown database error returns safe 500 and releases connection', async () => {
  const fixture = makePool({ readError: true });
  const response = await runRequest(fixture, { id: ID.appointmentA, status: 'confirmed' });
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes('private database detail'), false);
  assert.equal(fixture.state.releases, 1);
});

test('legacy admin IP session cannot access migrated mutation', async () => {
  const fixture = makePool({ validSession: false });
  app.locals.ownerAuthPool = fixture.pool;
  await withServer(async baseUrl => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-admin-password' })
    });
    assert.equal(login.status, 200);
    const response = await updateStatus(baseUrl, { id: ID.appointmentA, status: 'confirmed' }, { authenticated: false });
    assert.equal(response.status, 401);
  });
  assert.equal(fixture.state.queries.length, 0);
});
