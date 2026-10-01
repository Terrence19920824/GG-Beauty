'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const { getWalkInPhoneCountries, resolvePhoneCountryIso } = require('../lib/phone-normalization');
const { normalizeSelectedPhone, normalizeDateOfBirth, CustomerMemberError } = require('../lib/customer-member-identity');
const { validateBookingPhone } = require('../server');
const phoneSelector = require('../public/customer-phone-selector');
const i18n = require('../public/shared-i18n');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('customer phone surfaces reuse the complete searchable global source', () => {
  const countries = getWalkInPhoneCountries('en');
  assert.ok(countries.length >= 240);
  for (const iso of ['SG', 'CN', 'MY', 'US', 'JP', 'GB', 'AU', 'DE', 'BR', 'ZA']) {
    assert.ok(countries.some(country => country.countryIso2 === iso), `${iso} is selectable`);
  }
  const matches = phoneSelector.filterCountries(countries, '+44');
  assert.ok(matches.some(country => country.countryIso2 === 'GB'));
  assert.ok(phoneSelector.filterCountries(countries, 'japan').some(country => country.countryIso2 === 'JP'));

  const booking = read('public/index.html');
  const member = read('public/member.html');
  const memberUi = read('public/customer-member-ui.js');
  const server = read('server.js');
  for (const id of ['bookerCountrySearch', 'recipientCountrySearch']) assert.match(booking, new RegExp(`id="${id}"`));
  for (const id of ['countrySearch', 'changeCountrySearch']) assert.match(member, new RegExp(`id="${id}"`));
  assert.match(booking, /customer-phone-selector\.js/);
  assert.match(member, /customer-phone-selector\.js/);
  assert.match(memberUi, /phoneSelector\.bind/);
  assert.match(server, /app\.get\('\/api\/customer\/phone-countries'/);
  assert.doesNotMatch(booking, /const COUNTRY_CODES/);
  assert.doesNotMatch(memberUi, /const countries=/);
});

test('public phone-country endpoint serves the shared localized worldwide source', async () => {
  const { app } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    for (const locale of ['zh-CN', 'en']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/customer/phone-countries?locale=${locale}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control') || '', /public/);
      const result = await response.json();
      assert.equal(result.success, true);
      assert.ok(result.data.length >= 240);
      for (const iso of ['SG', 'CN', 'MY', 'US', 'JP', 'GB', 'AU', 'DE', 'BR', 'ZA']) {
        assert.ok(result.data.some(country => country.countryIso2 === iso), `${iso} is served for ${locale}`);
      }
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('member and anonymous phone authority uses ISO context and canonical libphonenumber output', () => {
  const cases = [
    ['SG', '81234567', '+6581234567'],
    ['CN', '13800138000', '+8613800138000'],
    ['MY', '123456789', '+60123456789'],
    ['US', '4155552671', '+14155552671'],
    ['JP', '9012345678', '+819012345678'],
    ['GB', '2079460000', '+442079460000'],
    ['AU', '412345678', '+61412345678'],
    ['BR', '11987654321', '+5511987654321']
  ];
  for (const [countryCode, phone, expected] of cases) {
    assert.equal(normalizeSelectedPhone({ countryCode, phone }), expected);
  }
  assert.equal(normalizeSelectedPhone({ countryCode: '+65', phone: '8123 4567' }), '+6581234567');
  assert.equal(validateBookingPhone('0044 20 7946 0000', 'GB'), '+442079460000');
  assert.equal(resolvePhoneCountryIso('+1'), 'US');
  assert.equal(resolvePhoneCountryIso('+7'), null, 'ambiguous shared calling codes fail closed');
  assert.equal(normalizeSelectedPhone({ countryCode: 'SG', phone: '1234' }), null);
  assert.equal(normalizeSelectedPhone({ countryCode: 'ZZ', phone: '81234567' }), null);
});

test('shared selector preserves the historical +1 US default and fails ambiguous calling codes closed', async () => {
  const countries = getWalkInPhoneCountries('en');
  const select = {
    value: '',
    options: [],
    ownerDocument: { createElement: () => ({ value: '', textContent: '', tagName: 'OPTION' }) },
    addEventListener() {},
    appendChild(option) { this.options.push(option); },
    set textContent(_value) { this.options = []; }
  };
  const selector = phoneSelector.bind({
    select,
    defaultCountry: 'SG',
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, data: countries }) })
  });
  await selector.load('en', '+1');
  assert.equal(select.value, 'US');
  await selector.load('en', '+7');
  assert.equal(select.value, 'SG');
});

