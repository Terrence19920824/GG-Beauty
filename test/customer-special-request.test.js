'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCustomerSpecialRequest } = require('../server');

test('customer special request normalizes omitted, null, whitespace, and trimmed text', () => {
  assert.equal(normalizeCustomerSpecialRequest({}), null);
  assert.equal(normalizeCustomerSpecialRequest({ customerSpecialRequest: null }), null);
  assert.equal(normalizeCustomerSpecialRequest({ customerSpecialRequest: '  \n\t ' }), null);
  assert.equal(normalizeCustomerSpecialRequest({ customerSpecialRequest: '  Sensitive scalp  ' }), 'Sensitive scalp');
});

test('customer special request accepts exactly 1000 characters and rejects invalid values', () => {
  assert.equal(normalizeCustomerSpecialRequest({ customerSpecialRequest: 'x'.repeat(1000) }).length, 1000);
  assert.throws(() => normalizeCustomerSpecialRequest({ customerSpecialRequest: 'x'.repeat(1001) }), error => error.code === 'CUSTOMER_SPECIAL_REQUEST_TOO_LONG' && error.status === 400);
  assert.throws(() => normalizeCustomerSpecialRequest({ customerSpecialRequest: 1 }), error => error.code === 'CUSTOMER_SPECIAL_REQUEST_INVALID' && error.status === 400);
});

test('request text is kept as inert plain text by the drawer and never inserted into calendar markup', () => {
  const admin = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(admin, /drawerElement\('div', 'drawer-notes-box notranslate', customerSpecialRequest\)/);
  assert.match(admin, /const specialRequestBadgeHtml = hasCustomerSpecialRequest/);
  assert.match(admin, /calendar-card-special-request-badge">\$\{escapeHtml\(adminT\('specialRequest'\)\)\}<\/span>/);
});

test('schema is additive, bounded, verified read-only, and rollback refuses meaningful data loss', () => {
  const migrations = path.resolve(__dirname, '..', 'migrations');
  const preflight = fs.readFileSync(path.join(migrations, '072_customer_special_request_preflight_readonly.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(migrations, '073_customer_special_request_schema.sql'), 'utf8');
  const verify = fs.readFileSync(path.join(migrations, '074_customer_special_request_verification_readonly.sql'), 'utf8');
  const rollback = fs.readFileSync(path.join(migrations, 'rollback', '073_customer_special_request_rollback.sql'), 'utf8');
  assert.match(preflight, /^BEGIN TRANSACTION READ ONLY;/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS customer_special_request TEXT NULL/);
  assert.match(schema, /char_length\(customer_special_request\) <= 1000/);
  assert.match(verify, /^BEGIN TRANSACTION READ ONLY;/);
  assert.doesNotMatch(verify, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(rollback, /length\(trim\(customer_special_request\)\) > 0/);
  assert.match(rollback, /RAISE EXCEPTION/);
});

test('only authenticated owner projection receives the field; public and staff projections do not', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const publicQuery = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'customer-booking-query.js'), 'utf8');
  const staffRoute = server.slice(server.indexOf("app.get(\n  '/api/staff/appointments'"), server.indexOf("app.patch('/api/staff/appointments/:appointmentId/status'"));
  assert.match(server, /a\.customer_special_request/);
  assert.doesNotMatch(publicQuery, /customer_special_request|customerSpecialRequest/);
  assert.doesNotMatch(staffRoute, /customer_special_request|customerSpecialRequest/);
});

test('customer form and responsive calendar retain the specified compact behavior', () => {
  const booking = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'calendar-shared.css'), 'utf8');
  const i18n = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'shared-i18n.js'), 'utf8');
  assert.match(booking, /id="customerSpecialRequest" maxlength="1000"/);
  assert.match(booking, /customerSpecialRequest,/);
  assert.match(css, /is-compact \.calendar-card-special-request-badge/);
  assert.match(css, /is-short \.calendar-card-special-request-badge/);
  assert.match(css, /is-ultra-short \.calendar-card-special-request-badge/);
  for (const key of ['specialRequest', 'specialRequestOptional', 'specialRequestHint', 'customerSpecialRequest', 'specialRequestTooLong']) assert.match(i18n, new RegExp(`${key}:`));
});
