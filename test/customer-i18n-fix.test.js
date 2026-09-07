'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../public/shared-i18n');

const customerHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

test('customer appointment date uses locale-aware shared formatting', () => {
  assert.equal(i18n.formatDate('2026-09-09', 'zh-CN'), '2026年9月9日');
  assert.equal(i18n.formatDate('2026-09-09', 'en'), 'Sep 9, 2026');
  assert.equal(i18n.formatDate('invalid', 'en'), '');
  assert.match(customerHtml, /localeApi\.formatDate\(dateInput\.value, currentLocale\)/);
  assert.match(customerHtml, /localeApi\.formatDate\(date, currentLocale\)/);
});

test('customer empty-time message comes from the bilingual shared dictionary', () => {
  assert.equal(i18n.t('noTimes', 'zh-CN'), '当天暂无可预约时间');
  assert.equal(i18n.t('noTimes', 'en'), 'No available times on this date.');
  assert.match(customerHtml, /customerT\('noTimes'\)/);
  assert.doesNotMatch(customerHtml, /当天暂无可预约时间/);
});

test('customer date presentation preserves canonical ISO booking value', () => {
  assert.match(customerHtml, /email,\s*date,\s*time/);
  assert.doesNotMatch(customerHtml, /date:\s*localeApi\.formatDate/);
});
