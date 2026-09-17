'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PhoneValidationError,
  PHONE_ERROR_CODES,
  REGION_KINDS,
  isCanonicalE164,
  normalizeNationalPhone,
  normalizeE164Phone,
  validateCustomerIdentityPhone,
  isEligibleForCustomerIdentity,
  validateOtpPhone,
  isEligibleForOtp
} = require('../lib/phone-normalization');

// ==========================================
// 1. Canonical E.164 Structural Check
// ==========================================
test('isCanonicalE164 validates E.164 string format and length strictly', () => {
  // Valid canonical E.164 numbers (7 to 15 digits)
  assert.equal(isCanonicalE164('+6591234567'), true);
  assert.equal(isCanonicalE164('+60123456789'), true);
  assert.equal(isCanonicalE164('+8613812345678'), true);
  assert.equal(isCanonicalE164('+12125551234'), true);
  assert.equal(isCanonicalE164('+390612345678'), true);
  assert.equal(isCanonicalE164('+2908999'), true); // 7 digits
  assert.equal(isCanonicalE164('+5491123456789'), true); // 13 digits

  // Invalid formats
  assert.equal(isCanonicalE164('6591234567'), false); // missing '+'
  assert.equal(isCanonicalE164('+0123456789'), false); // zero after '+'
  assert.equal(isCanonicalE164('+'), false);
  assert.equal(isCanonicalE164('+1'), false);
  assert.equal(isCanonicalE164('+12345'), false); // too short (< 7 digits)
  assert.equal(isCanonicalE164('+1234567890123456'), false); // too long (> 15 digits)
  assert.equal(isCanonicalE164('+65 9123 4567'), false); // contains space
  assert.equal(isCanonicalE164('+65-9123-4567'), false); // contains hyphen
  assert.equal(isCanonicalE164('+6591234567ext1'), false); // extension
  assert.equal(isCanonicalE164(null), false);
  assert.equal(isCanonicalE164(undefined), false);
  assert.equal(isCanonicalE164(6591234567), false);
  assert.equal(isCanonicalE164({}), false);
});

