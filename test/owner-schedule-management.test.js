'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111', membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333', shopB: '44444444-4444-4444-8444-444444444444',
  staffA: '55555555-5555-4555-8555-555555555555', staffB: '66666666-6666-4666-8666-666666666666',
  locationA: '77777777-7777-4777-8777-777777777777', locationB: '88888888-8888-4888-8888-888888888888',
  hour: '99999999-9999-4999-8999-999999999999', override: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};

const sessionRow = role => ({ owner_account_id: ID.account, membership_id: ID.membership, shop_id: ID.shopA, login_identifier: 'owner', display_name: 'Owner', role, shop_slug: 'shop-a', shop_name: 'Shop A' });

const makePool = ({ role = 'owner', validSession = true, scopeValid = true, futureConflict = false, futureStatus = null, futureRole = 'primary', dbError = false, rowMismatch = false, staffBookable = false } = {}) => {
  const state = {
    staffBookable,
    hours: [{ id: ID.hour, day_of_week: 1, start_time: '10:00:00', end_time: '19:00:00', is_active: true }],
    overrides: [], queries: [], releases: 0, committed: false, rolledBack: false, snapshot: null,
    appointmentWrites: 0, capabilityWrites: 0
  };
  const client = { async query(sql, params = []) {
    const q = sql.trim(); state.queries.push({ sql: q, params });
    if (q === 'BEGIN') { state.snapshot = structuredClone({ hours: state.hours, overrides: state.overrides }); return { rows: [] }; }
    if (q === 'COMMIT') { state.committed = true; return { rows: [] }; }
    if (q === 'ROLLBACK') { state.hours = state.snapshot.hours; state.overrides = state.snapshot.overrides; state.rolledBack = true; return { rows: [] }; }
    if (/^SET LOCAL/.test(q)) return { rows: [] };
    if (dbError) throw Object.assign(new Error('private SQL'), { code: 'XX000' });
    if (/^(UPDATE|INSERT|DELETE).*appointment/im.test(q)) state.appointmentWrites++;
    if (/^(UPDATE|INSERT|DELETE).*staff_services/im.test(q)) state.capabilityWrites++;
    if (/SELECT location\.id AS location_id/.test(q)) {
      const valid = scopeValid && params[0] === ID.shopA && params[1] === ID.staffA && params[2] === ID.locationA;
      return { rows: valid ? [{ location_id: ID.locationA, timezone: 'Asia/Singapore' }] : [] };
    }
    if (/^SELECT day_of_week, start_time, end_time/.test(q)) return { rows: state.hours.filter(h => h.is_active).map(h => ({ day_of_week: h.day_of_week, start_time: h.start_time, end_time: h.end_time, effective_from: h.effective_from, effective_to: h.effective_to })) };
    if (/^SELECT id, day_of_week, start_time/.test(q)) return { rows: structuredClone(state.hours) };
    if (/^SELECT item\.id/.test(q)) {
      const conflicts = futureConflict || (['pending', 'confirmed'].includes(futureStatus) && ['primary', 'assistant'].includes(futureRole));
      return { rows: conflicts ? [{ id: 'future' }] : [] };
    }
    if (/^UPDATE staff_location_working_hours SET start_time/.test(q)) {
      const row = state.hours.find(h => h.id === params[2]); if (!row) return { rows: [] };
      row.start_time = params[0]; row.end_time = params[1]; row.is_active = true;
      return { rows: rowMismatch ? [] : [{ id: row.id }] };
    }
    if (/^INSERT INTO staff_location_working_hours/.test(q)) {
      const row = { id: `hour-${params[3]}`, day_of_week: params[3], start_time: params[4], end_time: params[5], is_active: true };
      state.hours.push(row); return { rows: rowMismatch ? [] : [{ id: row.id }] };
    }
    if (/^UPDATE staff_location_working_hours SET is_active=FALSE/.test(q)) {
      const rows = []; for (const h of state.hours) if (params[3].includes(h.id)) { h.is_active = false; rows.push({ id: h.id }); }
      return { rows: rowMismatch ? [] : rows };
    }
    if (/^SELECT id FROM staff WHERE/.test(q)) return { rows: params[0] === ID.staffA && params[1] === ID.shopA ? [{ id: ID.staffA }] : [] };
    if (/^SELECT override\.id/.test(q)) return { rows: state.overrides.map(o => ({ ...o, location_name: 'Main', timezone: 'Asia/Singapore' })) };
    if (/^INSERT INTO staff_schedule_overrides/.test(q)) {
      const row = { id: ID.override, location_id: params[1], schedule_date: params[3], override_type: params[4], start_time: params[5], end_time: params[6], reason: params[7], created_by: params[8], approval_status: 'approved', is_active: true, created_at: '2030-01-01', updated_at: '2030-01-01' };
      state.overrides.push(row); return { rows: rowMismatch ? [] : [row] };
    }
    if (/^SELECT override\.\*, location\.timezone/.test(q)) {
      const row = state.overrides.find(o => o.id === params[0]);
      return { rows: row && params[1] === ID.staffA && params[2] === ID.shopA ? [{ ...row, shop_id: ID.shopA, staff_id: ID.staffA, timezone: 'Asia/Singapore' }] : [] };
    }
    if (/^UPDATE staff_schedule_overrides SET/.test(q)) {
      const row = state.overrides.find(o => o.id === params[7]); if (!row) return { rows: [] };
      Object.assign(row, { schedule_date: params[0], override_type: params[1], start_time: params[2], end_time: params[3], reason: params[4], approval_status: params[5], is_active: params[6] });
      return { rows: rowMismatch ? [] : [row] };
    }
    throw new Error(`Unexpected SQL: ${q}`);
  }, release() { state.releases++; } };
  return { state, pool: { async query(sql) { if (/FROM owner_sessions/.test(sql)) return { rows: validSession ? [sessionRow(role)] : [] }; throw new Error('Unexpected auth SQL'); }, async connect() { return client; } } };
};

