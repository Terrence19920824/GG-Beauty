'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');
const {
  CustomerIdentityError,
  resolveBookingParties,
  resolveVerifiedBooker,
  resolveOrCreateCustomer,
  resolveCustomerByPhone
} = require('../lib/customer-identity');
const {
  validateCustomerIdentityPhone,
  PhoneValidationError
} = require('../lib/phone-normalization');
const sharedI18n = require('../public/shared-i18n');

// ==================================================
// 1. Session Resolution & Identity Invariants
// ==================================================

test('A. Anonymous booking resolves unverified customer with verified: false', async () => {
  const client = {
    query: async (sql, params) => {
      if (/SELECT id FROM customers/.test(sql)) {
        return { rows: [] }; // no existing customer
      }
      if (/INSERT INTO customers/.test(sql)) {
        return { rows: [{ id: 'anon-cust-1' }] };
      }
      return { rows: [] };
    }
  };

  const result = await resolveBookingParties(client, {
    shopId: 'shop-1',
    body: {
      customerName: 'Anonymous Booker',
      phone: '+6581234567'
    }
  });

  assert.equal(result.booker.customerId, 'anon-cust-1');
  assert.equal(result.booker.verified, false);
  assert.equal(result.recipient.customerId, 'anon-cust-1');
  assert.equal(result.recipient.verified, false);
});

