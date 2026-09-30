'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { validateBookingPhone } = require('../server');
const { resolveOrCreateCustomer } = require('../lib/customer-identity');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

const createIdentityFixture = () => {
  const rowsByTenantPhone = new Map();
  const inserts = [];
  let sequence = 0;
  const client = {
    query: async (sql, params) => {
      if (/SELECT id FROM customers WHERE shop_id=\$1 AND phone_normalized=\$2/.test(sql)) {
        const id = rowsByTenantPhone.get(`${params[0]}:${params[1]}`);
        return { rows: id ? [{ id }] : [] };
      }
      if (/INSERT INTO customers/.test(sql)) {
        const [shopId, name, phone, email, phoneNormalized] = params;
        const id = `customer-${++sequence}`;
        rowsByTenantPhone.set(`${shopId}:${phoneNormalized}`, id);
        inserts.push({ shopId, name, phone, email, phoneNormalized, sql });
        return { rows: [{ id }] };
      }
      throw new Error(`Unexpected identity query: ${sql}`);
    }
  };
  return { client, inserts };
};

test('Walk-in authoritative phone validation returns canonical E.164 for national and E.164 inputs', () => {
  assert.equal(validateBookingPhone('81234567', 'SG'), '+6581234567');
  assert.equal(validateBookingPhone('+6581234567', 'SG'), '+6581234567');
  assert.equal(validateBookingPhone('4155552671', 'US'), '+14155552671');
  assert.equal(validateBookingPhone('+14155552671', 'US'), '+14155552671');
  assert.throws(() => validateBookingPhone('1234', 'SG'), error => error.code === 'INVALID_PHONE');
  assert.throws(() => validateBookingPhone('+14155552671', 'SG'), error => error.code === 'INVALID_PHONE');
});

test('canonical national and E.164 representations reuse one customer inside a shop', async () => {
  for (const pair of [
    [['81234567', 'SG'], ['+6581234567', 'SG']],
    [['4155552671', 'US'], ['+14155552671', 'US']]
  ]) {
    const fixture = createIdentityFixture();
    const firstPhone = validateBookingPhone(...pair[0]);
    const secondPhone = validateBookingPhone(...pair[1]);
    const first = await resolveOrCreateCustomer(fixture.client, { shopId: 'shop-a', name: null, phone: firstPhone, email: null });
    const second = await resolveOrCreateCustomer(fixture.client, { shopId: 'shop-a', name: null, phone: secondPhone, email: null });
    assert.equal(first.customerId, second.customerId);
    assert.equal(fixture.inserts.length, 1);
    assert.equal(fixture.inserts[0].phone, firstPhone);
    assert.equal(fixture.inserts[0].phoneNormalized, firstPhone);
    assert.doesNotMatch(fixture.inserts[0].sql, /phone_verified_at/);
  }
});

test('canonical identity remains tenant scoped across shops', async () => {
  const fixture = createIdentityFixture();
  const canonical = validateBookingPhone('81234567', 'SG');
  const shopA = await resolveOrCreateCustomer(fixture.client, { shopId: 'shop-a', name: null, phone: canonical, email: null });
  const shopB = await resolveOrCreateCustomer(fixture.client, { shopId: 'shop-b', name: null, phone: canonical, email: null });
  assert.notEqual(shopA.customerId, shopB.customerId);
  assert.equal(fixture.inserts.length, 2);
  assert.deepEqual(fixture.inserts.map(row => row.shopId), ['shop-a', 'shop-b']);
});

test('Walk-in route passes canonical E.164 through identity and appointment snapshots', () => {
  const route = serverSource.slice(
    serverSource.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    serverSource.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.match(route, /canonicalPhone = validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(route, /resolveOrCreateCustomer\(client, \{ shopId: scope\.shop_id, name: customerName, phone: canonicalPhone, email \}\)/);
  assert.match(route, /identity\.phone, email,[\s\S]*first\.serviceId/);
  assert.doesNotMatch(route, /phone_verified_at/);
});

const loadLatePredicate = () => {
  const start = adminSource.indexOf('function isAppointmentLate(');
  const end = adminSource.indexOf('const updateLiveLineAndLateBadges', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    timeAnchor: { isValid: true, timezone: 'Asia/Singapore' },
    currentCalendarDate: '2030-01-07',
    globalThis: { ggI18n: { normalizeAppointmentStatus: value => value } }
  };
  vm.createContext(context);
  vm.runInContext(`${adminSource.slice(start, end)}; globalThis.testLate = isAppointmentLate;`, context);
  return context.globalThis.testLate;
};

test('late visual uses a strict greater-than-15-minute boundary and eligible statuses only', () => {
  const isLate = loadLatePredicate();
  const start = Date.parse('2030-01-07T02:00:00.000Z');
  const appointment = { start_at: new Date(start).toISOString(), status: 'confirmed' };
  assert.equal(isLate(appointment, start + (14 * 60 + 59) * 1000, '2030-01-07'), false);
  assert.equal(isLate(appointment, start + 15 * 60 * 1000, '2030-01-07'), false);
  assert.equal(isLate(appointment, start + 15 * 60 * 1000 + 1, '2030-01-07'), true);
  for (const status of ['arrived', 'in_service', 'completed', 'cancelled', 'no_show']) {
    assert.equal(isLate({ ...appointment, status }, start + 60 * 60 * 1000, '2030-01-07'), false);
  }
});

test('late predicate remains visual-only with no persistence or no-show mutation', () => {
  const start = adminSource.indexOf('function isAppointmentLate(');
  const end = adminSource.indexOf('const updateLiveLineAndLateBadges', start);
  const predicateSource = adminSource.slice(start, end);
  assert.doesNotMatch(predicateSource, /fetch\(|UPDATE\s+appointments|appointment_status_history|targetStatus|status:\s*['"]no_show/i);
});