// ==========================================
// 2. Positive Tests - All Required Countries
// ==========================================
test('normalizeNationalPhone successfully parses all required standard countries', () => {
  // 1. Singapore (+65)
  const sg = normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '9123 4567' });
  assert.deepEqual(sg, {
    countryIso2: 'SG',
    callingCode: '+65',
    nationalNumber: '91234567',
    e164: '+6591234567',
    regionKind: 'iso3166'
  });

  // 2. Malaysia (+60) - with trunk prefix 0
  const my = normalizeNationalPhone({ countryIso2: 'MY', nationalNumber: '012-345 6789' });
  assert.deepEqual(my, {
    countryIso2: 'MY',
    callingCode: '+60',
    nationalNumber: '123456789',
    e164: '+60123456789',
    regionKind: 'iso3166'
  });

  // 3. Indonesia (+62) - with trunk prefix 0
  const id = normalizeNationalPhone({ countryIso2: 'ID', nationalNumber: '0812-3456-7890' });
  assert.deepEqual(id, {
    countryIso2: 'ID',
    callingCode: '+62',
    nationalNumber: '81234567890',
    e164: '+6281234567890',
    regionKind: 'iso3166'
  });

  // 4. Mainland China (+86)
  const cn = normalizeNationalPhone({ countryIso2: 'CN', nationalNumber: '138 1234 5678' });
  assert.deepEqual(cn, {
    countryIso2: 'CN',
    callingCode: '+86',
    nationalNumber: '13812345678',
    e164: '+8613812345678',
    regionKind: 'iso3166'
  });

  // 5. India (+91)
  const ind = normalizeNationalPhone({ countryIso2: 'IN', nationalNumber: '98765 43210' });
  assert.deepEqual(ind, {
    countryIso2: 'IN',
    callingCode: '+91',
    nationalNumber: '9876543210',
    e164: '+919876543210',
    regionKind: 'iso3166'
  });

  // 6. Australia (+61) - with trunk prefix 0
  const au = normalizeNationalPhone({ countryIso2: 'AU', nationalNumber: '0412 345 678' });
  assert.deepEqual(au, {
    countryIso2: 'AU',
    callingCode: '+61',
    nationalNumber: '412345678',
    e164: '+61412345678',
    regionKind: 'iso3166'
  });

  // 7. Japan (+81)
  const jp = normalizeNationalPhone({ countryIso2: 'JP', nationalNumber: '090-1234-5678' });
  assert.deepEqual(jp, {
    countryIso2: 'JP',
    callingCode: '+81',
    nationalNumber: '9012345678',
    e164: '+819012345678',
    regionKind: 'iso3166'
  });

  // 8. South Korea (+82)
  const kr = normalizeNationalPhone({ countryIso2: 'KR', nationalNumber: '010-1234-5678' });
  assert.deepEqual(kr, {
    countryIso2: 'KR',
    callingCode: '+82',
    nationalNumber: '1012345678',
    e164: '+821012345678',
    regionKind: 'iso3166'
  });

  // 9. Hong Kong (+852)
  const hk = normalizeNationalPhone({ countryIso2: 'HK', nationalNumber: '9123 4567' });
  assert.deepEqual(hk, {
    countryIso2: 'HK',
    callingCode: '+852',
    nationalNumber: '91234567',
    e164: '+85291234567',
    regionKind: 'iso3166'
  });

  // 10. Taiwan (+886)
  const tw = normalizeNationalPhone({ countryIso2: 'TW', nationalNumber: '0912-345-678' });
  assert.deepEqual(tw, {
    countryIso2: 'TW',
    callingCode: '+886',
    nationalNumber: '912345678',
    e164: '+886912345678',
    regionKind: 'iso3166'
  });

  // 11. United Kingdom (+44)
  const gb = normalizeNationalPhone({ countryIso2: 'GB', nationalNumber: '07123 456789' });
  assert.deepEqual(gb, {
    countryIso2: 'GB',
    callingCode: '+44',
    nationalNumber: '7123456789',
    e164: '+447123456789',
    regionKind: 'iso3166'
  });

  // 12. United States (+1)
  const us = normalizeNationalPhone({ countryIso2: 'US', nationalNumber: '(212) 555-1234' });
  assert.deepEqual(us, {
    countryIso2: 'US',
    callingCode: '+1',
    nationalNumber: '2125551234',
    e164: '+12125551234',
    regionKind: 'iso3166'
  });

  // 13. Canada (+1)
  const ca = normalizeNationalPhone({ countryIso2: 'CA', nationalNumber: '(416) 234-5678' });
  assert.deepEqual(ca, {
    countryIso2: 'CA',
    callingCode: '+1',
    nationalNumber: '4162345678',
    e164: '+14162345678',
    regionKind: 'iso3166'
  });

  // 14. Italy (+39) - Preserves leading zero for landline/area code
  const itMilan = normalizeNationalPhone({ countryIso2: 'IT', nationalNumber: '02 1234 5678' });
  assert.deepEqual(itMilan, {
    countryIso2: 'IT',
    callingCode: '+39',
    nationalNumber: '0212345678',
    e164: '+390212345678',
    regionKind: 'iso3166'
  });
  assert.ok(itMilan.nationalNumber.startsWith('0'), 'Italy landline must preserve leading 0');
  assert.ok(itMilan.e164.startsWith('+390'), 'Italy E.164 must preserve leading 0');

  const itRome = normalizeNationalPhone({ countryIso2: 'IT', nationalNumber: '06 1234 5678' });
  assert.deepEqual(itRome, {
    countryIso2: 'IT',
    callingCode: '+39',
    nationalNumber: '0612345678',
    e164: '+390612345678',
    regionKind: 'iso3166'
  });

  // 15. Vatican City (+39) - Shares +39 with Italy and preserves leading 0
  const va = normalizeNationalPhone({ countryIso2: 'VA', nationalNumber: '06 698 12345' });
  assert.deepEqual(va, {
    countryIso2: 'VA',
    callingCode: '+39',
    nationalNumber: '0669812345',
    e164: '+390669812345',
    regionKind: 'iso3166'
  });
});

test('normalizeNationalPhone handles lowercase country ISO and pre-formatted input with +', () => {
  // Lowercase to uppercase
  const res1 = normalizeNationalPhone({ countryIso2: 'sg', nationalNumber: '91234567' });
  assert.equal(res1.countryIso2, 'SG');

  // Input already starting with +65 but valid for SG
  const res2 = normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '+65 9123 4567' });
  assert.deepEqual(res2, {
    countryIso2: 'SG',
    callingCode: '+65',
    nationalNumber: '91234567',
    e164: '+6591234567',
    regionKind: 'iso3166'
  });
});

