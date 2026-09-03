'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  StaffBookabilityError
} = require('../lib/staff-bookability-validator');
const {
  filterBookableCandidateSlots
} = require('../server');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  service: '44444444-4444-4444-8444-444444444444'
};

const candidates = () => [
  {
    time: '10:00',
    start_at: '2030-01-07T02:00:00.000000Z',
    end_at: '2030-01-07T03:00:00.000000Z',
    has_database_guard_collision: false
  },
  {
    time: '10:30',
    start_at: '2030-01-07T02:30:00.000000Z',
    end_at: '2030-01-07T03:30:00.000000Z',
    has_database_guard_collision: false
  }
];

const run = validator =>
  filterBookableCandidateSlots({
    dbClient: { query: async () => ({ rows: [] }) },
    candidates: candidates(),
    shopId: ID.shop,
    locationId: ID.location,
    staffId: ID.staff,
    serviceId: ID.service,
    validator
  });

const unavailable = code => async () => {
  throw new StaffBookabilityError(code);
};

for (const [name, code] of [
  ['staff bookable=false', 'STAFF_NOT_BOOKABLE'],
  ['service bookable=false', 'SERVICE_NOT_BOOKABLE'],
  ['staff_services missing', 'STAFF_SERVICE_NOT_ALLOWED'],
  ['location assignment missing', 'STAFF_LOCATION_NOT_ASSIGNED'],
  ['working hours missing', 'NO_WORKING_HOURS'],
  ['day_off', 'STAFF_ON_LEAVE'],
  ['pending override', 'SCHEDULE_OVERRIDE_PENDING']
]) {
  test(`${name} returns empty availability`, async () => {
    assert.deepEqual(await run(unavailable(code)), []);
  });
}

test('normal weekly hours return only validator-approved slots', async () => {
  const result = await run(async ({ requestedStartAt }) => {
    if (requestedStartAt.includes('02:30:00')) {
      throw new StaffBookabilityError('OUTSIDE_WORKING_HOURS');
    }
  });
  assert.deepEqual(result, ['10:00']);
});

test('leave overlap filters only the affected slot', async () => {
  const result = await run(async ({ requestedStartAt }) => {
    if (requestedStartAt.includes('02:30:00')) {
      throw new StaffBookabilityError('STAFF_ON_LEAVE');
    }
  });
  assert.deepEqual(result, ['10:00']);
});

test('custom hours return only slots inside the override', async () => {
  const result = await run(async ({ requestedStartAt }) => {
    if (requestedStartAt.includes('02:00:00')) {
      throw new StaffBookabilityError('OUTSIDE_WORKING_HOURS');
    }
  });
  assert.deepEqual(result, ['10:30']);
});

test('database-guard collision is filtered before validation', async () => {
  const rows = candidates();
  rows[0].has_database_guard_collision = true;
  let validationCalls = 0;
  const result = await filterBookableCandidateSlots({
    dbClient: {},
    candidates: rows,
    shopId: ID.shop,
    locationId: ID.location,
    staffId: ID.staff,
    serviceId: ID.service,
    validator: async () => {
      validationCalls += 1;
    }
  });
  assert.deepEqual(result, ['10:30']);
  assert.equal(validationCalls, 1);
});

test('validator collision filters the slot', async () => {
  assert.deepEqual(
    await run(unavailable('APPOINTMENT_COLLISION')),
    []
  );
});

test('cross-tenant scope error is not converted to availability', async () => {
  await assert.rejects(
    run(unavailable('BOOKABILITY_SCOPE_INVALID')),
    error =>
      error instanceof StaffBookabilityError &&
      error.code === 'BOOKABILITY_SCOPE_INVALID'
  );
});

test('unexpected validator error propagates for safe route 500', async () => {
  await assert.rejects(
    run(async () => {
      throw new Error('internal detail');
    }),
    /internal detail/
  );
});

test('validator receives trusted ids and candidate instants', async () => {
  const seen = [];
  await run(async input => {
    seen.push(input);
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(
    {
      shopId: seen[0].shopId,
      locationId: seen[0].locationId,
      staffId: seen[0].staffId,
      serviceId: seen[0].serviceId,
      requestedStartAt: seen[0].requestedStartAt,
      requestedEndAt: seen[0].requestedEndAt
    },
    {
      shopId: ID.shop,
      locationId: ID.location,
      staffId: ID.staff,
      serviceId: ID.service,
      requestedStartAt: candidates()[0].start_at,
      requestedEndAt: candidates()[0].end_at
    }
  );
});
