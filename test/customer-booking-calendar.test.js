'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const calendar = require('../public/customer-booking-calendar');

const customerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('calendar labels are determined only by app locale, not device locale', () => {
  const availability = new Map([
    ['2026-09-12', { hasAvailability: true, earliestStartAt: '2026-09-12T02:00:00Z' }],
    ['2026-09-13', { hasAvailability: false, earliestStartAt: null }]
  ]);
  const english = calendar.monthModel({ monthValue: '2026-09', locale: 'en', availability, today: '2026-09-01' });
  const chinese = calendar.monthModel({ monthValue: '2026-09', locale: 'zh-CN', availability, today: '2026-09-01' });
  assert.equal(english.title, 'September 2026');
  assert.deepEqual(english.weekdays, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.equal(chinese.title, '2026年9月');
  assert.deepEqual(chinese.weekdays, ['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
  assert.equal(english.cells.find(cell => cell?.date === '2026-09-12').available, true);
  assert.equal(english.cells.find(cell => cell?.date === '2026-09-13').available, false);
});

test('calendar month range and navigation are deterministic and bounded by the caller', () => {
  assert.deepEqual(calendar.monthRange('2026-09'), { startDate: '2026-09-01', endDate: '2026-09-30' });
  assert.equal(calendar.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(calendar.shiftMonth('2026-01', -1), '2025-12');
});

test('availability refresh clears an invalid selected date and preserves a valid one', () => {
  const availability = new Map([
    ['2026-09-12', { hasAvailability: true }],
    ['2026-09-13', { hasAvailability: false }]
  ]);
  assert.equal(calendar.reconcileSelectedDate({ selectedDate: '2026-09-12', monthValue: '2026-09', availability }), '2026-09-12');
  assert.equal(calendar.reconcileSelectedDate({ selectedDate: '2026-09-13', monthValue: '2026-09', availability }), '');
});

test('customer page has no native date picker and refreshes canonical availability on cart or staff changes', () => {
  assert.doesNotMatch(customerHtml, /type="date"/);
  assert.match(customerHtml, /customer-booking-calendar\.js/);
  assert.match(customerHtml, /multi-service-available-dates/);
  assert.match(customerHtml, /select\.addEventListener\('change', async \(\) =>/);
  assert.match(customerHtml, /remove\.addEventListener\('click', async/);
  assert.match(customerHtml, /refreshAvailabilityAfterCartChange/);
  assert.match(customerHtml, /dateInput\.value = reconciledDate; selectedSlot = null/);
  assert.match(customerHtml, /nextAvailableDates/);
});

test('locale switching redraws calendar without catalog or availability refetch', () => {
  const setLocaleBody = customerHtml.match(/async function setLocale\(locale\) \{([\s\S]*?)\n\}/)[1];
  assert.match(setLocaleBody, /renderBookingCalendar\(\)/);
  assert.doesNotMatch(setLocaleBody, /loadCustomerCatalogue|loadAvailableDates|loadAvailableTimes|fetch\(/);
});
