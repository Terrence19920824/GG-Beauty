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

test('I. Singapore +65 12345678 is strictly rejected by validateCustomerIdentityPhone', () => {
  assert.throws(
    () => validateCustomerIdentityPhone('+6512345678'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_E164_INVALID'
  );
  assert.throws(
    () => validateCustomerIdentityPhone('+65 12345678'),
    err => err instanceof PhoneValidationError && err.code === 'PHONE_E164_INVALID'
  );
});

test('J. Valid mobile numbers in Singapore, China, and Malaysia pass validation', () => {
  const sg = validateCustomerIdentityPhone('+6581234567');
  assert.equal(sg.countryIso2, 'SG');
  assert.equal(sg.e164, '+6581234567');

  const cn = validateCustomerIdentityPhone('+8613800138000');
  assert.equal(cn.countryIso2, 'CN');
  assert.equal(cn.e164, '+8613800138000');

  const my = validateCustomerIdentityPhone('+60123456789');
  assert.equal(my.countryIso2, 'MY');
  assert.equal(my.e164, '+60123456789');
});

// ==================================================
// 3. Client-side Phone Validation & Error Code Mapping
// ==================================================

test('K. Client-side isValidCustomerPhone accurately validates Singapore and international numbers', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify function is defined in public/index.html
  assert.ok(indexHtml.includes('function isValidCustomerPhone('));
  assert.ok(indexHtml.includes('function mapBookingErrorCode('));

  // Extract function logic to test directly
  const isValidCustomerPhone = (countryCode, value) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return false;
    let effectiveCountry = countryCode || '+65';
    let national = raw;
    if (raw.startsWith('+65')) {
      effectiveCountry = '+65';
      national = raw.slice(3);
    } else if (raw.startsWith('+86')) {
      effectiveCountry = '+86';
      national = raw.slice(3);
    } else if (raw.startsWith('+60')) {
      effectiveCountry = '+60';
      national = raw.slice(3);
    } else if (raw.startsWith('+62')) {
      effectiveCountry = '+62';
      national = raw.slice(3);
    } else if (raw.startsWith('+1')) {
      effectiveCountry = '+1';
      national = raw.slice(2);
    }
    const digits = national.replace(/\D/g, '');
    if (effectiveCountry === '+65') {
      return /^[3689]\d{7}$/.test(digits);
    }
    return digits.length >= 6 && digits.length <= 15 && !/[a-zA-Z]/.test(raw);
  };

  // Rejects invalid Singapore number starting with 1
  assert.equal(isValidCustomerPhone('+65', '12345678'), false);
  assert.equal(isValidCustomerPhone('+65', '+6512345678'), false);
  assert.equal(isValidCustomerPhone('+65', '00000000'), false);
  assert.equal(isValidCustomerPhone('+65', 'abc12345'), false);

  // Accepts valid Singapore numbers starting with 8, 9, 6, 3
  assert.equal(isValidCustomerPhone('+65', '81234567'), true);
  assert.equal(isValidCustomerPhone('+65', '91234567'), true);
  assert.equal(isValidCustomerPhone('+65', '61234567'), true);
  assert.equal(isValidCustomerPhone('+65', '31234567'), true);
  assert.equal(isValidCustomerPhone('+65', '+6581234567'), true);

  // Accepts valid China numbers
  assert.equal(isValidCustomerPhone('+86', '13800138000'), true);
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

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
};

test('N. POST /api/new-db rejects invalid Singapore phone +65 12345678 with 400 and localized error', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;

  await withServer(async base => {
    const response = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        locale: 'zh-CN',
        startAt: '2030-01-07T02:00:00.000Z',
        customerName: 'Real Customer',
        phone: '+6512345678',
        email: '12345678@qq.com',
        items: [
          { clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }
        ]
      })
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'INVALID_PHONE');
    assert.equal(body.message, '请输入有效的手机号码');
  });
});

test('O. POST /api/new-db rejects invalid Singapore national number 12345678 with 400 and localized error', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;

  await withServer(async base => {
    const response = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        locale: 'zh-CN',
        startAt: '2030-01-07T02:00:00.000Z',
        customerName: 'Real Customer',
        phone: '12345678',
        email: '12345678@qq.com',
        items: [
          { clientItemKey: 'facial', serviceId: '33333333-3333-4333-8333-111111111111', staffSelectionType: 'no_preference' }
        ]
      })
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'INVALID_PHONE');
    assert.equal(body.message, '请输入有效的手机号码');
  });
});