const withServer = async fn => { const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r, j) => server.close(e => e ? j(e) : r())); } };
const run = (fixture, path, { method = 'GET', body, authenticated = true, headers = {} } = {}) => { app.locals.ownerAuthPool = fixture.pool; return withServer(base => fetch(`${base}${path}`, { method, headers: { ...(authenticated ? { cookie: 'gg_beauty_owner_session=token' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })); };
const weekly = (days = [{ dayOfWeek: 1, isWorking: true, startTime: '09:00', endTime: '18:00' }]) => ({ locationId: ID.locationA, days });
const override = (overrideType, extra = {}) => ({ locationId: ID.locationA, scheduleDate: '2030-05-20', overrideType, ...extra });

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may GET weekly schedule and overrides`, async () => {
    const f = makePool({ role });
    const schedule = await run(f, `/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationA}`);
    assert.equal(schedule.status, 200); const data = (await schedule.json()).data;
    assert.equal(data.timezone, 'Asia/Singapore'); assert.equal(data.days.length, 7); assert.equal(data.days[0].dayOfWeek, 1);
    const overrides = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides?locationId=${ID.locationA}`);
    assert.equal(overrides.status, 200);
  });
}

for (const role of ['owner', 'manager']) {
  test(`${role} may PUT weekly and POST/PATCH override`, async () => {
    const f = makePool({ role });
    assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() })).status, 200);
    const created = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body: override('day_off') });
    assert.equal(created.status, 201); assert.equal((await created.json()).data.approval_status, 'approved');
    assert.equal(f.state.overrides[0].created_by, ID.account);
    assert.notEqual(f.state.overrides[0].created_by, null);
    const insert = f.state.queries.find(query => /^INSERT INTO staff_schedule_overrides/.test(query.sql));
    assert.equal(insert.params[0], ID.shopA);
    assert.equal(insert.params[8], ID.account);
    const patched = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides/${ID.override}`, { method: 'PATCH', body: { isActive: false } });
    assert.equal(patched.status, 200);
  });
}

test('admin schedule mutations return 403', async () => {
  const f = makePool({ role: 'admin' });
  for (const [method, path, body] of [['PUT', `/api/owner/staff/${ID.staffA}/schedule`, weekly()], ['POST', `/api/owner/staff/${ID.staffA}/schedule-overrides`, override('day_off')], ['PATCH', `/api/owner/staff/${ID.staffA}/schedule-overrides/${ID.override}`, { isActive: false }]]) {
    assert.equal((await run(f, path, { method, body })).status, 403);
  }
  assert.equal(f.state.queries.length, 0);
});

test('unauthenticated and invalid owner sessions fail closed', async () => {
  for (const authenticated of [false, true]) { const f = makePool({ validSession: authenticated ? false : true }); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationA}`, { authenticated })).status, 401); assert.equal(f.state.queries.length, 0); }
});

