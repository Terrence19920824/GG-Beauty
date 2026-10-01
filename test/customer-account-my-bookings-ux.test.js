'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { queryCustomerBookings } = require('../lib/customer-booking-query');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('authenticated booking query is scoped by server-supplied shop and customer identity', async () => {
  let captured;
  const rows = [{ id: 'appointment-a', appointment_no: 'GG-1', start_at: new Date('2026-10-01T10:00:00Z'), status: 'completed', items: [] }];
  const bookings = await queryCustomerBookings({
    query: async (sql, params) => { captured = { sql, params }; return { rows }; }
  }, { shopId: 'shop-a', customerId: 'customer-a' });
  assert.deepEqual(captured.params, ['shop-a', 'customer-a']);
  assert.match(captured.sql, /WHERE a\.shop_id = \$1 AND a\.customer_id = \$2/);
  assert.equal(bookings[0].appointmentNo, 'GG-1');
  assert.equal(bookings[0].status, 'completed');
  assert.equal(bookings[0].payment, undefined, 'completed must not infer paid');
});

test('my-bookings resolves identity from the authenticated cookie, not request customer data', () => {
  const server = read('server.js');
  const route = server.slice(server.indexOf("app.post('/api/customer/my-bookings'"), server.indexOf("app.get('/api/calendar/appointment.ics'"));
  assert.match(route, /(?:resolveCustomerMemberIdentity\(\)\.authenticate|customerMemberIdentity\.authenticate)\(sessionToken\)/);
  assert.match(route, /customerId: customerSession\.customer_id/);
  assert.match(route, /shopId: customerSession\.shop_id/);
  assert.match(route, /customerSession\.shop_slug !== normalizedSlug/);
  assert.doesNotMatch(route, /req\.body\.customerId|req\.body\.customer_id/);
  assert.match(route, /CUSTOMER_SESSION_INVALID/);
  assert.match(route, /authenticated: false/);
});

test('account and bookings omit merchant cards while the main booking page retains its card', () => {
  const member = read('public/member.html');
  const bookings = read('public/my-bookings.html');
  const bookingJs = read('public/customer-my-bookings.js');
  const main = read('public/index.html');
  assert.doesNotMatch(member, /merchantContactBar/);
  assert.doesNotMatch(bookings, /merchantContactBar/);
  assert.doesNotMatch(bookingJs, /booking-contact-actions/);
  assert.match(main, /id="merchantContactBar"/);
});

test('bookings page hides phone re-entry only after an authenticated response and keeps the anonymous form', () => {
  const html = read('public/my-bookings.html');
  const js = read('public/customer-my-bookings.js');
  assert.match(html, /id="phoneLookupForm"/);
  assert.match(html, /id="countryCode"/);
  assert.match(html, /id="queryPhone"/);
  assert.match(js, /result\.data\?\.authenticated !== true/);
  assert.match(js, /form\.hidden = true/);
  assert.match(js, /body: JSON\.stringify\(\{ shopSlug: currentShopSlug \}\)/);
  assert.doesNotMatch(js, /customerId|customer_id/);
});

test('new visible strings remain bilingual without cross-language leakage', () => {
  const i18n = require('../public/shared-i18n');
  const zh = i18n.t('signedInBookings', 'zh-CN');
  const en = i18n.t('signedInBookings', 'en');
  assert.doesNotMatch(zh, /[a-zA-Z]/);
  assert.doesNotMatch(en, /[\u3400-\u9fff]/);
});
