'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BUSINESS_HOURS_SOURCE,
  DEFAULT_BUSINESS_WINDOWS,
  isIntervalWithinWorkingWindows,
  resolveEffectiveSchedule
} = require('../lib/staff-effective-schedule');

test('default business hours fallback is strictly 10:00-21:00 with source marked fallback', () => {
  assert.deepEqual(DEFAULT_BUSINESS_WINDOWS, [{ start: '10:00', end: '21:00' }]);
  assert.equal(DEFAULT_BUSINESS_HOURS_SOURCE, 'fallback');
});

const base = (patch = {}) => ({
  staff: { id: 'staff-1', is_active: true, bookable: true },
  assignmentActive: true,
  date: '2030-01-07',
  timezone: 'Asia/Singapore',
  businessWindows: DEFAULT_BUSINESS_WINDOWS,
  businessHoursSource: DEFAULT_BUSINESS_HOURS_SOURCE,
  workingHours: [{
    day_of_week: 1,
    start_time: '10:00:00',
    end_time: '18:00:00',
    effective_from: null,
    effective_to: null,
    is_active: true
  }],
  overrides: [],
  ...patch
});

const approvedOverride = patch => ({
  schedule_date: '2030-01-07',
  approval_status: 'approved',
  is_active: true,
  ...patch
});

test('full-day weekly shift resolves to a working window', () => {
  const result = resolveEffectiveSchedule(base());
  assert.equal(result.status, 'working');
  assert.deepEqual(result.workingWindows, [{ start: '10:00', end: '18:00' }]);
  assert.equal(result.reason, 'WEEKLY_HOURS');
  assert.equal(result.source, 'weekly+fallback');
});

test('staff working 09:00-12:00 clips to start at 10:00 with fallback business hours', () => {
  const result = resolveEffectiveSchedule(base({
    workingHours: [{ day_of_week: 1, start_time: '09:00', end_time: '12:00', is_active: true }]
  }));
  assert.equal(result.status, 'working');
  assert.deepEqual(result.workingWindows, [{ start: '10:00', end: '12:00' }]);
  assert.equal(result.source, 'weekly+fallback');
  assert.equal(isIntervalWithinWorkingWindows({ start: '09:00', end: '10:00', workingWindows: result.workingWindows }), false);
  assert.equal(isIntervalWithinWorkingWindows({ start: '09:30', end: '10:30', workingWindows: result.workingWindows }), false);
  assert.equal(isIntervalWithinWorkingWindows({ start: '10:00', end: '11:00', workingWindows: result.workingWindows }), true);
  assert.equal(isIntervalWithinWorkingWindows({ start: '11:00', end: '12:00', workingWindows: result.workingWindows }), true);
});

test('staff working 20:00-22:00 clips to not exceed 21:00 with fallback business hours', () => {
  const result = resolveEffectiveSchedule(base({
    workingHours: [{ day_of_week: 1, start_time: '20:00', end_time: '22:00', is_active: true }]
  }));
  assert.equal(result.status, 'working');
  assert.deepEqual(result.workingWindows, [{ start: '20:00', end: '21:00' }]);
  assert.equal(result.source, 'weekly+fallback');
  assert.equal(isIntervalWithinWorkingWindows({ start: '20:00', end: '21:00', workingWindows: result.workingWindows }), true);
  assert.equal(isIntervalWithinWorkingWindows({ start: '20:30', end: '21:30', workingWindows: result.workingWindows }), false);
  assert.equal(isIntervalWithinWorkingWindows({ start: '21:00', end: '22:00', workingWindows: result.workingWindows }), false);
});

test('10:00-12:00 short shift only exposes that interval', () => {
  const result = resolveEffectiveSchedule(base({
    workingHours: [{ day_of_week: 1, start_time: '10:00', end_time: '12:00', is_active: true }]
  }));
  assert.deepEqual(result.workingWindows, [{ start: '10:00', end: '12:00' }]);
  assert.equal(isIntervalWithinWorkingWindows({ start: '10:30', end: '11:30', workingWindows: result.workingWindows }), true);
  assert.equal(isIntervalWithinWorkingWindows({ start: '11:30', end: '12:30', workingWindows: result.workingWindows }), false);
});