test('cross-tenant staff and location are blocked for reads and writes', async () => {
  for (const [path, method, body] of [[`/api/owner/staff/${ID.staffB}/schedule?locationId=${ID.locationA}`, 'GET'], [`/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationB}`, 'GET'], [`/api/owner/staff/${ID.staffA}/schedule`, 'PUT', { ...weekly(), locationId: ID.locationB }], [`/api/owner/staff/${ID.staffA}/schedule-overrides`, 'POST', { ...override('day_off'), locationId: ID.locationB }]]) {
    const f = makePool({ scopeValid: false }); const response = await run(f, path, { method, body }); assert.equal(response.status, 404);
  }
});

test('client shop/timezone injection cannot change trusted scope', async () => {
  const f = makePool();
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationA}&shopId=${ID.shopB}&timezone=UTC`, { headers: { 'x-shop-id': ID.shopB } });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.timezone, 'Asia/Singapore');
  const scope = f.state.queries[0]; assert.equal(scope.params[0], ID.shopA);
});

test('weekly replacement updates, inserts, and soft-deactivates atomically', async () => {
  const f = makePool();
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly([{ dayOfWeek: 1, isWorking: true, startTime: '08:00', endTime: '17:00' }, { dayOfWeek: 2, isWorking: true, startTime: '10:00', endTime: '18:00' }, { dayOfWeek: 3, isWorking: false }]) });
  assert.equal(response.status, 200); assert.equal(f.state.committed, true);
  assert.equal(f.state.hours.find(h => h.day_of_week === 1).start_time, '08:00'); assert.equal(f.state.hours.find(h => h.day_of_week === 2).is_active, true);
  assert.doesNotMatch(f.state.queries.map(q => q.sql).join('\n'), /DELETE FROM staff_location_working_hours/i);
});

test('empty weekly replacement soft-deactivates all days', async () => {
  const f = makePool(); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly([]) })).status, 200); assert.equal(f.state.hours[0].is_active, false);
});

test('GET weekly fails closed for multiple active intervals on one day', async () => {
  const f = makePool();
  f.state.hours.push({ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', day_of_week: 1, start_time: '20:00:00', end_time: '21:00:00', is_active: true });
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationA}`);
  assert.equal(response.status, 409);
});

