'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { StaffBookabilityError } = require('../lib/staff-bookability-validator');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111', location: '22222222-2222-4222-8222-222222222222',
  serviceA: '33333333-3333-4333-8333-111111111111', serviceB: '33333333-3333-4333-8333-222222222222',
  staffA: '44444444-4444-4444-8444-111111111111', staffB: '44444444-4444-4444-8444-222222222222',
  customer: '55555555-5555-4555-8555-555555555555', appointment: '66666666-6666-4666-8666-666666666666'
};

const requestBody = {
  shopSlug: 'tenant-a', locale: 'en', startAt: '2030-01-07T02:00:00.000Z',
  customerName: 'Customer', phone: '00000000', email: 'customer@example.invalid',
  items: [
    { clientItemKey: 'facial', serviceId: ID.serviceA, staffSelectionType: 'specific', staffId: ID.staffA },
    { clientItemKey: 'balayage', serviceId: ID.serviceB, staffSelectionType: 'specific', staffId: ID.staffB }
  ]
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

const makeFixture = (failOnSql, candidateRows) => {
  let itemIndex = 0;
  const state = { queries: [], released: 0 };
  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.trim(); state.queries.push({ sql: normalized, params });
      const failure = failOnSql && failOnSql(normalized); if (failure) throw failure;
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return { rows: [] };
      if (/SELECT shop\.id AS shop_id/.test(sql)) return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      if (/service\.id=ANY/.test(sql)) return { rows: [
        { id: ID.serviceA, duration_minutes: 60, price: '88', price_is_from: false, category_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', localized_name: 'Basic Facial' },
        { id: ID.serviceB, duration_minutes: 180, price: '238', price_is_from: true, category_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', localized_name: 'Balayage' }
      ].filter(row => params[1].includes(row.id)) };
      if (/assigned_appointment_count/.test(sql)) return { rows: candidateRows
        ? candidateRows(params[2])
        : [{ staff_id: params[2] === ID.serviceA ? ID.staffA : ID.staffB, display_name: params[2] === ID.serviceA ? 'Amy' : 'Bob', assigned_appointment_count: 0 }] };
      if (/TO_CHAR\(\(\(\$1::DATE\+candidate\.time::TIME\)/.test(sql)) return { rows: [
        { time: '10:00', start_at: '2030-01-07T02:00:00.000000Z' },
        { time: '10:30', start_at: '2030-01-07T02:30:00.000000Z' }
      ] };
      if (/SELECT id FROM customers/.test(sql)) return { rows: [{ id: ID.customer }] };
      if (/INSERT INTO appointments/.test(sql)) return { rows: [{ id: ID.appointment, shop_id: ID.shop, location_id: ID.location, customer_id: ID.customer, service_id: params[6], staff_id: params[7], appointment_no: 'GG-MULTI', start_at: params[8], end_at: params[9], status: 'pending', created_at: '2030-01-01T00:00:00.000Z' }] };
      if (/INSERT INTO appointment_items/.test(sql)) return { rows: [{ id: `77777777-7777-4777-8777-${String(++itemIndex).padStart(12, '0')}` }] };
      if (/INSERT INTO appointment_item_staff_assignments/.test(sql)) return { rows: [{ id: `88888888-8888-4888-8888-${String(itemIndex).padStart(12, '0')}` }] };
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { state.released += 1; }
  };
  return { state, pool: { connect: async () => client }, client };
};

const post = (base, body = requestBody) => fetch(`${base}/api/new-db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('multi-service request writes parent, sequential items and primary assignments atomically', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(); const validations = [];
  app.locals.bookingPool = fixture.pool;
  app.locals.bookingValidator = async input => validations.push(input);
  await withServer(async base => assert.equal((await post(base)).status, 200));
  assert.deepEqual(validations.map(input => [input.staffId, input.requestedStartAt, input.requestedEndAt]), [
    [ID.staffA, '2030-01-07T02:00:00.000Z', '2030-01-07T03:00:00.000Z'],
    [ID.staffB, '2030-01-07T03:00:00.000Z', '2030-01-07T06:00:00.000Z']
  ]);
  const parent = fixture.state.queries.find(query => /^INSERT INTO appointments/.test(query.sql));
  assert.deepEqual(parent.params.slice(6, 10), [ID.serviceA, ID.staffA, '2030-01-07T02:00:00.000Z', '2030-01-07T06:00:00.000Z']);
  const items = fixture.state.queries.filter(query => /^INSERT INTO appointment_items/.test(query.sql));
  assert.deepEqual(items.map(query => [query.params[4], query.params[5], query.params[7], query.params[8], query.params[9], query.params[10]]), [
    [1, 'Basic Facial', 60, '88', '2030-01-07T02:00:00.000Z', '2030-01-07T03:00:00.000Z'],
    [2, 'Balayage', 180, '238', '2030-01-07T03:00:00.000Z', '2030-01-07T06:00:00.000Z']
  ]);
  assert.equal(fixture.state.queries.filter(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql)).length, 2);
  assert.equal(fixture.state.queries.at(-1).sql, 'COMMIT');
});

test('same staff endpoint creates exactly two sequential primary assignments', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(); app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const body = { ...requestBody, items: requestBody.items.map(item => ({ ...item, staffId: ID.staffA })) };
  await withServer(async base => assert.equal((await post(base, body)).status, 200));
  const assignments = fixture.state.queries.filter(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql));
  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments.map(query => query.params[3]), [ID.staffA, ID.staffA]);
});

test('no-preference endpoint reserves scarce A and deterministically resolves B then A', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(null, serviceId => serviceId === ID.serviceA
    ? [{ staff_id: ID.staffA, display_name: 'Amy' }, { staff_id: ID.staffB, display_name: 'Bob' }]
    : [{ staff_id: ID.staffA, display_name: 'Amy' }]);
  app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const body = { ...requestBody, items: requestBody.items.map(item => ({ ...item, staffSelectionType: 'no_preference', staffId: undefined })) };
  await withServer(async base => assert.equal((await post(base, body)).status, 200));
  const assignments = fixture.state.queries.filter(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql));
  assert.deepEqual(assignments.map(query => query.params[3]), [ID.staffB, ID.staffA]);
});

for (const reverse of [false, true]) {
  test(`${reverse ? 'no-preference + specific' : 'specific + no-preference'} endpoint preserves the specific staff`, async () => {
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    const fixture = makeFixture(null, () => [{ staff_id: ID.staffA, display_name: 'Amy' }, { staff_id: ID.staffB, display_name: 'Bob' }]);
    app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
    const items = requestBody.items.map((item, index) => ({ ...item,
      staffSelectionType: index === (reverse ? 1 : 0) ? 'specific' : 'no_preference',
      staffId: index === (reverse ? 1 : 0) ? ID.staffA : undefined
    }));
    await withServer(async base => assert.equal((await post(base, { ...requestBody, items })).status, 200));
    const assignments = fixture.state.queries.filter(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql));
    assert.equal(assignments[reverse ? 1 : 0].params[3], ID.staffA);
  });
}

for (const code of ['OUTSIDE_WORKING_HOURS', 'STAFF_ON_LEAVE', 'STAFF_SERVICE_NOT_ALLOWED']) {
  test(`multi-service ${code} fails the whole transaction before business writes`, async () => {
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    const fixture = makeFixture(); let calls = 0;
    app.locals.bookingPool = fixture.pool;
    app.locals.bookingValidator = async () => { calls += 1; if (calls === 2) throw new StaffBookabilityError(code); };
    await withServer(async base => { const response = await post(base); assert.equal(response.status, 409); });
    assert.equal(fixture.state.queries.some(query => /^INSERT INTO (customers|appointments|appointment_items|appointment_item_staff_assignments)/.test(query.sql)), false);
    assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
  });
}

test('assignment exclusion 23P01 rolls back every multi-service row and returns safe 409', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(sql => {
    if (!/INSERT INTO appointment_item_staff_assignments/.test(sql)) return null;
    const error = new Error('private constraint detail'); error.code = '23P01'; return error;
  });
  app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  await withServer(async base => { const response = await post(base); const payload = await response.json(); assert.equal(response.status, 409); assert.equal(payload.code, 'BOOKING_NOT_AVAILABLE'); assert.doesNotMatch(JSON.stringify(payload), /private/); });
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('cross-tenant service inventory fails closed', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(); app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  await withServer(async base => {
    const response = await post(base, { ...requestBody, items: [{ ...requestBody.items[0], serviceId: '99999999-9999-4999-8999-999999999999' }] });
    assert.equal(response.status, 400);
  });
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('multi-service write rejects client-supplied shop id before database access', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  let connected = false; app.locals.bookingPool = { connect: async () => { connected = true; throw new Error('must not connect'); } };
  await withServer(async base => assert.equal((await post(base, { ...requestBody, shopId: 'forged' })).status, 400));
  assert.equal(connected, false);
});

test('multi-service availability returns only starts where the whole sequence validates', async () => {
  const fixture = makeFixture(); app.locals.bookingPool = fixture.pool;
  app.locals.bookingValidator = async input => {
    if (input.requestedStartAt === '2030-01-07T02:30:00.000Z') throw new StaffBookabilityError('STAFF_ON_LEAVE');
  };
  await withServer(async base => {
    const response = await fetch(`${base}/api/booking/multi-service-available-times`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopSlug: 'tenant-a', date: '2030-01-07', locale: 'en', items: requestBody.items })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ time: '10:00', startAt: '2030-01-07T02:00:00.000Z' }]);
  });
  const scope = fixture.state.queries.find(query => /SELECT shop\.id AS shop_id/.test(query.sql));
  assert.deepEqual(scope.params, ['tenant-a']);
  assert.equal(fixture.state.queries.filter(query => /assigned_appointment_count/.test(query.sql)).length, 2);
});

test('multi-service availability rejects client-supplied shop id before database access', async () => {
  let connected = false; app.locals.bookingPool = { connect: async () => { connected = true; throw new Error('must not connect'); } };
  await withServer(async base => {
    const response = await fetch(`${base}/api/booking/multi-service-available-times`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopSlug: 'tenant-a', shopId: ID.shop, date: '2030-01-07', items: requestBody.items })
    });
    assert.equal(response.status, 400);
  });
  assert.equal(connected, false);
});

test('startAt-only legacy specific request routes through canonical one-item transaction', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(); app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const { items: _items, ...base } = requestBody;
  const body = { ...base, serviceId: ID.serviceA, staffSelectionType: 'specific', staffId: ID.staffA };
  await withServer(async url => assert.equal((await post(url, body)).status, 200));
  assert.equal(fixture.state.queries.filter(query => /^INSERT INTO appointments/.test(query.sql)).length, 1);
  assert.equal(fixture.state.queries.filter(query => /^INSERT INTO appointment_items/.test(query.sql)).length, 1);
  assert.equal(fixture.state.queries.filter(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql)).length, 1);
  assert.equal(fixture.state.queries.at(-1).sql, 'COMMIT');
});

test('startAt-only legacy no-preference request resolves authoritative staff', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(null, () => [{ staff_id: ID.staffB, display_name: 'Bob', assigned_appointment_count: 0 }]);
  app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const { items: _items, ...base } = requestBody;
  const body = { ...base, serviceId: ID.serviceA, staffSelectionType: 'no_preference' };
  await withServer(async url => assert.equal((await post(url, body)).status, 200));
  const assignment = fixture.state.queries.find(query => /^INSERT INTO appointment_item_staff_assignments/.test(query.sql));
  assert.equal(assignment.params[3], ID.staffB);
});

test('startAt-only legacy cross-tenant service fails closed', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(); app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const { items: _items, ...base } = requestBody;
  await withServer(async url => assert.equal((await post(url, { ...base, serviceId: '99999999-9999-4999-8999-999999999999', staffSelectionType: 'specific', staffId: ID.staffA })).status, 400));
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('startAt-only legacy assignment collision returns safe 409 and rolls back', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makeFixture(sql => { if (!/INSERT INTO appointment_item_staff_assignments/.test(sql)) return null; const error = new Error('collision detail'); error.code = '23P01'; return error; });
  app.locals.bookingPool = fixture.pool; app.locals.bookingValidator = async () => {};
  const { items: _items, ...base } = requestBody;
  await withServer(async url => { const response = await post(url, { ...base, serviceId: ID.serviceA, staffSelectionType: 'specific', staffId: ID.staffA }); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'BOOKING_NOT_AVAILABLE'); });
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});