test('birthday registration is a clear optional second step and verified profile editing stays protected', () => {
  const member = read('public/member.html');
  const ui = read('public/customer-member-ui.js');
  const server = read('server.js');
  const registration = member.slice(member.indexOf('id="registrationStep"'), member.indexOf('id="authMessage"'));
  assert.ok(registration.indexOf('registrationName') < registration.indexOf('registrationDob'));
  assert.ok(registration.indexOf('registrationDob') < registration.indexOf('registrationEmail'));
  assert.match(registration, /registrationDob" type="date" autocomplete="bday"/);
  assert.doesNotMatch(registration, /registrationGender/);
  assert.match(ui, /function showRegistrationStep\(\)/);
  assert.match(ui, /show\('phoneStep',false\)/);
  assert.match(ui, /registrationDob'\)\.max/);
  assert.match(server, /if\(!session\.phone_verified_at\) throw new CustomerMemberError\('CUSTOMER_PROFILE_VERIFICATION_REQUIRED',403\)/);
  assert.match(read('lib/customer-account-service.js'), /dateOfBirth: isVerified \? c\.date_of_birth : null/);
  assert.equal(i18n.t('dateOfBirthOptional', 'zh-CN'), '生日（选填）');
  assert.equal(i18n.t('dateOfBirthOptional', 'en'), 'Birthday (optional)');
  assert.equal(normalizeDateOfBirth(''), null);
  assert.equal(normalizeDateOfBirth('2000-02-29'), '2000-02-29');
  for (const invalid of ['2001-02-29', '2999-01-01']) {
    assert.throws(() => normalizeDateOfBirth(invalid), error => error instanceof CustomerMemberError && error.code === 'DOB_INVALID');
  }
});

test('announcement schema preflight confirms one non-localized merchant-authored field', () => {
  const schema = read('migrations/085_merchant_business_profile_schema.sql');
  const merchant = read('lib/merchant-contact.js');
  assert.match(schema, /customer_announcement_text text NULL/);
  assert.doesNotMatch(schema, /customer_announcement_text_(?:zh|en)/);
  assert.match(merchant, /row\.customer_announcement_text/);
  assert.doesNotMatch(merchant, /customer_announcement_text_(?:zh|en)/);
});

test('calendar visual hierarchy distinguishes hours, half-hours, and quarter labels without changing 15-minute snapping', () => {
  const admin = read('public/admin.html');
  const css = read('public/calendar-shared.css');
  assert.match(admin, /is-major is-hour/);
  assert.match(admin, /is-minor is-half-hour/);
  assert.match(admin, /is-minor is-quarter-hour/);
  assert.match(css, /\.owner-calendar-time-tick\.is-hour/);
  assert.match(css, /\.owner-calendar-time-tick\.is-half-hour/);
  assert.match(css, /\.owner-calendar-time-tick\.is-quarter-hour/);
  assert.match(css, /37\.5px/);
  assert.match(css, /75px/);
  assert.doesNotMatch(css, /18\.75px/);
  assert.match(admin, /const FRONT_DESK_SLOT_MINUTES = 15/);
  assert.match(admin, /Math\.round\(rawMinutes \/ FRONT_DESK_SLOT_MINUTES\) \* FRONT_DESK_SLOT_MINUTES/);
});