test('GET weekly fails closed for effective-dated schedule not representable by weekly API', async () => {
  const f = makePool();
  f.state.hours[0].effective_from = '2030-01-01';
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule?locationId=${ID.locationA}`);
  assert.equal(response.status, 409);
});

test('inactive location assignment rejects schedule', async () => {
  const f = makePool({ scopeValid: false }); const before = structuredClone(f.state.hours);
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() }); assert.equal(response.status, 404); assert.deepEqual(f.state.hours, before); assert.equal(f.state.rolledBack, true);
});

const invalidWeekly = [
  { locationId: 'bad', days: [] }, weekly([{ dayOfWeek: 0, isWorking: false }]), weekly([{ dayOfWeek: 1, isWorking: false }, { dayOfWeek: 1, isWorking: false }]),
  weekly([{ dayOfWeek: 1, isWorking: true, startTime: '19:00', endTime: '10:00' }]), weekly([{ dayOfWeek: 1, isWorking: true, startTime: '10:00', endTime: '10:00' }]),
  weekly([{ dayOfWeek: 1, isWorking: true, startTime: '25:00', endTime: '26:00' }]), weekly([{ dayOfWeek: 1, isWorking: false, startTime: '10:00' }])
];
for (const body of invalidWeekly) test('invalid weekly input returns 400 before transaction', async () => { const f = makePool(); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body })).status, 400); assert.equal(f.state.queries.length, 0); });

test('staff bookable=false may still configure schedule', async () => { const f = makePool({ staffBookable: false }); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() })).status, 200); });

for (const typeBody of [override('day_off'), override('leave'), override('leave', { startTime: '12:00', endTime: '14:00' }), override('custom_hours', { startTime: '11:00', endTime: '16:00' })]) {
  test(`${typeBody.overrideType} canonical override succeeds`, async () => { const f = makePool(); const r = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body: typeBody }); assert.equal(r.status, 201); assert.equal(f.state.overrides[0].approval_status, 'approved'); assert.equal(f.state.overrides[0].created_by, ID.account); });
}

const invalidOverrides = [override('working', { startTime: '10:00', endTime: '18:00' }), override('day_off', { startTime: '10:00' }), override('leave', { startTime: '20:00', endTime: '10:00' }), override('custom_hours', { startTime: '10:00', endTime: '10:00' }), { ...override('day_off'), scheduleDate: '2030-02-30' }, { ...override('day_off'), shop_id: ID.shopB }];
for (const body of invalidOverrides) test('invalid override input returns 400', async () => { const f = makePool(); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body })).status, 400); });

for (const status of ['pending', 'confirmed']) {
  for (const role of ['primary', 'assistant']) test(`future ${status} ${role} conflict rolls schedule back with 409`, async () => { const f = makePool({ futureStatus: status, futureRole: role }); const before = structuredClone(f.state.hours); const r = await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly([]) }); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'SCHEDULE_CONFLICTS_WITH_FUTURE_APPOINTMENTS'); assert.deepEqual(f.state.hours, before); assert.equal(f.state.rolledBack, true); const conflictQuery = f.state.queries.find(q => /^SELECT item\.id/.test(q.sql)); assert.match(conflictQuery.sql, /appointment\.status IN \('pending', 'confirmed'\)/); assert.match(conflictQuery.sql, /item_assignment\.role IN \('primary', 'assistant'\)/); });
}

test('future conflict rolls override creation back with 409', async () => { const f = makePool({ futureConflict: true }); const r = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body: override('day_off') }); assert.equal(r.status, 409); assert.deepEqual(f.state.overrides, []); assert.equal(f.state.rolledBack, true); });

test('future conflict rolls override PATCH back with 409', async () => {
  const f = makePool();
  await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body: override('custom_hours', { startTime: '09:00', endTime: '19:00' }) });
  const before = structuredClone(f.state.overrides);
  f.state.committed = false;
  const originalQuery = f.pool.connect;
  const client = await originalQuery();
  const baseQuery = client.query.bind(client);
  client.query = async (sql, params) => /^SELECT item\.id/.test(sql.trim()) ? { rows: [{ id: 'future' }] } : baseQuery(sql, params);
  const response = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides/${ID.override}`, { method: 'PATCH', body: { overrideType: 'day_off', startTime: null, endTime: null } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SCHEDULE_CONFLICTS_WITH_FUTURE_APPOINTMENTS');
  assert.deepEqual(f.state.overrides, before);
  assert.equal(f.state.rolledBack, true);
});

for (const historical of ['completed', 'cancelled']) test(`${historical} appointments do not block schedule changes`, async () => { const f = makePool({ futureStatus: historical }); assert.equal((await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() })).status, 200); });

test('override PATCH normalizes DB times, remains tenant scoped, and soft-deactivates', async () => { const f = makePool(); await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides`, { method: 'POST', body: override('custom_hours', { startTime: '10:00', endTime: '18:00' }) }); f.state.overrides[0].start_time = '10:00:00'; f.state.overrides[0].end_time = '18:00:00'; const r = await run(f, `/api/owner/staff/${ID.staffA}/schedule-overrides/${ID.override}`, { method: 'PATCH', body: { isActive: false } }); assert.equal(r.status, 200); assert.equal(f.state.overrides[0].is_active, false); assert.doesNotMatch(f.state.queries.map(q => q.sql).join('\n'), /DELETE FROM staff_schedule_overrides/i); });

test('cross-tenant override PATCH returns 404 and rolls back', async () => { const f = makePool(); const r = await run(f, `/api/owner/staff/${ID.staffB}/schedule-overrides/${ID.override}`, { method: 'PATCH', body: { isActive: false } }); assert.equal(r.status, 404); assert.equal(f.state.rolledBack, true); });

test('rowcount mismatch and DB error roll back safely', async () => {
  for (const options of [{ rowMismatch: true }, { dbError: true }]) { const f = makePool(options); const original = console.error; console.error = () => {}; try { const r = await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() }); assert.equal(r.status, 500); } finally { console.error = original; } assert.equal(f.state.rolledBack, true); assert.equal(f.state.releases, 1); }
});

test('schedule mutations use canonical tables and never mutate appointments or capabilities', async () => { const f = makePool(); await run(f, `/api/owner/staff/${ID.staffA}/schedule`, { method: 'PUT', body: weekly() }); const sql = f.state.queries.map(q => q.sql).join('\n'); assert.doesNotMatch(sql, /staff_working_hours|staff_time_off/); assert.equal(f.state.appointmentWrites, 0); assert.equal(f.state.capabilityWrites, 0); });