// ==========================================
// 3. Positive Tests - normalizeE164Phone
// ==========================================
test('normalizeE164Phone parses valid international numbers and correctly disambiguates +1', () => {
  // Singapore
  const sg = normalizeE164Phone('+6591234567');
  assert.deepEqual(sg, {
    countryIso2: 'SG',
    callingCode: '+65',
    nationalNumber: '91234567',
    e164: '+6591234567',
    regionKind: 'iso3166'
  });

  // Malaysia
  const my = normalizeE164Phone('+60123456789');
  assert.deepEqual(my, {
    countryIso2: 'MY',
    callingCode: '+60',
    nationalNumber: '123456789',
    e164: '+60123456789',
    regionKind: 'iso3166'
  });

  // US vs Canada (+1 shared calling code)
  const us = normalizeE164Phone('+12125551234');
  assert.equal(us.countryIso2, 'US');
  assert.equal(us.callingCode, '+1');
  assert.equal(us.e164, '+12125551234');
  assert.equal(us.regionKind, 'iso3166');

  const ca = normalizeE164Phone('+14162345678');
  assert.equal(ca.countryIso2, 'CA');
  assert.equal(ca.callingCode, '+1');
  assert.equal(ca.e164, '+14162345678');
  assert.equal(ca.regionKind, 'iso3166');

  // Russia vs Kazakhstan (+7 shared calling code)
  const ru = normalizeE164Phone('+74951234567');
  assert.equal(ru.countryIso2, 'RU');
  assert.equal(ru.callingCode, '+7');
  assert.equal(ru.regionKind, 'iso3166');

  const kz = normalizeE164Phone('+77271234567');
  assert.equal(kz.countryIso2, 'KZ');
  assert.equal(kz.callingCode, '+7');
  assert.equal(kz.regionKind, 'iso3166');

  // Italy vs Vatican (+39 shared calling code preserving leading zero)
  const it = normalizeE164Phone('+390612345678');
  assert.equal(it.countryIso2, 'IT');
  assert.equal(it.callingCode, '+39');
  assert.equal(it.nationalNumber, '0612345678');
  assert.equal(it.e164, '+390612345678');
  assert.equal(it.regionKind, 'iso3166');

  const va = normalizeE164Phone('+390669812345');
  assert.equal(va.countryIso2, 'VA');
  assert.equal(va.callingCode, '+39');
  assert.equal(va.nationalNumber, '0669812345');
  assert.equal(va.e164, '+390669812345');
  assert.equal(va.regionKind, 'iso3166');
});

// ==========================================
// 4. Immutability and Pure Function Tests
// ==========================================
test('normalizeNationalPhone does not mutate caller input and returns fresh object', () => {
  const input = Object.freeze({
    countryIso2: 'sg',
    nationalNumber: ' 9123 4567 '
  });

  const result = normalizeNationalPhone(input);
  assert.notEqual(result, input);
  assert.equal(input.countryIso2, 'sg');
  assert.equal(input.nationalNumber, ' 9123 4567 ');
  assert.deepEqual(result, {
    countryIso2: 'SG',
    callingCode: '+65',
    nationalNumber: '91234567',
    e164: '+6591234567',
    regionKind: 'iso3166'
  });
});

// ==========================================
// 5. Negative and Security Tests
// ==========================================
test('negative: rejects missing, empty, or invalid input parameters', () => {
  // Null / undefined input
  assert.throws(() => normalizeNationalPhone(null), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone(undefined), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone('not-an-object'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });

  // Missing country ISO
  assert.throws(() => normalizeNationalPhone({ nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: '', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: '   ', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 123, nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });

  // Unsupported country ISO
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'ZZ', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_UNSUPPORTED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SGP', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_UNSUPPORTED
  });

  // Missing phone number
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '   ' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });

  // Number type input (strictly string required)
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: 91234567 }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
});

