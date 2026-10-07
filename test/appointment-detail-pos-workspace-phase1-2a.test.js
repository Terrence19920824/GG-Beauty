'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createOwnerAppointmentServiceAddon
} = require('../lib/owner-appointment-service-addon');

const ROOT = path.join(__dirname, '..');
const addonSource = fs.readFileSync(path.join(ROOT, 'lib/owner-appointment-service-addon.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const i18n = require('../public/shared-i18n');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  appointment: '33333333-3333-4333-8333-333333333333',
  location: '44444444-4444-4444-8444-444444444444',
  service: '55555555-5555-4555-8555-555555555555',
  category: '66666666-6666-4666-8666-666666666666',
  goodStaff: '77777777-7777-4777-8777-777777777777',
  incapableStaff: '88888888-8888-4888-8888-888888888888',
  wrongLocationStaff: '99999999-9999-4999-8999-999999999999',
  inactiveStaff: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  unbookableStaff: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  offScheduleStaff: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  leaveStaff: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  conflictStaff: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
};

const isUuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

class BookabilityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const response = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

const authRequest = extra => ({
  params: { appointmentId: ID.appointment },
  query: {},
  ownerAuth: { shopId: ID.shop, membershipId: ID.membership, role: 'owner' },
  ...extra
});

function fixture({ appointmentRows, optionsRows, candidates, validator } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      if (/FROM appointments appointment/.test(normalized)) {
        return { rows: appointmentRows === undefined ? [{
          id: ID.appointment,
          location_id: ID.location,
          end_at: '2031-04-05T02:00:00.000Z',
          status: 'in_service',
          checkout_exists: false
        }] : appointmentRows };
      }
      if (/AS service_id/.test(normalized) && /category_name/.test(normalized)) {
        return { rows: optionsRows || [] };
      }
      if (/SELECT service\.id,service\.duration_minutes/.test(normalized)) {
        return { rows: [{ id: ID.service, duration_minutes: 30 }] };
      }
      if (/AS computed_start_at/.test(normalized)) {
        return { rows: [{
          computed_start_at: '2031-04-05T02:00:00.000Z',
          computed_end_at: '2031-04-05T02:30:00.000Z'
        }] };
      }
      if (/FROM staff_services capability/.test(normalized)) {
        return { rows: candidates || [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {}
  };
  const handler = createOwnerAppointmentServiceAddon({
    pool: { connect: async () => client },
    crypto,
    isUuid,
    validator: validator || (async () => true),
    StaffBookabilityError: BookabilityError,
    safeErrorCode: error => error?.code || 'error'
  });
  return { handler, queries };
}

test('options is tenant scoped, read-only, no-store and returns minimal localized data', async () => {
  const { handler, queries } = fixture({
    optionsRows: [{
      service_id: ID.service,
      category_id: ID.category,
      display_name: 'Hydrating Facial',
      duration_minutes: 30,
      price_minor: '8800',
      currency_code: 'SGD',
      category_name: 'Facial',
      category_sort_order: 1,
      service_sort_order: 2
    }]
  });
  const res = response();
  await handler.listOptions(authRequest({ query: { locale: 'en' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store, private, max-age=0');
  assert.deepEqual(res.body, {
    success: true,
    data: {
      categories: [{ categoryId: ID.category, displayName: 'Facial' }],
      services: [{
        serviceId: ID.service,
        displayName: 'Hydrating Facial',
        categoryId: ID.category,
        durationMinutes: 30,
        priceMinor: 8800,
        currencyCode: 'SGD'
      }]
    }
  });
  const sql = queries.map(query => query.sql).join('\n');
  assert.match(sql, /appointment\.id=\$1 AND appointment\.shop_id=\$2/);
  assert.match(sql, /service\.shop_id=\$1/);
  assert.match(sql, /service\.is_active=TRUE/);
  assert.match(sql, /service\.bookable=TRUE/);
  assert.match(sql, /category\.is_active=TRUE/);
  assert.match(sql, /location_assignment\.location_id=\$2/);
  assert.match(sql, /member\.is_active=TRUE/);
  assert.match(sql, /member\.bookable=TRUE/);
  assert.match(sql, /capability\.is_active=TRUE/);
  assert.ok(queries.every(query => /^SELECT\b/i.test(query.sql)), 'read endpoints must execute SELECT only');
});

test('options returns 404 for a cross-tenant appointment and rejects status or checkout', async () => {
  for (const [appointmentRows, code, status] of [
    [[], 'APPOINTMENT_NOT_FOUND', 404],
    [[{ id: ID.appointment, location_id: ID.location, end_at: '2031-04-05T02:00:00Z', status: 'confirmed', checkout_exists: false }], 'APPOINTMENT_STATUS_NOT_ELIGIBLE', 409],
    [[{ id: ID.appointment, location_id: ID.location, end_at: '2031-04-05T02:00:00Z', status: 'arrived', checkout_exists: true }], 'CHECKOUT_ALREADY_EXISTS', 409]
  ]) {
    const { handler, queries } = fixture({ appointmentRows });
    const res = response();
    await handler.listOptions(authRequest(), res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
    assert.equal(queries.length, 1);
  }
});

test('staff-options derives the append interval and returns only validator-approved staff', async () => {
  const codes = new Map([
    [ID.incapableStaff, 'STAFF_SERVICE_NOT_ALLOWED'],
    [ID.wrongLocationStaff, 'STAFF_LOCATION_NOT_ASSIGNED'],
    [ID.inactiveStaff, 'STAFF_NOT_BOOKABLE'],
    [ID.unbookableStaff, 'STAFF_NOT_BOOKABLE'],
    [ID.offScheduleStaff, 'OUTSIDE_WORKING_HOURS'],
    [ID.leaveStaff, 'STAFF_ON_LEAVE'],
    [ID.conflictStaff, 'APPOINTMENT_COLLISION']
  ]);
  const candidates = [ID.goodStaff, ...codes.keys()].map(staffId => ({
    staff_id: staffId,
    display_name: staffId === ID.goodStaff ? 'Available Staff' : 'Rejected Staff'
  }));
  const validationInputs = [];
  const { handler, queries } = fixture({
    candidates,
    validator: async input => {
      validationInputs.push(input);
      const code = codes.get(input.staffId);
      if (code) throw new BookabilityError(code);
      return true;
    }
  });
  const res = response();
  await handler.listStaffOptions(authRequest({ query: { serviceId: ID.service } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store, private, max-age=0');
  assert.deepEqual(res.body.data, {
    computedStartAt: '2031-04-05T02:00:00.000Z',
    computedEndAt: '2031-04-05T02:30:00.000Z',
    staffOptions: [{ staffId: ID.goodStaff, displayName: 'Available Staff' }]
  });
  assert.equal(validationInputs.length, candidates.length);
  assert.ok(validationInputs.every(input =>
    input.shopId === ID.shop && input.locationId === ID.location &&
    input.serviceId === ID.service && input.excludeAppointmentId === ID.appointment &&
    input.requestedStartAt === '2031-04-05T02:00:00.000Z' &&
    input.requestedEndAt === '2031-04-05T02:30:00.000Z'
  ));
  const sql = queries.map(query => query.sql).join('\n');
  assert.match(sql, /location_assignment\.location_id=\$2/);
  assert.match(sql, /member\.is_active=TRUE/);
  assert.match(sql, /member\.bookable=TRUE/);
  assert.match(sql, /capability\.service_id=\$3/);
  assert.ok(queries.every(query => /^SELECT\b/i.test(query.sql)), 'staff options must remain read-only');
});

test('Phase 1.2A UI uses contextual GETs, guards duplicate POST and refreshes the DTO', () => {
  assert.match(adminSource, /service-addons\/options\?locale=/);
  assert.match(adminSource, /service-addons\/staff-options\?serviceId=/);
  assert.doesNotMatch(adminSource, /fetch\('\/api\/owner\/services'/);
  assert.match(adminSource, /const requestGeneration = \+\+staffRequestGeneration/);
  assert.match(adminSource, /requestGeneration !== staffRequestGeneration/);
  assert.match(adminSource, /if \(submitting \|\| !serviceSelect\.value \|\| !staffSelect\.value\) return/);
  assert.match(adminSource, /submitting = true;[\s\S]*?fetch\(`\/api\/owner\/appointments\/\$\{encodeURIComponent\(appointment\.id\)\}\/service-addons`/);
  assert.match(adminSource, /await loadAppointments\(currentRequestedLocationId\);[\s\S]*?renderAppointmentDrawerById\(appointment\.id\)/);
  assert.match(adminSource, /body: JSON\.stringify\(\{ serviceId: serviceSelect\.value, staffId: staffSelect\.value, locale, idempotencyKey \}\)/);
  assert.doesNotMatch(addonSource, /createBookingNotification|sendSms|sendSMS/);
});

test('Phase 1.2A i18n keys are complete and language-pure', () => {
  const keys = [
    'activeAddService', 'serviceAddonSearch', 'serviceAddonSearchPlaceholder',
    'serviceAddonCategory', 'serviceAddonAllCategories', 'serviceAddonLoadingServices',
    'serviceAddonChooseService', 'serviceAddonNoServices', 'serviceAddonLoadingStaff',
    'serviceAddonNoStaff', 'serviceAddonComputedTime', 'serviceAddonChooseStaff',
    'serviceAddonReady', 'serviceAddonSubmitting'
  ];
  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.notEqual(zh, key);
    assert.notEqual(en, key);
    assert.doesNotMatch(zh, /[A-Za-z]{3,}/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/);
  }
  assert.equal(i18n.t('activeAddService', 'zh-CN'), '添加服务');
  assert.equal(i18n.t('activeAddService', 'en'), 'Add Service');
});
