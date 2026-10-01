'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  bookingIdentityPresentation,
  maskPhone,
  resolveBookingParties
} = require('../lib/customer-identity');
const {
  CustomerMemberError,
  normalizeDateOfBirth
} = require('../lib/customer-member-identity');
const { createCustomerAccountService } = require('../lib/customer-account-service');
const i18n = require('../public/shared-i18n');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('birthday preflight reuses the nullable authoritative customers DATE column', () => {
  const migration = read('migrations/037_customer_member_profile_schema.sql');
  assert.match(migration, /ADD COLUMN date_of_birth date/i);
  assert.doesNotMatch(migration, /date_of_birth DATE NOT NULL/i);
});

test('birthday is optional and rejects impossible or future dates', () => {
  assert.equal(normalizeDateOfBirth(undefined), null);
  assert.equal(normalizeDateOfBirth(''), null);
  assert.equal(normalizeDateOfBirth('2000-02-29'), '2000-02-29');
  for (const value of ['2001-02-29', '2020-13-01', 'not-a-date', '2999-01-01']) {
    assert.throws(
      () => normalizeDateOfBirth(value),
      error => error instanceof CustomerMemberError && error.code === 'DOB_INVALID'
    );
  }
});

test('booking identity presentation is masked and excludes protected profile authority', () => {
  const presentation = bookingIdentityPresentation({
    customer_id: 'customer-secret',
    name: 'Alice Tan',
    phone_normalized: '+6591234567',
    phone_verified_at: null,
    email: 'alice@example.invalid',
    date_of_birth: '1990-01-02',
    gender: 'female'
  });
  assert.deepEqual(presentation, {
    authenticated: true,
    name: 'Alice Tan',
    maskedPhone: '•••• 4567',
    isPhoneVerified: false
  });
  assert.equal(maskPhone('+65 9123 4567'), '•••• 4567');
  for (const forbidden of ['customerId', 'customer_id', 'phone', 'phoneNormalized', 'email', 'dateOfBirth', 'date_of_birth', 'gender']) {
    assert.equal(Object.hasOwn(presentation, forbidden), false);
  }
});

test('authenticated booking uses only the tenant-scoped session customer and rejects spoofed contact', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{
      id: 'customer-a', name: 'Saved Name', phone: '+6591234567',
      phone_normalized: '+6591234567', email: 'saved@example.invalid', phone_verified_at: null
    }] };
  } };
  const session = { shop_id: 'shop-a', customer_id: 'customer-a' };
  const result = await resolveBookingParties(client, { shopId: 'shop-a', verifiedSession: session, body: {} });
  assert.equal(result.booker.customerId, 'customer-a');
  assert.equal(result.bookerDraft.name, 'Saved Name');
  assert.equal(result.bookerDraft.phone, '+6591234567');
  assert.deepEqual(calls[0].params, ['shop-a', 'customer-a']);

  await assert.rejects(
    resolveBookingParties(client, {
      shopId: 'shop-a', verifiedSession: session,
      body: { phone: '+6599999999' }
    }),
    error => error.code === 'AUTHENTICATED_BOOKER_CONTACT_FORBIDDEN'
  );
  await assert.rejects(
    resolveBookingParties(client, { shopId: 'shop-b', verifiedSession: session, body: {} }),
    error => error.code === 'CUSTOMER_SESSION_SHOP_MISMATCH'
  );
});

test('anonymous international phone identity remains normalized and shop scoped', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM customers/.test(sql)) return { rows: [] };
    return { rows: [{ id: 'created-a' }] };
  } };
  const result = await resolveBookingParties(client, {
    shopId: 'shop-a',
    body: { customerName: 'Anonymous', phone: '+65 9123-4567', email: '' }
  });
  assert.equal(result.booker.phoneNormalized, '+6591234567');
  assert.deepEqual(calls[0].params, ['shop-a', '+6591234567']);
  assert.equal(result.bookerDraft.email, null);
});

test('phone-only sign-in cannot overwrite an existing protected customer profile', async () => {
  const writes = [];
  const client = { query: async (sql, params) => {
    if (/SELECT id, member_code/.test(sql)) return { rows: [{
      id: 'customer-a', member_code: 'MEM-1', name: 'Saved Name', phone: '+6591234567',
      phone_normalized: '+6591234567', phone_verified_at: null, identity_status: 'unverified_contact',
      date_of_birth: '1990-01-02', gender: 'female', email: 'saved@example.invalid'
    }] };
    writes.push({ sql, params });
    return { rows: [] };
  } };
  const service = createCustomerAccountService({ pool: { query: async () => ({ rows: [] }) } });
  const found = await service.findOrCreateCustomer(client, {
    shopId: 'shop-a', phoneNormalized: '+6591234567', name: 'Attacker Name',
    email: 'attacker@example.invalid', dateOfBirth: '2001-01-01', gender: 'male'
  });
  assert.equal(found.name, 'Saved Name');
  assert.equal(found.email, 'saved@example.invalid');
  assert.equal(found.dateOfBirth, '1990-01-02');
  assert.equal(writes.length, 0);
});

test('booking and account UIs implement authenticated summary, anonymous fields, optional request, and verified profile guard', () => {
  const booking = read('public/index.html');
  const member = read('public/member.html');
  const memberUi = read('public/customer-member-ui.js');
  const server = read('server.js');

  assert.match(booking, /id="authenticatedBookerSummary"/);
  assert.match(booking, /id="anonymousBookerFields"/);
  assert.match(booking, /\/api\/customer\/booking-identity\?shopSlug=/);
  assert.match(booking, /\.\.\.\(!authenticatedBooking \? \{/);
  assert.match(booking, /id="customerSpecialRequest" maxlength="1000"/);
  assert.match(server, /AUTHENTICATED_BOOKER_CONTACT_FORBIDDEN/);
  assert.match(server, /if\(!session\.phone_verified_at\) throw new CustomerMemberError\('CUSTOMER_PROFILE_VERIFICATION_REQUIRED',403\)/);
  assert.match(server, /bookingIdentityPresentation\(session\)/);
  assert.match(server, /resolveCustomerMemberIdentity\(\)\.updateProfile/);
  assert.match(member, /data-i18n="dateOfBirthOptional"/);
  assert.match(memberUi, /show\('editMemberProfile',isVerified\)/);
});

test('new booking and birthday UI strings are complete in Chinese and English', () => {
  const expected = {
    bookingAsAccount: ['使用以下账号预约', 'Booking with this account'],
    dateOfBirthOptional: ['出生日期（选填）', 'Date of birth (optional)'],
    dobInvalid: ['请输入有效的出生日期', 'Enter a valid date of birth'],
    profileVerificationRequired: ['验证手机号码后才可编辑个人资料', 'Verify your mobile number before editing your profile']
  };
  for (const [key, [zh, en]] of Object.entries(expected)) {
    assert.equal(i18n.t(key, 'zh-CN'), zh);
    assert.equal(i18n.t(key, 'en'), en);
  }
});