test('negative: rejects bare local number when calling normalizeE164Phone', () => {
  // Bare local number without '+' must fail-closed with PHONE_E164_REQUIRED
  assert.throws(() => normalizeE164Phone('91234567'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_REQUIRED
  });
  assert.throws(() => normalizeE164Phone('6591234567'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_REQUIRED
  });
  assert.throws(() => normalizeE164Phone(null), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeE164Phone(undefined), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeE164Phone(''), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
});

test('negative: rejects incomplete numbers starting with +', () => {
  assert.throws(() => normalizeE164Phone('+'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_INVALID
  });
  assert.throws(() => normalizeE164Phone('+1'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_INVALID
  });
  assert.throws(() => normalizeE164Phone('+65'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_INVALID
  });
  assert.throws(() => normalizeE164Phone('+659'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_INVALID
  });
});

test('negative: rejects inputs exceeding E.164 maximum digit length', () => {
  const over15Digits = '91234567890123456'; // 17 digits
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: over15Digits }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG
  });
  assert.throws(() => normalizeE164Phone(`+65${over15Digits}`), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG
  });

  const over50Chars = '91234567'.padEnd(55, '0');
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: over50Chars }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG
  });
});

test('negative: rejects alphabetical letters, script tags, HTML injection, and control characters', () => {
  // Letters
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '9123ABCD' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });

  // Script injection
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '<script>alert(1)</script>' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => normalizeE164Phone('+6591234567<script>alert(1)</script>'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_INVALID
  });

  // Control characters and newlines
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567\n' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567\r\n' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567\0' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
});

test('negative: rejects multiple concatenated numbers', () => {
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567 / 98765432' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567 or 98765432' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567 或 98765432' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED
  });
  assert.throws(() => normalizeE164Phone('+6591234567, +6598765432'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED
  });
  assert.throws(() => normalizeE164Phone('+6591234567+6598765432'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED
  });
});

test('negative: rejects phone numbers with extensions', () => {
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567 ext 123' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '91234567#123' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'US', nationalNumber: '(212) 555-1234 x456' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED
  });
  assert.throws(() => normalizeE164Phone('+12125551234;ext=789'), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED
  });
});

test('negative: rejects mismatched country and phone combinations', () => {
  // Malaysian number with SG country
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '+60123456789' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });

  // Singapore number with MY country
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'MY', nationalNumber: '+6591234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });

  // Canadian area code 416 with US country
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'US', nationalNumber: '4162345678' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });

  // Invalid Singapore subscriber number (SG valid start digits are 3, 6, 8, 9)
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '12345678' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
});

test('security: errors do not contain full phone numbers (zero PII)', () => {
  const sensitiveNumber = '987654321098765';
  try {
    normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: `${sensitiveNumber}ext123` });
    assert.fail('Should have thrown PhoneValidationError');
  } catch (err) {
    assert.equal(err.name, 'PhoneValidationError');
    assert.ok(!err.message.includes(sensitiveNumber), 'Error message must not contain full phone number');
    assert.ok(!JSON.stringify(err).includes(sensitiveNumber), 'Serialized error must not contain PII');
  }
});

// ==========================================
// 6. Non-Geographic Numbers General Parsing Tests
// ==========================================
test('general parsing: normalizeE164Phone parses valid non-geographic numbers without error', () => {
  // +800 International Freephone
  const p800 = normalizeE164Phone('+80012345678');
  assert.deepEqual(p800, {
    countryIso2: null,
    callingCode: '+800',
    nationalNumber: '12345678',
    e164: '+80012345678',
    regionKind: REGION_KINDS.NON_GEOGRAPHIC
  });
  assert.equal(p800.countryIso2, null);
  assert.equal(p800.regionKind, 'non_geographic');

  // +808 International Shared Cost Service
  const p808 = normalizeE164Phone('+80812345678');
  assert.deepEqual(p808, {
    countryIso2: null,
    callingCode: '+808',
    nationalNumber: '12345678',
    e164: '+80812345678',
    regionKind: REGION_KINDS.NON_GEOGRAPHIC
  });

  // +870 Inmarsat SNAC
  const p870 = normalizeE164Phone('+870773123456');
  assert.deepEqual(p870, {
    countryIso2: null,
    callingCode: '+870',
    nationalNumber: '773123456',
    e164: '+870773123456',
    regionKind: REGION_KINDS.NON_GEOGRAPHIC
  });
});

