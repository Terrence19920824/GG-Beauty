'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../public/shared-i18n');

const root = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public/admin-self-service.js'), 'utf8');
const customerHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('browser locale detection and manual locale precedence follow the shared rules', () => {
  assert.equal(i18n.detectBrowserLocale({ languages: ['zh-SG', 'en'] }), 'zh-CN');
  assert.equal(i18n.detectBrowserLocale({ language: 'en-SG' }), 'en');
  assert.equal(i18n.getStoredLocale({ getItem: () => 'en' }, { languages: ['zh-CN'] }), 'en');
});

test('owner calendar has translated navigation, summaries, table, statuses and actions', () => {
  for (const key of ['calendar', 'allAppointments', 'pendingAppointments', 'todayAppointments', 'appointmentTime', 'customerName', 'phone', 'service', 'staff', 'status', 'actions', 'confirm', 'complete', 'cancel']) {
    assert.notEqual(i18n.t(key, 'zh-CN'), key);
    assert.notEqual(i18n.t(key, 'en'), key);
  }
  assert.match(adminHtml, /data-i18n="allAppointments"/);
  assert.match(adminHtml, /adminT\('appointmentTime'\)/);
  assert.match(adminHtml, /formatStatus\(status/);
});

test('owner staff, weekly schedule and overrides have complete bilingual keys', () => {
  for (const key of ['basicDetails', 'staffName', 'staffCode', 'phone', 'email', 'allowBooking', 'staffActive', 'capabilities', 'locations', 'weeklySchedule', 'specialDates', 'saveCapabilities', 'saveLocations', 'saveSchedule', 'addSpecialDate', 'monday', 'sunday', 'working', 'dayOff', 'leave', 'customHours', 'startTime', 'endTime', 'notesOptional', 'noOverrides']) {
    assert.notEqual(i18n.t(key, 'zh-CN'), key);
    assert.notEqual(i18n.t(key, 'en'), key);
  }
  assert.doesNotMatch(adminJs, /[\u3400-\u9fff]/);
});

test('owner services has bilingual system labels while service names remain API business data', () => {
  for (const key of ['chineseName', 'englishName', 'chineseDescription', 'englishDescription', 'category', 'price', 'startingPrice', 'durationMinutes', 'allowBooking', 'serviceActive', 'addService', 'save']) {
    assert.match(adminHtml, new RegExp(`data-i18n="${key}"`));
  }
  assert.match(adminJs, /t\('edit'\)/);
  assert.match(adminJs, /escapeHtml\(bilingualName\)/);
  assert.match(adminJs, /escapeHtml\(staff\.name\)/);
});

test('customer uses the shared locale and translation keys without changing serviceId identity', () => {
  assert.match(customerHtml, /src="\/shared-i18n\.js"/);
  assert.match(customerHtml, /globalThis\.ggI18n/);
  assert.match(customerHtml, /serviceId: service\.id/);
  assert.doesNotMatch(customerHtml, /service:\s*service\.name/);
});

test('shared locale persistence cannot store authentication material and database enums stay canonical', () => {
  const frontend = `${adminHtml}\n${adminJs}\n${customerHtml}\n${fs.readFileSync(path.join(root, 'public/shared-i18n.js'), 'utf8')}`;
  assert.equal(i18n.STORAGE_KEY, 'gg_beauty_locale');
  assert.doesNotMatch(frontend, /localStorage[^\n]*(token|session|auth|password)|(token|session|auth|password)[^\n]*localStorage/i);
  assert.match(adminHtml, /updateAppointmentStatus\('\$\{item\.id\}', 'confirmed'\)/);
  assert.match(adminHtml, /updateAppointmentStatus\('\$\{item\.id\}', 'completed'\)/);
  assert.match(adminHtml, /updateAppointmentStatus\('\$\{item\.id\}', 'cancelled'\)/);
});
