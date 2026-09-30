'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const assert = require('node:assert/strict');
const test = require('node:test');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shop: '33333333-3333-4333-8333-333333333333',
  otherShop: '44444444-4444-4444-8444-444444444444',
  location: '55555555-5555-4555-8555-555555555555',
  appointment: '66666666-6666-4666-8666-666666666666',
  service: '77777777-7777-4777-8777-777777777777',
  staff: '88888888-8888-4888-8888-888888888888'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shop,
  login_identifier: 'OwnerOne',
  display_name: 'Owner One',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const makePool = ({ role = 'owner', validSession = true, tenant = ID.shop, status = 'confirmed' } = {}) => {
  const state = {
    parentStatus: status,
    itemStatuses: [status, status],
    history: [],
    queries: [],
    committed: false,
    rolledBack: false,
    snapshot: null
  };
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.queries.push({ sql: normalized, params });
      if (normalized === 'BEGIN') {
        state.snapshot = {
          parentStatus: state.parentStatus,
          itemStatuses: [...state.itemStatuses],
          history: [...state.history]
        };
        return { rows: [] };
      }
      if (normalized === 'COMMIT') { state.committed = true; return { rows: [] }; }
      if (normalized === 'ROLLBACK') {
        state.parentStatus = state.snapshot.parentStatus;
        state.itemStatuses = [...state.snapshot.itemStatuses];
        state.history = [...state.snapshot.history];
        state.rolledBack = true;
        return { rows: [] };
      }
      if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
      if (/FROM appointments WHERE id = \$1 AND shop_id = \$2 FOR UPDATE$/.test(normalized)) {
        return { rows: params[0] === ID.appointment && params[1] === tenant ? [{
          id: ID.appointment,
          shop_id: ID.shop,
          location_id: ID.location,
          service_id: ID.service,
          staff_id: ID.staff,
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          status: state.parentStatus,
          updated_at: '2030-01-01T00:00:00.000Z'
        }] : [] };
      }
      if (normalized.startsWith('SELECT id FROM appointment_items')) {
        return { rows: [{ id: 'item-1' }, { id: 'item-2' }] };
      }
      if (normalized.startsWith('SELECT assignment.id')) {
        return { rows: [{ id: 'assignment-1' }, { id: 'assignment-2' }] };
      }
      if (normalized.startsWith('WITH parent AS')) {
        return { rows: [{ item_count: 2, assignment_count: 2, structure_valid: true }] };
      }
      if (normalized.startsWith('UPDATE appointments')) {
        assert.equal(params[4], state.parentStatus);
        state.parentStatus = params[0];
        return { rows: [{
          id: ID.appointment,
          status: state.parentStatus,
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          updated_at: '2030-01-01T00:01:00.000Z'
        }] };
      }
      if (normalized.startsWith('UPDATE appointment_items')) {
        state.itemStatuses = [params[3], params[3]];
        return { rows: [{ id: 'item-1' }, { id: 'item-2' }] };
      }
      if (normalized.startsWith('INSERT INTO appointment_status_history')) {
        state.history.push([params[2], params[3], params[4], params[5], params[6]]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {}
  };
  return {
    state,
    pool: {
      async query(sql) {
        if (/FROM owner_sessions/.test(sql)) return { rows: validSession ? [sessionRow(role)] : [] };
        throw new Error(`Unexpected pool SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
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
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const request = (fixture, { authenticated = true } = {}) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => fetch(`${baseUrl}/api/owner/appointments/${ID.appointment}/arrive-and-start`, {
    method: 'POST',
    headers: authenticated ? { cookie: 'gg_beauty_owner_session=raw-owner-token' } : {}
  }));
};

test('arrive-and-start rejects unauthenticated request before transaction', async () => {
  const fixture = makePool();
  const response = await request(fixture, { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(fixture.state.queries.length, 0);
});

for (const role of ['owner', 'manager', 'admin', 'front_desk']) {
  test(`arrive-and-start allows ${role}`, async () => {
    const fixture = makePool({ role });
    const response = await request(fixture);
    assert.equal(response.status, 200);
    assert.equal(fixture.state.parentStatus, 'in_service');
    assert.deepEqual(fixture.state.itemStatuses, ['in_service', 'in_service']);
    assert.deepEqual(fixture.state.history.map(edge => edge.slice(0, 2)), [
      ['confirmed', 'arrived'],
      ['arrived', 'in_service']
    ]);
  });
}

test('arrive-and-start rejects ordinary staff role before transaction', async () => {
  const fixture = makePool({ role: 'staff' });
  const response = await request(fixture);
  assert.equal(response.status, 403);
  assert.equal(fixture.state.queries.length, 0);
});

test('arrive-and-start cannot cross authenticated tenant', async () => {
  const fixture = makePool({ tenant: ID.otherShop });
  const response = await request(fixture);
  assert.equal(response.status, 404);
  assert.equal(fixture.state.parentStatus, 'confirmed');
  assert.equal(fixture.state.rolledBack, true);
});
