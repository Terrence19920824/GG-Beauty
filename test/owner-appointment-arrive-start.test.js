'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  AppointmentMutationError,
  runInTransaction
} = require('../lib/appointment-multi-service');
const {
  canTransition,
  isKnownStatus,
  ownerStatusHistoryActorType
} = require('../lib/appointment-status');
const {
  createOwnerAppointmentArriveStart,
  deriveArriveAndStartPath
} = require('../lib/owner-appointment-arrive-start');

const ID = {
  appointment: '11111111-1111-4111-8111-111111111111',
  shopA: '22222222-2222-4222-8222-222222222222',
  shopB: '33333333-3333-4333-8333-333333333333',
  location: '44444444-4444-4444-8444-444444444444',
  account: '55555555-5555-4555-8555-555555555555'
};

const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const createFixture = ({ status = 'pending', failOnStatus = '', tenant = ID.shopA } = {}) => {
  const state = {
    status,
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
          status: state.status,
          itemStatuses: [...state.itemStatuses],
          history: [...state.history]
        };
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        state.status = state.snapshot.status;
        state.itemStatuses = [...state.snapshot.itemStatuses];
        state.history = [...state.snapshot.history];
        state.rolledBack = true;
        return { rows: [] };
      }
      if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
      if (/FROM appointments .*FOR UPDATE$/.test(normalized)) {
        const tenantMatches = params[1] === tenant;
        const idMatches = params[0] === ID.appointment;
        return { rows: tenantMatches && idMatches ? [{
          id: ID.appointment,
          shop_id: ID.shopA,
          location_id: ID.location,
          service_id: '66666666-6666-4666-8666-666666666666',
          staff_id: '77777777-7777-4777-8777-777777777777',
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          status: state.status,
          updated_at: '2030-01-01T00:00:00.000Z'
        }] : [] };
      }
      if (normalized.startsWith('UPDATE appointments')) {
        if (params[0] === failOnStatus) throw new Error('injected intermediate failure');
        assert.equal(params[4], state.status, 'edge update must compare the locked current status');
        state.status = params[0];
        return { rows: [{
          id: ID.appointment,
          status: state.status,
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          updated_at: '2030-01-01T00:01:00.000Z'
        }] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  return { state, client, pool };
};

const invoke = async (fixture, { shopId = ID.shopA, transactionRunner = runInTransaction } = {}) => {
  const handler = createOwnerAppointmentArriveStart({
    pool: fixture.pool,
    isUuid,
    runInTransaction: transactionRunner,
    AppointmentMutationError,
    loadAndValidatePhaseAStructure: async () => ({ itemCount: 2 }),
    syncAppointmentItemStatus: async (_client, { status, expectedItemCount }) => {
      assert.equal(expectedItemCount, 2);
      fixture.state.itemStatuses = [status, status];
    },
    isKnownStatus,
    canTransition,
    ownerStatusHistoryActorType,
    recordStatusHistory: async (_client, entry) => {
      fixture.state.history.push({
        from: entry.fromStatus,
        to: entry.toStatus,
        operatorType: entry.operatorType,
        operatorId: entry.operatorId,
        source: entry.source
      });
    },
    safeErrorCode: error => error?.code || ''
  });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await handler({
    params: { appointmentId: ID.appointment },
    ownerAuth: { shopId, role: 'front_desk', ownerAccountId: ID.account }
  }, response);
  return response;
};

test('deriveArriveAndStartPath preserves every adjacent lifecycle edge', () => {
  assert.deepEqual(deriveArriveAndStartPath('pending'), ['confirmed', 'arrived', 'in_service']);
  assert.deepEqual(deriveArriveAndStartPath('confirmed'), ['arrived', 'in_service']);
  assert.deepEqual(deriveArriveAndStartPath('arrived'), ['in_service']);
  assert.deepEqual(deriveArriveAndStartPath('in_service'), []);
  assert.equal(deriveArriveAndStartPath('completed'), null);
  assert.equal(deriveArriveAndStartPath('cancelled'), null);
  assert.equal(deriveArriveAndStartPath('no_show'), null);
});

for (const [start, expectedEdges] of [
  ['pending', [['pending', 'confirmed'], ['confirmed', 'arrived'], ['arrived', 'in_service']]],
  ['confirmed', [['confirmed', 'arrived'], ['arrived', 'in_service']]],
  ['arrived', [['arrived', 'in_service']]]
]) {
  test(`${start} arrives and starts atomically with exact history`, async () => {
    const fixture = createFixture({ status: start });
    const response = await invoke(fixture);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.status, 'in_service');
    assert.equal(fixture.state.status, 'in_service');
    assert.deepEqual(fixture.state.itemStatuses, ['in_service', 'in_service']);
    assert.deepEqual(fixture.state.history.map(edge => [edge.from, edge.to]), expectedEdges);
    assert.ok(fixture.state.history.every(edge => edge.source === 'owner_arrive_and_start'));
    assert.ok(fixture.state.history.every(edge => edge.operatorType === 'owner' && edge.operatorId === ID.account));
    assert.equal(fixture.state.committed, true);
  });
}

