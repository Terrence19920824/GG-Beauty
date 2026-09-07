'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  service: '44444444-4444-4444-8444-444444444444',
  staff: '33333333-3333-4333-8333-333333333333'
};

const withServer = async operation => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('tenant-safe staff-options returns only minimal identity and display fields', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM shops AS shop/.test(sql)) return { rows: [{ shop_id: ID.shop, location_id: ID.location }] };
      if (/assigned_appointment_count/.test(sql)) return { rows: [{ staff_id: ID.staff, display_name: 'guanguan', assigned_appointment_count: 0 }] };
      throw new Error('unexpected query');
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/booking/staff-options?shopSlug=tenant-a&serviceId=${ID.service}&shopId=forged&tenantId=forged`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ staffId: ID.staff, displayName: 'guanguan' }]);
  });
  assert.deepEqual(queries[0].params, ['tenant-a']);
  assert.deepEqual(queries[1].params, [ID.shop, ID.location, ID.service, null]);
  assert.match(queries[1].sql, /member\.is_active = TRUE/);
  assert.match(queries[1].sql, /member\.bookable = TRUE/);
  assert.match(queries[1].sql, /service\.is_active = TRUE/);
  assert.match(queries[1].sql, /service\.bookable = TRUE/);
  assert.match(queries[1].sql, /capability\.is_active = TRUE/);
  assert.match(queries[1].sql, /location_assignment\.is_active = TRUE/);
  assert.match(queries[1].sql, /ORDER BY assigned_appointment_count ASC, member\.id ASC/);
  assert.doesNotMatch(JSON.stringify(queries.map(query => query.params)), /forged/);
});

test('staff-options validates service id before opening a database connection', async () => {
  let connected = false;
  app.locals.bookingPool = { connect: async () => { connected = true; throw new Error('must not connect'); } };
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/booking/staff-options?shopSlug=tenant-a&serviceId=bad`);
    assert.equal(response.status, 400);
  });
  assert.equal(connected, false);
});

test('no preference availability returns a slot only when one current candidate passes the shared validator', async () => {
  const staffA = '33333333-3333-4333-8333-aaaaaaaaaaaa';
  const staffB = '33333333-3333-4333-8333-bbbbbbbbbbbb';
  const client = {
    query: async sql => {
      if (/SELECT id\s+FROM shops/.test(sql)) return { rows: [{ id: ID.shop }] };
      if (/SELECT id\s+FROM locations/.test(sql)) return { rows: [{ id: ID.location }] };
      if (/SELECT\s+id,\s+duration_minutes\s+FROM services/.test(sql)) return { rows: [{ id: ID.service, duration_minutes: 60 }] };
      if (/WITH scoped_location/.test(sql)) return { rows: [{ time: '10:00', start_at: '2030-01-07T02:00:00.000000Z', end_at: '2030-01-07T03:00:00.000000Z', has_database_guard_collision: false }] };
      if (/assigned_appointment_count/.test(sql)) return { rows: [{ staff_id: staffA }, { staff_id: staffB }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  const seen = [];
  app.locals.bookingValidator = async input => {
    seen.push(input.staffId);
    if (input.staffId === staffA) {
      const { StaffBookabilityError } = require('../lib/staff-bookability-validator');
      throw new StaffBookabilityError('APPOINTMENT_COLLISION');
    }
  };
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/available-times-db?shopSlug=tenant-a&date=2030-01-07&serviceId=${ID.service}&staffSelectionType=no_preference`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, ['10:00']);
  });
  assert.deepEqual(seen, [staffA, staffB]);
});

test('customer UI removes static Staff 01 and uses staffId plus explicit no preference', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Staff 01/);
  assert.match(html, /\/api\/booking\/staff-options/);
  assert.match(html, /option\.value = member\.staffId/);
  assert.match(html, /staffSelectionType: noPreference \? 'no_preference' : 'specific'/);
  assert.match(html, /\.\.\.\(noPreference \? \{\} : \{ staffId: staffSelection \}\)/);
  assert.doesNotMatch(html, /staff:\s*staffSelection/);
  assert.ok(html.indexOf('id="service"') < html.indexOf('id="staff"'));
  assert.ok(html.indexOf('id="staff"') < html.indexOf('id="date"'));
});

test('shared dictionary contains customer staff choices in both locales', () => {
  const i18n = require('../public/shared-i18n');
  assert.equal(i18n.t('customerStaffNoPreference', 'zh-CN'), '不指定员工');
  assert.equal(i18n.t('customerStaffNoPreference', 'en'), 'No Preference');
  assert.equal(i18n.t('customerStaffNone', 'zh-CN'), '当前没有可预约的员工');
  assert.equal(i18n.t('customerStaffNone', 'en'), 'No staff are currently available');
});