// ==========================================
// 7. Customer Identity & Member OTP Pure Validation Tests
// ==========================================
test('customer identity: accepts valid iso3166 phones and strictly rejects non-geographic, AC, TA, XK, and null countryIso2', () => {
  // Positive: standard ISO 3166-1 phones
  const sgValid = validateCustomerIdentityPhone('+6591234567');
  assert.equal(sgValid.countryIso2, 'SG');
  assert.equal(sgValid.regionKind, 'iso3166');
  assert.equal(sgValid.eligibleForCustomerIdentity, true);
  assert.equal(isEligibleForCustomerIdentity('+6591234567'), true);
  assert.equal(isEligibleForOtp('+6591234567'), true);

  const myValid = validateCustomerIdentityPhone({ countryIso2: 'MY', nationalNumber: '0123456789' });
  assert.equal(myValid.countryIso2, 'MY');
  assert.equal(myValid.regionKind, 'iso3166');
  assert.equal(myValid.eligibleForCustomerIdentity, true);
  assert.equal(isEligibleForCustomerIdentity(myValid), true);

  // Negative 1: countryIso2 === null (e.g. +800 non-geographic)
  assert.throws(
    () => validateCustomerIdentityPhone('+80012345678'),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity('+80012345678'), false);
  assert.equal(isEligibleForOtp('+80012345678'), false);

  // Negative 2: +808 non-geographic
  assert.throws(
    () => validateCustomerIdentityPhone('+80812345678'),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity('+80812345678'), false);

  // Negative 3: +870 non-geographic
  assert.throws(
    () => validateCustomerIdentityPhone('+870773123456'),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity('+870773123456'), false);

  // Negative 4: AC (Ascension Island - exceptional reservation)
  assert.throws(
    () => validateCustomerIdentityPhone({ countryIso2: 'AC', nationalNumber: '40123' }),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity({ countryIso2: 'AC', nationalNumber: '40123' }), false);
  assert.equal(isEligibleForCustomerIdentity('+24740123'), false);

  // Negative 5: TA (Tristan da Cunha - exceptional reservation)
  assert.throws(
    () => validateCustomerIdentityPhone({ countryIso2: 'TA', nationalNumber: '8999' }),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity({ countryIso2: 'TA', nationalNumber: '8999' }), false);
  assert.equal(isEligibleForCustomerIdentity('+2908999'), false);

  // Negative 6: XK (Kosovo - user_assigned reservation)
  assert.throws(
    () => validateCustomerIdentityPhone({ countryIso2: 'XK', nationalNumber: '43201234' }),
    {
      name: 'PhoneValidationError',
      code: PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE
    }
  );
  assert.equal(isEligibleForCustomerIdentity({ countryIso2: 'XK', nationalNumber: '43201234' }), false);
  assert.equal(isEligibleForCustomerIdentity('+38343201234'), false);
  assert.equal(isEligibleForOtp({ countryIso2: 'XK', nationalNumber: '43201234' }), false);
});

// ==========================================
// 8. Strict Input Type Safety & No Coercion Tests
// ==========================================
test('input type safety: strictly rejects Number, Object, and Array without coercion', () => {
  // 1. Number input
  assert.throws(() => normalizeNationalPhone(91234567), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: 91234567 }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => normalizeE164Phone(6591234567), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_REQUIRED
  });
  assert.throws(() => validateCustomerIdentityPhone(6591234567), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });

  // 2. Object input where string is expected
  assert.throws(() => normalizeE164Phone({ number: '+6591234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: { num: '91234567' } }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => validateCustomerIdentityPhone({ invalidProp: 'xyz' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });

  // 3. Array input
  assert.throws(() => normalizeNationalPhone(['SG', '91234567']), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: ['91234567'] }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: ['SG'], nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeE164Phone(['+6591234567']), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_E164_REQUIRED
  });
  assert.throws(() => validateCustomerIdentityPhone(['+6591234567']), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED
  });
});

// ==========================================
// 9. Fail-Closed: Missing Country ISO Never Defaults to SG
// ==========================================
test('fail-closed: missing countryIso2 fails closed and never assumes SG', () => {
  assert.throws(() => normalizeNationalPhone({ nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: null, nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: undefined, nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: '', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
  assert.throws(() => normalizeNationalPhone({ countryIso2: '   ', nationalNumber: '91234567' }), {
    name: 'PhoneValidationError',
    code: PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED
  });
});
