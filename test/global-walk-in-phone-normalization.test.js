'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeNationalPhone,
  normalizeE164Phone,
  PhoneValidationError,
  PHONE_ERROR_CODES,
  getWalkInPhoneCountries
} = require('../lib/phone-normalization');

const customerUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-self-service.js'), 'utf8');

const representativeNumbers = Object.freeze([
  ['SG', '81234567', '+6581234567'], ['MY', '123456789', '+60123456789'],
  ['ID', '812345678', '+62812345678'], ['PH', '9171234567', '+639171234567'],
  ['TH', '812345678', '+66812345678'], ['VN', '912345678', '+84912345678'],
  ['CN', '13800138000', '+8613800138000'], ['HK', '51234567', '+85251234567'],
  ['TW', '912345678', '+886912345678'], ['JP', '9012345678', '+819012345678'],
  ['KR', '1012345678', '+821012345678'], ['IN', '9876543210', '+919876543210'],
  ['BD', '1812345678', '+8801812345678'], ['LK', '771234567', '+94771234567'],
  ['NP', '9812345678', '+9779812345678'], ['AU', '412345678', '+61412345678'],
  ['NZ', '211234567', '+64211234567'], ['US', '4155552671', '+14155552671'],
  ['CA', '4165550123', '+14165550123'], ['GB', '2079460000', '+442079460000'],
  ['FR', '612345678', '+33612345678'], ['DE', '30123456', '+4930123456'],
  ['IT', '3123456789', '+393123456789'], ['ES', '612345678', '+34612345678'],
  ['NL', '612345678', '+31612345678'], ['CH', '791234567', '+41791234567'],
  ['AE', '501234567', '+971501234567'], ['SA', '501234567', '+966501234567'],
  ['ZA', '821234567', '+27821234567'], ['BR', '11987654321', '+5511987654321']
]);

test('global Walk-in selector and libphonenumber validation cover representative regions', () => {
  const selectable = new Set(getWalkInPhoneCountries('en').map(country => country.countryIso2));
  for (const [countryIso2, nationalNumber, e164] of representativeNumbers) {
    assert.ok(selectable.has(countryIso2), `${countryIso2} is offered by the Walk-in selector`);
    assert.deepEqual(normalizeNationalPhone({ countryIso2, nationalNumber }), {
      countryIso2,
      callingCode: e164.slice(0, e164.length - nationalNumber.length),
      nationalNumber,
      e164,
      regionKind: 'iso3166'
    });
  }
});

test('global phone validation rejects malformed or invalid country input and preserves canonical E.164', () => {
  assert.equal(normalizeE164Phone('+14155552671').e164, '+14155552671');
  assert.equal(normalizeE164Phone('+442079460000').e164, '+442079460000');
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'ZZ', nationalNumber: '81234567' }), error => error instanceof PhoneValidationError && error.code === PHONE_ERROR_CODES.PHONE_COUNTRY_UNSUPPORTED);
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '1234' }), error => error instanceof PhoneValidationError && error.code === PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY);
  assert.throws(() => normalizeNationalPhone({ countryIso2: 'SG', nationalNumber: '+14155552671' }), error => error instanceof PhoneValidationError && error.code === PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY);
});

test('nameless customer UI uses the canonical phone as a safe display fallback', () => {
  const fallbacks = customerUi.match(/customer\.name \|\| customer\.phone \|\| '-'/g) || [];
  assert.ok(fallbacks.length >= 2, 'customer list and profile must not render undefined names');
});