test('in_service duplicate retry is an idempotent no-op', async () => {
  const fixture = createFixture({ status: 'in_service' });
  const response = await invoke(fixture);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.status, 'in_service');
  assert.deepEqual(response.payload.data.applied_transitions, []);
  assert.equal(fixture.state.queries.some(query => query.sql.startsWith('UPDATE')), false);
  assert.deepEqual(fixture.state.history, []);
});

test('double submit serializes to one edge sequence and one idempotent retry', async () => {
  const fixture = createFixture({ status: 'pending' });
  let tail = Promise.resolve();
  const serializedTransactionRunner = async (pool, operation) => {
    let releaseTurn;
    const turn = new Promise(resolve => { releaseTurn = resolve; });
    const previous = tail;
    tail = tail.then(() => turn);
    await previous;
    try {
      return await runInTransaction(pool, operation);
    } finally {
      releaseTurn();
    }
  };
  const [first, second] = await Promise.all([
    invoke(fixture, { transactionRunner: serializedTransactionRunner }),
    invoke(fixture, { transactionRunner: serializedTransactionRunner })
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.payload.data.status, 'in_service');
  assert.equal(second.payload.data.status, 'in_service');
  assert.deepEqual(fixture.state.history.map(edge => [edge.from, edge.to]), [
    ['pending', 'confirmed'],
    ['confirmed', 'arrived'],
    ['arrived', 'in_service']
  ]);
});

for (const terminal of ['completed', 'cancelled', 'no_show']) {
  test(`${terminal} is rejected without mutation`, async () => {
    const fixture = createFixture({ status: terminal });
    const response = await invoke(fixture);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'APPOINTMENT_STATUS_NOT_ELIGIBLE');
    assert.equal(fixture.state.status, terminal);
    assert.equal(fixture.state.rolledBack, true);
  });
}

test('intermediate failure rolls back parent, items, and history', async () => {
  const fixture = createFixture({ status: 'pending', failOnStatus: 'arrived' });
  const response = await invoke(fixture);
  assert.equal(response.statusCode, 500);
  assert.equal(fixture.state.rolledBack, true);
  assert.equal(fixture.state.status, 'pending');
  assert.deepEqual(fixture.state.itemStatuses, ['pending', 'pending']);
  assert.deepEqual(fixture.state.history, []);
  assert.equal(JSON.stringify(response.payload).includes('injected intermediate failure'), false);
});

test('tenant isolation uses authenticated shop and returns safe not found', async () => {
  const fixture = createFixture({ tenant: ID.shopA });
  const response = await invoke(fixture, { shopId: ID.shopB });
  assert.equal(response.statusCode, 404);
  assert.equal(fixture.state.status, 'pending');
  const lookup = fixture.state.queries.find(query => /FROM appointments/.test(query.sql));
  assert.deepEqual(lookup.params, [ID.appointment, ID.shopB]);
});

test('route role matrix allows owner desk roles and excludes ordinary staff', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = serverSource.slice(serverSource.indexOf("'/api/owner/appointments/:appointmentId/arrive-and-start'"));
  assert.match(route, /requireOwnerRole\(\['owner', 'manager', 'admin', 'front_desk'\]\)/);
  assert.doesNotMatch(route.slice(0, 600), /'staff'/);
});

test('locked parent is first domain row lock and each update is current-status guarded', async () => {
  const fixture = createFixture({ status: 'pending' });
  await invoke(fixture);
  const lockIndex = fixture.state.queries.findIndex(query => /FROM appointments .*FOR UPDATE$/.test(query.sql));
  const updateIndex = fixture.state.queries.findIndex(query => query.sql.startsWith('UPDATE appointments'));
  assert.ok(lockIndex >= 0 && updateIndex > lockIndex);
  assert.match(fixture.state.queries[lockIndex].sql, /shop_id = \$2/);
  assert.ok(fixture.state.queries.filter(query => query.sql.startsWith('UPDATE appointments')).every(query => /status = \$5/.test(query.sql)));
});
