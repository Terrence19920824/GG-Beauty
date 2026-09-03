'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  StaffBookabilityError,
  validateStaffBookability
} = require('../lib/staff-bookability-validator');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  service: '44444444-4444-4444-8444-444444444444',
  assignment: '55555555-5555-4555-8555-555555555555'
};

const validRow = () => ({
  location_matches_tenant: true,
  location_active: true,
  location_timezone: 'Asia/Singapore',
  location_timezone_valid: true,
  staff_matches_tenant: true,
  staff_active: true,
  staff_bookable: true,
  service_matches_tenant: true,
  service_active: true,
  service_bookable: true,
  service_name: 'Test Service',
  duration_minutes: 60,
  capability_active: true,
  location_assignment_id: ID.assignment,
  interval_valid: true,
  duration_matches: true,
  weekly_range_count: '1',
  weekly_ranges_overlap: false,
  weekly_interval_contained: true,
  override_count: '0',
  pending_override_count: '0',
  approved_override_count: '0',
  is_day_off: false,
  is_full_day_leave: false,
  has_partial_leave: false,
  partial_leave_overlaps: false,
  has_custom_hours: false,
  uses_working_alias: false,
  custom_interval_contained: false,
  has_collision: false,
  schedule_source: 'weekly',
  effective_work_window: {
    startAt: '2030-01-07T01:00:00.000Z',
    endAt: '2030-01-07T09:00:00.000Z'
  }
});

const inputFor = row => ({
  dbClient: {
    query: async (sql, params) => {
      assert.match(sql, /staff_location_working_hours/);
      assert.match(sql, /staff_schedule_overrides/);
      assert.doesNotMatch(sql, /staff_working_hours/);
      assert.doesNotMatch(sql, /staff_time_off/);
      assert.equal(params.length, 6);
      return { rows: [row] };
    }
  },
  shopId: ID.shop,
  locationId: ID.location,
  staffId: ID.staff,
  serviceId: ID.service,
  requestedStartAt: '2030-01-07T10:00:00.000001+08:00',
  requestedEndAt: '2030-01-07T11:00:00.000001+08:00'
});

const expectCode = async (patch, code) => {
  const row = Object.assign(validRow(), patch);
  await assert.rejects(
    validateStaffBookability(inputFor(row)),
    error =>
      error instanceof StaffBookabilityError && error.code === code
  );
};

test('staff not bookable fails closed', async () => {
  await expectCode({ staff_bookable: false }, 'STAFF_NOT_BOOKABLE');
});

test('service not bookable fails closed', async () => {
  await expectCode({ service_bookable: false }, 'SERVICE_NOT_BOOKABLE');
});

test('missing capability fails closed', async () => {
  await expectCode(
    { capability_active: false },
    'STAFF_SERVICE_NOT_ALLOWED'
  );
});

test('missing location assignment fails closed', async () => {
  await expectCode(
    { location_assignment_id: null },
    'STAFF_LOCATION_NOT_ASSIGNED'
  );
});

test('missing weekly hours fails closed', async () => {
  await expectCode(
    { weekly_range_count: '0', weekly_interval_contained: false },
    'NO_WORKING_HOURS'
  );
});

test('outside weekly hours fails closed', async () => {
  await expectCode(
    { weekly_interval_contained: false },
    'OUTSIDE_WORKING_HOURS'
  );
});

test('day off fails closed', async () => {
  await expectCode(
    { override_count: '1', approved_override_count: '1', is_day_off: true },
    'STAFF_ON_LEAVE'
  );
});

test('full-day leave fails closed', async () => {
  await expectCode(
    {
      override_count: '1',
      approved_override_count: '1',
      is_full_day_leave: true
    },
    'STAFF_ON_LEAVE'
  );
});

test('partial leave overlap fails closed', async () => {
  await expectCode(
    {
      override_count: '1',
      approved_override_count: '1',
      has_partial_leave: true,
      partial_leave_overlaps: true
    },
    'STAFF_ON_LEAVE'
  );
});

test('inside custom hours passes', async () => {
  const row = validRow();
  Object.assign(row, {
    override_count: '1',
    approved_override_count: '1',
    has_custom_hours: true,
    custom_interval_contained: true,
    schedule_source: 'override'
  });
  const result = await validateStaffBookability(inputFor(row));
  assert.equal(result.scheduleSource, 'override');
  assert.equal(result.durationMinutes, 60);
});

test('outside custom hours fails closed', async () => {
  await expectCode(
    {
      override_count: '1',
      approved_override_count: '1',
      has_custom_hours: true,
      custom_interval_contained: false
    },
    'OUTSIDE_WORKING_HOURS'
  );
});

test('pending override fails closed', async () => {
  await expectCode(
    { override_count: '1', pending_override_count: '1' },
    'SCHEDULE_OVERRIDE_PENDING'
  );
});

test('appointment collision fails closed', async () => {
  await expectCode(
    { has_collision: true },
    'APPOINTMENT_COLLISION'
  );
});

test('normal weekly schedule passes', async () => {
  const result = await validateStaffBookability(inputFor(validRow()));
  assert.deepEqual(
    {
      shopId: result.shopId,
      timezone: result.locationTimezone,
      serviceName: result.serviceName,
      assignmentId: result.locationAssignmentId,
      scheduleSource: result.scheduleSource
    },
    {
      shopId: ID.shop,
      timezone: 'Asia/Singapore',
      serviceName: 'Test Service',
      assignmentId: ID.assignment,
      scheduleSource: 'weekly'
    }
  );
});

test('cross-tenant identifiers fail closed without existence detail', async () => {
  await expectCode(
    {
      location_matches_tenant: false,
      staff_matches_tenant: false,
      service_matches_tenant: false
    },
    'BOOKABILITY_SCOPE_INVALID'
  );
});

test('invalid location timezone fails closed', async () => {
  await expectCode(
    {
      location_timezone: null,
      location_timezone_valid: false
    },
    'BOOKABILITY_SCOPE_INVALID'
  );
});

test('overlapping weekly ranges fail closed', async () => {
  await expectCode(
    { weekly_range_count: '2', weekly_ranges_overlap: true },
    'SCHEDULE_CONFIGURATION_INVALID'
  );
});

test('working override is accepted only through custom-hours semantics', async () => {
  const row = validRow();
  Object.assign(row, {
    override_count: '1',
    approved_override_count: '1',
    has_custom_hours: true,
    uses_working_alias: true,
    custom_interval_contained: true,
    schedule_source: 'override'
  });
  const result = await validateStaffBookability(inputFor(row));
  assert.equal(result.scheduleSource, 'override');
});