test('split shifts remain separate continuous booking windows', () => {
  const result = resolveEffectiveSchedule(base({
    workingHours: [
      { day_of_week: 1, start_time: '10:00', end_time: '12:00', is_active: true },
      { day_of_week: 1, start_time: '14:00', end_time: '18:00', is_active: true }
    ]
  }));
  assert.deepEqual(result.workingWindows, [
    { start: '10:00', end: '12:00' },
    { start: '14:00', end: '18:00' }
  ]);
  assert.equal(isIntervalWithinWorkingWindows({ start: '11:30', end: '14:30', workingWindows: result.workingWindows }), false);
});

test('partial leave subtracts only the overlapping period', () => {
  const result = resolveEffectiveSchedule(base({
    overrides: [approvedOverride({ override_type: 'leave', start_time: '12:00', end_time: '13:00' })]
  }));
  assert.equal(result.status, 'working');
  assert.equal(result.source, 'weekly_with_leave+fallback');
  assert.deepEqual(result.workingWindows, [
    { start: '10:00', end: '12:00' },
    { start: '13:00', end: '18:00' }
  ]);
});

test('day_off and full-day leave both resolve to off_day', () => {
  const dayOff = resolveEffectiveSchedule(base({
    overrides: [approvedOverride({ override_type: 'day_off', start_time: null, end_time: null })]
  }));
  const leave = resolveEffectiveSchedule(base({
    overrides: [approvedOverride({ override_type: 'leave', start_time: null, end_time: null })]
  }));
  assert.equal(dayOff.status, 'off_day');
  assert.equal(dayOff.reason, 'DAY_OFF');
  assert.equal(leave.status, 'off_day');
  assert.equal(leave.reason, 'FULL_DAY_LEAVE');
});

test('custom_hours replaces weekly hours', () => {
  const result = resolveEffectiveSchedule(base({
    overrides: [approvedOverride({ override_type: 'custom_hours', start_time: '11:00', end_time: '15:00' })]
  }));
  assert.equal(result.status, 'working');
  assert.deepEqual(result.workingWindows, [{ start: '11:00', end: '15:00' }]);
});

test('staff hours are clipped by business hours', () => {
  const early = resolveEffectiveSchedule(base({
    workingHours: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00', is_active: true }],
    businessWindows: [{ start: '10:00', end: '20:00' }]
  }));
  assert.deepEqual(early.workingWindows, [{ start: '10:00', end: '18:00' }]);

  const late = resolveEffectiveSchedule(base({
    workingHours: [{ day_of_week: 1, start_time: '12:00', end_time: '22:00', is_active: true }],
    businessWindows: [{ start: '10:00', end: '20:00' }]
  }));
  assert.deepEqual(late.workingWindows, [{ start: '12:00', end: '20:00' }]);
});

test('pending and invalid schedule configurations fail closed', () => {
  const pending = resolveEffectiveSchedule(base({
    overrides: [{
      schedule_date: '2030-01-07',
      approval_status: 'pending',
      override_type: 'custom_hours',
      start_time: '10:00',
      end_time: '12:00',
      is_active: true
    }]
  }));
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.workingWindows, []);

  const invalid = resolveEffectiveSchedule(base({
    workingHours: [
      { day_of_week: 1, start_time: '09:00', end_time: '13:00', is_active: true },
      { day_of_week: 1, start_time: '12:00', end_time: '17:00', is_active: true }
    ]
  }));
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual(invalid.workingWindows, []);
});

test('inactive, bookable=false, and missing assignment fail closed', () => {
  assert.equal(resolveEffectiveSchedule(base({ staff: { is_active: false, bookable: true } })).reason, 'STAFF_INACTIVE');
  assert.equal(resolveEffectiveSchedule(base({ staff: { is_active: true, bookable: false } })).reason, 'STAFF_NOT_BOOKABLE');
  assert.equal(resolveEffectiveSchedule(base({ assignmentActive: false })).reason, 'STAFF_LOCATION_NOT_ASSIGNED');
});
