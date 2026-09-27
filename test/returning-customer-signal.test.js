'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'calendar-shared.css'), 'utf8');
const i18n = require('../public/shared-i18n');

test('returning customer is an owner-query recipient-scoped server projection', () => {
  assert.match(server, /previous\.shop_id = a\.shop_id/);
  assert.match(server, /previous\.recipient_customer_id = a\.recipient_customer_id/);
  assert.match(server, /previous\.status IN \('arrived', 'in_service', 'completed'\)/);
  assert.match(server, /previous\.start_at < a\.start_at/);
  assert.match(server, /previous\.id <> a\.id/);
  assert.doesNotMatch(server.slice(server.indexOf("/api/staff/appointments")), /is_returning_customer/);
});
test('calendar heart is localized, accessible, and hidden before compact-card content regresses', () => {
  assert.match(admin, /item\.is_returning_customer === true/);
  assert.match(admin, /calendar-card-returning-signal/);
  assert.match(admin, /role="img"/);
  assert.match(admin, /❤️/);
  for (const size of ['is-compact', 'is-short', 'is-ultra-short']) assert.match(css, new RegExp(`owner-calendar-appointment\\.${size} \\.calendar-card-returning-signal`));
  assert.equal(i18n.t('returningCustomer', 'zh-CN'), '回头客');
  assert.equal(i18n.t('returningCustomer', 'en'), 'Returning customer');
});