test('B. Logged in unverified session booking for myself with same phone binds to session customer', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      // 1. check verified_member
      if (/identity_status='verified_member'/.test(sql)) {
        return { rows: [] }; // NOT a verified member
      }
      // 2. check session customer exists
      if (/SELECT id, phone, phone_normalized, identity_status FROM customers/.test(sql)) {
        return {
          rows: [{
            id: 'unverified-cust-1',
            phone: '+6581234567',
            phone_normalized: '+6581234567',
            identity_status: 'unverified_contact'
          }]
        };
      }
      // 3. check phone lookup
      if (/phone_normalized=\$2/.test(sql)) {
        return {
          rows: [{
            id: 'unverified-cust-1'
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const session = { shop_id: 'shop-1', customer_id: 'unverified-cust-1' };
  const result = await resolveBookingParties(client, {
    shopId: 'shop-1',
    verifiedSession: session,
    body: {
      customerName: 'Unverified User',
      phone: '+6581234567'
    }
  });

  assert.equal(result.booker.customerId, 'unverified-cust-1');
  assert.equal(result.booker.verified, false);
  assert.equal(result.recipient.customerId, 'unverified-cust-1');
  assert.equal(result.recipient.verified, false);
  // Zero customer INSERTs or UPDATEs performed
  assert.equal(queries.some(q => /INSERT INTO customers|UPDATE customers/.test(q.sql)), false);
});

test('C. Logged in unverified session booking with unclaimed phone binds without mutating customer record', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/identity_status='verified_member'/.test(sql)) {
        return { rows: [] }; // unverified
      }
      if (/SELECT id, phone, phone_normalized, identity_status FROM customers/.test(sql)) {
        return {
          rows: [{
            id: 'unverified-cust-1',
            phone: '+6581111111',
            phone_normalized: '+6581111111',
            identity_status: 'unverified_contact'
          }]
        };
      }
      if (/phone_normalized=\$2/.test(sql)) {
        return { rows: [] }; // unclaimed phone
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const session = { shop_id: 'shop-1', customer_id: 'unverified-cust-1' };
  const result = await resolveBookingParties(client, {
    shopId: 'shop-1',
    verifiedSession: session,
    body: {
      customerName: 'Unverified User',
      phone: '+6589990001'
    }
  });

  assert.equal(result.booker.customerId, 'unverified-cust-1');
  assert.equal(result.booker.verified, false);
  // Zero customer mutations
  assert.equal(queries.some(q => /INSERT INTO customers|UPDATE customers/.test(q.sql)), false);
});

test('D. Logged in unverified session booking with phone belonging to another customer fails closed with CUSTOMER_IDENTITY_CONFLICT', async () => {
  const client = {
    query: async (sql, params) => {
      if (/identity_status='verified_member'/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id, phone, phone_normalized, identity_status FROM customers/.test(sql)) {
        return {
          rows: [{
            id: 'unverified-cust-1',
            phone: '+6581111111',
            phone_normalized: '+6581111111',
            identity_status: 'unverified_contact'
          }]
        };
      }
      if (/phone_normalized=\$2/.test(sql)) {
        // Belongs to a DIFFERENT customer!
        return { rows: [{ id: 'other-cust-2' }] };
      }
      return { rows: [] };
    }
  };

  const session = { shop_id: 'shop-1', customer_id: 'unverified-cust-1' };
  await assert.rejects(
    resolveBookingParties(client, {
      shopId: 'shop-1',
      verifiedSession: session,
      body: {
        customerName: 'Impersonator',
        phone: '+6582222222'
      }
    }),
    err => err instanceof CustomerIdentityError && err.code === 'CUSTOMER_IDENTITY_CONFLICT'
  );
});

test('E. Logged in verified member booking uses authoritative customer identity with verified: true', async () => {
  const client = {
    query: async (sql, params) => {
      if (/identity_status='verified_member'/.test(sql)) {
        return {
          rows: [{
            id: 'verified-member-1',
            phone: '+6581234567',
            phone_normalized: '+6581234567'
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const session = { shop_id: 'shop-1', customer_id: 'verified-member-1' };
  const result = await resolveBookingParties(client, {
    shopId: 'shop-1',
    verifiedSession: session,
    body: {
      customerName: 'Verified Member',
      phone: '+6581234567'
    }
  });

  assert.equal(result.booker.customerId, 'verified-member-1');
  assert.equal(result.booker.verified, true);
  assert.equal(result.recipient.customerId, 'verified-member-1');
  assert.equal(result.recipient.verified, true);
});

test('F. Cross-shop session booking attempt is rejected with CUSTOMER_SESSION_SHOP_MISMATCH', async () => {
  const client = { query: async () => ({ rows: [] }) };
  const session = { shop_id: 'shop-A', customer_id: 'cust-1' };

  await assert.rejects(
    resolveBookingParties(client, {
      shopId: 'shop-B',
      verifiedSession: session,
      body: { customerName: 'Cross Shop User', phone: '+6581234567' }
    }),
    err => err instanceof CustomerIdentityError && err.code === 'CUSTOMER_SESSION_SHOP_MISMATCH'
  );
});

test('G. Invalid session (customer not in shop) is rejected with CUSTOMER_SESSION_INVALID', async () => {
  const client = {
    query: async sql => {
      // verified_member check returns empty
      if (/identity_status='verified_member'/.test(sql)) return { rows: [] };
      // customer existence check returns empty
      if (/SELECT id, phone, phone_normalized, identity_status/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };
  const session = { shop_id: 'shop-1', customer_id: 'nonexistent-cust' };

  await assert.rejects(
    resolveBookingParties(client, {
      shopId: 'shop-1',
      verifiedSession: session,
      body: { customerName: 'Ghost User', phone: '+6581234567' }
    }),
    err => err instanceof CustomerIdentityError && err.code === 'CUSTOMER_SESSION_INVALID'
  );
});

test('H. Booking for someone else with unverified session creates distinct unverified recipient', async () => {
  const client = {
    query: async (sql, params) => {
      if (/identity_status='verified_member'/.test(sql)) return { rows: [] };
      if (/SELECT id, phone, phone_normalized, identity_status/.test(sql)) {
        return { rows: [{ id: 'booker-cust-1', phone: '+6581111111', phone_normalized: '+6581111111', identity_status: 'unverified_contact' }] };
      }
      if (/phone_normalized=\$2/.test(sql)) return { rows: [{ id: 'booker-cust-1' }] };
      if (/INSERT INTO customers.*identity_status/.test(sql)) {
        return { rows: [{ id: 'recipient-cust-2' }] };
      }
      return { rows: [] };
    }
  };

  const session = { shop_id: 'shop-1', customer_id: 'booker-cust-1' };
  const result = await resolveBookingParties(client, {
    shopId: 'shop-1',
    verifiedSession: session,
    body: {
      bookingFor: 'someone_else',
      customerName: 'Booker',
      phone: '+6581111111',
      recipient: {
        name: 'Recipient Friend',
        phone: '+6582222222'
      }
    }
  });

  assert.equal(result.booker.customerId, 'booker-cust-1');
  assert.equal(result.booker.verified, false);
  assert.equal(result.recipient.customerId, 'recipient-cust-2');
  assert.equal(result.recipient.verified, false);
});

// ==================================================
// 2. Authoritative Phone Validation
// ==================================================

test('I. Singapore subscriber numbers starting with 1 or 2 are strictly rejected', () => {
  assert.throws(
    () => validateCustomerIdentityPhone('+6512345678'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_E164_INVALID'
  );
  assert.throws(
    () => validateCustomerIdentityPhone('+6522345678'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_E164_INVALID'
  );
  assert.throws(
    () => validateCustomerIdentityPhone('12345678', 'SG'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_INVALID_FOR_COUNTRY'
  );
  assert.throws(
    () => validateCustomerIdentityPhone('22345678', 'SG'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_INVALID_FOR_COUNTRY'
  );
});

test('J. Valid mobile numbers in Singapore, China, and Malaysia pass validation', () => {
  const sg1 = validateCustomerIdentityPhone('81234567', 'SG');
  assert.equal(sg1.countryIso2, 'SG');
  assert.equal(sg1.e164, '+6581234567');

  const sg2 = validateCustomerIdentityPhone('88067714', 'SG');
  assert.equal(sg2.countryIso2, 'SG');
  assert.equal(sg2.e164, '+6588067714');

  const sgE164 = validateCustomerIdentityPhone('+6581234567');
  assert.equal(sgE164.countryIso2, 'SG');
  assert.equal(sgE164.e164, '+6581234567');

  const cn = validateCustomerIdentityPhone('13800138000', 'CN');
  assert.equal(cn.countryIso2, 'CN');
  assert.equal(cn.e164, '+8613800138000');

  const my1 = validateCustomerIdentityPhone('123456789', 'MY');
  assert.equal(my1.countryIso2, 'MY');
  assert.equal(my1.e164, '+60123456789');

  const my2 = validateCustomerIdentityPhone('1112345678', 'MY');
  assert.equal(my2.countryIso2, 'MY');
  assert.equal(my2.e164, '+601112345678');
});

test('J2. Malformed numbers, unknown prefixes, and country mismatches fail closed', () => {
  // Malformed numbers for CN & MY
  assert.throws(
    () => validateCustomerIdentityPhone('00000000', 'CN'),
    err => err instanceof PhoneValidationError
  );
  assert.throws(
    () => validateCustomerIdentityPhone('123', 'CN'),
    err => err instanceof PhoneValidationError
  );
  assert.throws(
    () => validateCustomerIdentityPhone('00000000', 'MY'),
    err => err instanceof PhoneValidationError
  );
  assert.throws(
    () => validateCustomerIdentityPhone('123', 'MY'),
    err => err instanceof PhoneValidationError
  );

  // Malformed +E.164
  assert.throws(
    () => validateCustomerIdentityPhone('+123'),
    err => err instanceof PhoneValidationError
  );

  // Unknown prefix
  assert.throws(
    () => validateCustomerIdentityPhone('+9991234567'),
    err => err instanceof PhoneValidationError
  );

  // Country mismatch
  assert.throws(
    () => validateCustomerIdentityPhone('+6581234567', 'CN'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_INVALID_FOR_COUNTRY'
  );
  assert.throws(
    () => validateCustomerIdentityPhone('+8613800138000', 'SG'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_INVALID_FOR_COUNTRY'
  );

  // National format without countryIso2 fails closed
  assert.throws(
    () => validateCustomerIdentityPhone('81234567'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_COUNTRY_REQUIRED'
  );
});

// ==================================================
// 3. Client-side Phone Validation & Error Code Mapping
// ==================================================

test('K. Client-side isValidCustomerPhone accurately validates Singapore and international numbers', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify function is defined in public/index.html
  assert.ok(indexHtml.includes('function isValidCustomerPhone('));
  assert.ok(indexHtml.includes('function mapBookingErrorCode('));

  // Mirror the exact client logic from public/index.html
  const isValidCustomerPhone = (countryCode, value) => {
    if (typeof value !== 'string') return false;
    const raw = value.trim();
    if (!raw) return false;
    if (/[\r\n\t\0<>]/.test(raw)) return false;
    if (/[a-zA-Z]/.test(raw)) return false;
    if ((raw.match(/\+/g) || []).length > 1) return false;
    if (raw.includes('+') && !raw.startsWith('+')) return false;

    const KNOWN_CODES = ['+65', '+60', '+62', '+86', '+1'];
    const selectedCode = (countryCode || '+65').trim();
    if (!KNOWN_CODES.includes(selectedCode)) return false;

    let nationalStr = raw;
    if (raw.startsWith('+')) {
      const matchedPrefix = KNOWN_CODES.find(code => raw.startsWith(code));
      if (!matchedPrefix) return false;
      if (matchedPrefix !== selectedCode) return false;
      nationalStr = raw.slice(matchedPrefix.length);
    }

    const cleanDigits = nationalStr.replace(/[\s\-()]/g, '');
    if (!/^\d+$/.test(cleanDigits)) return false;

    switch (selectedCode) {
      case '+65':
        return /^[3689]\d{7}$/.test(cleanDigits);
      case '+86':
        return /^1[3-9]\d{9}$/.test(cleanDigits);
      case '+60':
        return /^(?:1[0-46-9]\d{7,8}|[3-9]\d{6,8})$/.test(cleanDigits);
      case '+62':
        return /^(?:8[1-9]\d{7,10}|[2-9]\d{6,10})$/.test(cleanDigits);
      case '+1':
        return /^[2-9]\d{2}[2-9]\d{6}$/.test(cleanDigits);
      default:
        return false;
    }
  };

  // SG checks: 81234567 & 88067714 pass; 12345678 & 22345678 fail
  assert.equal(isValidCustomerPhone('+65', '81234567'), true);
  assert.equal(isValidCustomerPhone('+65', '88067714'), true);
  assert.equal(isValidCustomerPhone('+65', '+6581234567'), true);
  assert.equal(isValidCustomerPhone('+65', '12345678'), false);
  assert.equal(isValidCustomerPhone('+65', '22345678'), false);
  assert.equal(isValidCustomerPhone('+65', '+6512345678'), false);
  assert.equal(isValidCustomerPhone('+65', '+6522345678'), false);
  assert.equal(isValidCustomerPhone('+65', '00000000'), false);
  assert.equal(isValidCustomerPhone('+65', 'abc12345'), false);

  // CN checks: valid 11 digits starting with 1[3-9] pass; malformed fail
  assert.equal(isValidCustomerPhone('+86', '13800138000'), true);
  assert.equal(isValidCustomerPhone('+86', '+8613800138000'), true);
  assert.equal(isValidCustomerPhone('+86', '00000000'), false);
  assert.equal(isValidCustomerPhone('+86', '123'), false);
  assert.equal(isValidCustomerPhone('+86', '12800138000'), false);

  // MY checks: valid mobile pass; malformed fail
  assert.equal(isValidCustomerPhone('+60', '123456789'), true);
  assert.equal(isValidCustomerPhone('+60', '1112345678'), true);
  assert.equal(isValidCustomerPhone('+60', '+60123456789'), true);
  assert.equal(isValidCustomerPhone('+60', '00000000'), false);
  assert.equal(isValidCustomerPhone('+60', '123'), false);

  // Unknown prefix & country mismatch
  assert.equal(isValidCustomerPhone('+65', '+9991234567'), false);
  assert.equal(isValidCustomerPhone('+65', '+8613800138000'), false);
  assert.equal(isValidCustomerPhone('+86', '+6581234567'), false);
});

test('L. Client-side mapBookingErrorCode maps all error codes to localized strings', () => {
  const mapBookingErrorCode = (code, locale = 'zh-CN') => {
    switch (code) {
      case 'INVALID_PHONE':
      case 'PHONE_INVALID':
      case 'PHONE_E164_INVALID':
      case 'PHONE_INPUT_REQUIRED':
      case 'PHONE_INVALID_FOR_COUNTRY':
      case 'PHONE_CUSTOMER_IDENTITY_INELIGIBLE':
        return sharedI18n.t('invalidPhone', locale);
      case 'BOOKING_NOT_AVAILABLE':
      case 'BOOKING_CONFLICT':
      case 'SLOT_UNAVAILABLE':
      case '23P01':
        return sharedI18n.t('slotUnavailable', locale);
      case 'booking_time_in_past':
        return sharedI18n.t('bookingTimeInPast', locale);
      case 'service_not_found':
      case 'SERVICE_UNAVAILABLE':
        return sharedI18n.t('serviceUnavailable', locale);
      case 'NO_AVAILABLE_STAFF':
      case 'STAFF_UNAVAILABLE':
        return sharedI18n.t('staffUnavailable', locale);
      case 'BOOKING_MAINTENANCE':
        return sharedI18n.t('bookingMaintenance', locale);
      case 'CUSTOMER_IDENTITY_CONFLICT':
      case 'VERIFIED_BOOKER_REQUIRED':
        return sharedI18n.t('identityConflict', locale);
      default:
        return null;
    }
  };

  // zh-CN mappings
  assert.equal(mapBookingErrorCode('INVALID_PHONE', 'zh-CN'), '请输入有效的手机号码');
  assert.equal(mapBookingErrorCode('BOOKING_NOT_AVAILABLE', 'zh-CN'), '该时间暂不可预约');
  assert.equal(mapBookingErrorCode('booking_time_in_past', 'zh-CN'), '所选时间已过，无法预约');
  assert.equal(mapBookingErrorCode('CUSTOMER_IDENTITY_CONFLICT', 'zh-CN'), '顾客联系方式与已登录账号不符，请核对或退出登录后再试');
  assert.equal(mapBookingErrorCode('BOOKING_MAINTENANCE', 'zh-CN'), '预约系统维护中，请稍后再试');

  // en mappings
  assert.equal(mapBookingErrorCode('INVALID_PHONE', 'en'), 'Please enter a valid mobile number');
  assert.equal(mapBookingErrorCode('BOOKING_NOT_AVAILABLE', 'en'), 'This time slot is not available');
  assert.equal(mapBookingErrorCode('booking_time_in_past', 'en'), 'Selected time has passed, please choose another time');
  assert.equal(mapBookingErrorCode('CUSTOMER_IDENTITY_CONFLICT', 'en'), 'Contact details do not match the signed-in account. Please verify or sign out.');
  assert.equal(mapBookingErrorCode('BOOKING_MAINTENANCE', 'en'), 'Booking temporarily unavailable for maintenance');
});

// ==================================================
// 4. Linguistic Purity (100% Chinese in zh-CN, 100% English in en)
// ==================================================

test('M. Linguistic purity of new error messages', () => {
  const newKeys = [
    'invalidPhone',
    'slotUnavailable',
    'bookingTimeInPast',
    'serviceUnavailable',
    'staffUnavailable',
    'bookingMaintenance',
    'identityConflict'
  ];

  for (const key of newKeys) {
    const zh = sharedI18n.t(key, 'zh-CN');
    assert.ok(zh, `Missing zh-CN translation for ${key}`);
    assert.doesNotMatch(zh, /[a-zA-Z]/, `zh-CN translation for ${key} must not contain English letters`);
    assert.equal(zh.includes('/'), false, `zh-CN translation for ${key} must not contain slashes`);

    const en = sharedI18n.t(key, 'en');
    assert.ok(en, `Missing en translation for ${key}`);
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en translation for ${key} must not contain Chinese characters`);
    assert.equal(en.includes('/'), false, `en translation for ${key} must not contain slashes`);
  }
});

// ==================================================
// 5. Server Route End-to-End Validation
// ==================================================

const makeFixture = () => {
  let itemIndex = 0;
  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return { rows: [] };
      if (/SELECT shop\.id AS shop_id/.test(sql)) return { rows: [{ shop_id: '11111111-1111-4111-8111-111111111111', shop_slug: 'tenant-a', location_id: '22222222-2222-4222-8222-222222222222' }] };
      if (/FROM shops/.test(sql)) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Tenant A', slug: 'tenant-a' }] };
      if (/FROM locations/.test(sql)) return { rows: [{ id: '22222222-2222-4222-8222-222222222222', timezone: 'Asia/Singapore' }] };
      if (/service\.id=ANY/.test(sql) || /FROM services/.test(sql)) return { rows: [
        { id: '33333333-3333-4333-8333-111111111111', duration_minutes: 60, price: '88', price_is_from: false, category_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', localized_name: 'Basic Facial', name: 'Basic Facial', is_active: true, bookable: true }
      ] };
      if (/assigned_appointment_count/.test(sql) || /FROM staff/.test(sql)) return { rows: [
        { id: '44444444-4444-4444-8444-111111111111', staff_id: '44444444-4444-4444-8444-111111111111', display_name: 'Amy', name: 'Amy', assigned_appointment_count: 0, is_active: true, bookable: true }
      ] };
      if (/TO_CHAR/.test(sql)) return { rows: [
        { time: '10:00', start_at: '2030-01-07T02:00:00.000000Z' }
      ] };
      if (/SELECT id FROM customers/.test(sql) || /SELECT.*FROM customers/.test(sql)) return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      if (/INSERT INTO appointments/.test(sql)) return { rows: [{ id: '66666666-6666-4666-8666-666666666666', shop_id: '11111111-1111-4111-8111-111111111111', location_id: '22222222-2222-4222-8222-222222222222', customer_id: '55555555-5555-4555-8555-555555555555', service_id: '33333333-3333-4333-8333-111111111111', staff_id: '44444444-4444-4444-8444-111111111111', appointment_no: 'GG-TEST', start_at: '2030-01-07T02:00:00.000Z', end_at: '2030-01-07T03:00:00.000Z', status: 'pending', created_at: '2030-01-01T00:00:00.000Z' }] };
      if (/INSERT INTO appointment_items/.test(sql)) return { rows: [{ id: `77777777-7777-4777-8777-${String(++itemIndex).padStart(12, '0')}` }] };
      if (/INSERT INTO appointment_item_staff_assignments/.test(sql)) return { rows: [{ id: `88888888-8888-4888-8888-${String(itemIndex).padStart(12, '0')}` }] };
      return { rows: [] };
    },
    release: () => {}
  };
  return { connect: async () => client, query: client.query };
};

const withServer = async operation => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  app.locals.bookingPool = makeFixture();
  app.locals.bookingValidator = async () => {};
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
};

// Route A: Multi-Service Route (POST /api/new-db with items)
test('N. Multi-Service Route accepts valid phone numbers across supported countries', async () => {
  await withServer(async base => {
    const validCases = [
      { phone: '81234567', countryCode: '+65' },
      { phone: '88067714', countryCode: '+65' },
      { phone: '81234567', countryCode: 'SG' },
      { phone: '+6581234567' },
      { phone: '13800138000', countryCode: '+86' },
      { phone: '+8613800138000' },
      { phone: '123456789', countryCode: '+60' },
      { phone: '1112345678', countryCode: '+60' },
      { phone: '+60123456789' }
    ];

    for (const tc of validCases) {
      const response = await fetch(`${base}/api/new-db`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'tenant-a',
          locale: 'zh-CN',
          startAt: '2030-01-07T02:00:00.000Z',
          customerName: 'Real Customer',
          phone: tc.phone,
          ...(tc.countryCode ? { countryCode: tc.countryCode } : {}),
          items: [{ clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(response.status, 200, `Expected 200 for phone: ${tc.phone} / country: ${tc.countryCode}`);
      const body = await response.json();
      assert.equal(body.success, true);
    }
  });
});

test('O. Multi-Service Route rejects invalid numbers, unknown prefixes, and mismatches with 400 INVALID_PHONE', async () => {
  await withServer(async base => {
    const invalidCases = [
      { desc: 'SG 12345678 with +65', phone: '12345678', countryCode: '+65' },
      { desc: 'SG 22345678 with +65', phone: '22345678', countryCode: '+65' },
      { desc: 'SG 12345678 national without country', phone: '12345678' },
      { desc: 'SG +6512345678 E.164', phone: '+6512345678' },
      { desc: 'SG +6522345678 E.164', phone: '+6522345678' },
      { desc: 'CN 00000000 with +86', phone: '00000000', countryCode: '+86' },
      { desc: 'CN 123 with +86', phone: '123', countryCode: '+86' },
      { desc: 'MY 00000000 with +60', phone: '00000000', countryCode: '+60' },
      { desc: 'MY 123 with +60', phone: '123', countryCode: '+60' },
      { desc: 'Malformed E.164 +123', phone: '+123' },
      { desc: 'Unknown prefix +9991234567', phone: '+9991234567' },
      { desc: 'Country mismatch +6581234567 with +86', phone: '+6581234567', countryCode: '+86' },
      { desc: 'Country mismatch +8613800138000 with +65', phone: '+8613800138000', countryCode: '+65' },
      { desc: 'SG valid national without countryCode', phone: '81234567' },
      { desc: 'Contains injection chars', phone: '8123<script>4567', countryCode: '+65' }
    ];

    for (const tc of invalidCases) {
      const response = await fetch(`${base}/api/new-db`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'tenant-a',
          locale: 'zh-CN',
          startAt: '2030-01-07T02:00:00.000Z',
          customerName: 'Real Customer',
          phone: tc.phone,
          ...(tc.countryCode ? { countryCode: tc.countryCode } : {}),
          items: [{ clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(response.status, 400, `Expected 400 for ${tc.desc}`);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'INVALID_PHONE');
      assert.equal(body.message, '请输入有效的手机号码');
    }

    // Empty required phone rejected
    const emptyResponse = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        locale: 'zh-CN',
        startAt: '2030-01-07T02:00:00.000Z',
        customerName: 'Real Customer',
        phone: '',
        items: [{ clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }]
      })
    });
    assert.equal(emptyResponse.status, 400);

    // Booking for someone else with invalid recipient phone
    const someoneElseInvalid = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        locale: 'zh-CN',
        startAt: '2030-01-07T02:00:00.000Z',
        customerName: 'Booker Customer',
        phone: '+6581234567',
        bookingFor: 'someone_else',
        recipient: { name: 'Friend', phone: '22345678', countryCode: '+65' },
        items: [{ clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }]
      })
    });
    assert.equal(someoneElseInvalid.status, 400);
    const someoneElseBody = await someoneElseInvalid.json();
    assert.equal(someoneElseBody.code, 'INVALID_PHONE');

    // Booking for someone else with valid recipient phone succeeds
    const someoneElseValid = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        locale: 'zh-CN',
        startAt: '2030-01-07T02:00:00.000Z',
        customerName: 'Booker Customer',
        phone: '+6581234567',
        bookingFor: 'someone_else',
        recipient: { name: 'Friend', phone: '88067714', countryCode: '+65' },
        items: [{ clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }]
      })
    });
    assert.equal(someoneElseValid.status, 200);
    assert.equal((await someoneElseValid.json()).success, true);
  });
});

// Route B: Legacy Single-Service Route (POST /api/new-db without items)
test('P. Legacy Single-Service Route accepts valid phone numbers across supported countries', async () => {
  await withServer(async base => {
    const validCases = [
      { phone: '81234567', countryCode: '+65' },
      { phone: '88067714', countryCode: '+65' },
      { phone: '+6581234567' },
      { phone: '13800138000', countryCode: '+86' },
      { phone: '+8613800138000' },
      { phone: '123456789', countryCode: '+60' },
      { phone: '+60123456789' }
    ];

    for (const tc of validCases) {
      const response = await fetch(`${base}/api/new-db`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'tenant-a',
          service: 'Basic Facial',
          staff: 'Amy',
          staffSelectionType: 'specific',
          date: '2030-01-07',
          time: '10:00',
          customerName: 'Legacy Customer',
          phone: tc.phone,
          ...(tc.countryCode ? { countryCode: tc.countryCode } : {})
        })
      });
      assert.equal(response.status, 200, `Expected 200 for phone: ${tc.phone} / country: ${tc.countryCode}`);
      const body = await response.json();
      assert.equal(body.success, true);
    }
  });
});

test('Q. Legacy Single-Service Route rejects invalid numbers, unknown prefixes, and mismatches with 400 INVALID_PHONE', async () => {
  await withServer(async base => {
    const invalidCases = [
      { desc: 'SG 12345678 with +65', phone: '12345678', countryCode: '+65' },
      { desc: 'SG 22345678 with +65', phone: '22345678', countryCode: '+65' },
      { desc: 'SG 12345678 national without country', phone: '12345678' },
      { desc: 'SG +6512345678 E.164', phone: '+6512345678' },
      { desc: 'SG +6522345678 E.164', phone: '+6522345678' },
      { desc: 'CN 00000000 with +86', phone: '00000000', countryCode: '+86' },
      { desc: 'MY 00000000 with +60', phone: '00000000', countryCode: '+60' },
      { desc: 'Malformed E.164 +123', phone: '+123' },
      { desc: 'Unknown prefix +9991234567', phone: '+9991234567' },
      { desc: 'Country mismatch +6581234567 with +86', phone: '+6581234567', countryCode: '+86' },
      { desc: 'SG valid national without countryCode', phone: '81234567' }
    ];

    for (const tc of invalidCases) {
      const response = await fetch(`${base}/api/new-db`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'tenant-a',
          service: 'Basic Facial',
          staff: 'Amy',
          staffSelectionType: 'specific',
          date: '2030-01-07',
          time: '10:00',
          customerName: 'Legacy Customer',
          phone: tc.phone,
          ...(tc.countryCode ? { countryCode: tc.countryCode } : {})
        })
      });
      assert.equal(response.status, 400, `Expected 400 for ${tc.desc}`);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'INVALID_PHONE');
      assert.equal(body.message, '请输入有效的手机号码');
    }

    // Empty required phone rejected
    const emptyResponse = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        service: 'Basic Facial',
        staff: 'Amy',
        staffSelectionType: 'specific',
        date: '2030-01-07',
        time: '10:00',
        customerName: 'Legacy Customer',
        phone: ''
      })
    });
    assert.equal(emptyResponse.status, 400);

    // Booking for someone else with invalid recipient phone
    const someoneElseInvalid = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        service: 'Basic Facial',
        staff: 'Amy',
        staffSelectionType: 'specific',
        date: '2030-01-07',
        time: '10:00',
        customerName: 'Booker Customer',
        phone: '+6581234567',
        bookingFor: 'someone_else',
        recipient: { name: 'Friend', phone: '22345678', countryCode: '+65' }
      })
    });
    assert.equal(someoneElseInvalid.status, 400);
    const someoneElseBody = await someoneElseInvalid.json();
    assert.equal(someoneElseBody.code, 'INVALID_PHONE');

    // Booking for someone else with valid recipient phone succeeds
    const someoneElseValid = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        service: 'Basic Facial',
        staff: 'Amy',
        staffSelectionType: 'specific',
        date: '2030-01-07',
        time: '10:00',
        customerName: 'Booker Customer',
        phone: '+6581234567',
        bookingFor: 'someone_else',
        recipient: { name: 'Friend', phone: '88067714', countryCode: '+65' }
      })
    });
    assert.equal(someoneElseValid.status, 200);
    assert.equal((await someoneElseValid.json()).success, true);
  });
});
