'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries,
  isSupportedCountryIso,
  getCallingCodeForCountry
} = require('../lib/phone-country-metadata');

test('PRIORITY_PHONE_COUNTRIES has exact 4 countries in precise product order', () => {
  assert.equal(PRIORITY_PHONE_COUNTRIES.length, 4);
  assert.deepEqual(PRIORITY_PHONE_COUNTRIES[0], { countryIso2: 'SG', callingCode: '+65' });
  assert.deepEqual(PRIORITY_PHONE_COUNTRIES[1], { countryIso2: 'MY', callingCode: '+60' });
  assert.deepEqual(PRIORITY_PHONE_COUNTRIES[2], { countryIso2: 'ID', callingCode: '+62' });
  assert.deepEqual(PRIORITY_PHONE_COUNTRIES[3], { countryIso2: 'CN', callingCode: '+86' });

  assert.deepEqual(PRIORITY_COUNTRY_ISOS, ['SG', 'MY', 'ID', 'CN']);

  // Immutability check
  assert.ok(Object.isFrozen(PRIORITY_PHONE_COUNTRIES));
  assert.ok(Object.isFrozen(PRIORITY_COUNTRY_ISOS));
  for (const item of PRIORITY_PHONE_COUNTRIES) {
    assert.ok(Object.isFrozen(item));
    assert.throws(() => {
      item.countryIso2 = 'XX';
    });
  }
});

test('getSupportedPhoneCountries covers all standard regions with unique countryIso2', () => {
  const list = getSupportedPhoneCountries();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 240, `Expected >= 240 countries, got ${list.length}`);

  const seenIso = new Set();
  for (const item of list) {
    assert.ok(typeof item.countryIso2 === 'string');
    assert.match(item.countryIso2, /^[A-Z]{2}$/);
    assert.ok(!seenIso.has(item.countryIso2), `Duplicate countryIso2 found: ${item.countryIso2}`);
    seenIso.add(item.countryIso2);

    assert.ok(typeof item.callingCode === 'string');
    assert.match(item.callingCode, /^\+[1-9][0-9]{0,3}$/);
    assert.ok(Object.isFrozen(item));
  }

  // Calling code sharing is allowed (e.g. US and CA share +1)
  const usItem = list.find(x => x.countryIso2 === 'US');
  const caItem = list.find(x => x.countryIso2 === 'CA');
  assert.ok(usItem && caItem);
  assert.equal(usItem.callingCode, '+1');
  assert.equal(caItem.callingCode, '+1');
  assert.notEqual(usItem.countryIso2, caItem.countryIso2);

  // All priority countries must be present in the full supported list
  for (const p of PRIORITY_PHONE_COUNTRIES) {
    const found = list.find(x => x.countryIso2 === p.countryIso2);
    assert.ok(found, `Priority country ${p.countryIso2} must be in supported list`);
    assert.equal(found.callingCode, p.callingCode);
  }

  // India, Australia and other strategic countries must be in full list
  assert.ok(list.some(x => x.countryIso2 === 'IN' && x.callingCode === '+91'));
  assert.ok(list.some(x => x.countryIso2 === 'AU' && x.callingCode === '+61'));
  assert.ok(list.some(x => x.countryIso2 === 'GB' && x.callingCode === '+44'));
  assert.ok(list.some(x => x.countryIso2 === 'IT' && x.callingCode === '+39'));
  assert.ok(list.some(x => x.countryIso2 === 'JP' && x.callingCode === '+81'));
  assert.ok(list.some(x => x.countryIso2 === 'KR' && x.callingCode === '+82'));
  assert.ok(list.some(x => x.countryIso2 === 'HK' && x.callingCode === '+852'));
  assert.ok(list.some(x => x.countryIso2 === 'TW' && x.callingCode === '+886'));

  // Stable ordering check
  const sortedCopy = [...list].sort((a, b) => a.countryIso2.localeCompare(b.countryIso2));
  assert.deepEqual(list, sortedCopy);

  // Cache consistency check
  const list2 = getSupportedPhoneCountries();
  assert.equal(list, list2);
});

test('isSupportedCountryIso validates country codes safely', () => {
  assert.equal(isSupportedCountryIso('SG'), true);
  assert.equal(isSupportedCountryIso('sg'), true);
  assert.equal(isSupportedCountryIso('  MY  '), true);
  assert.equal(isSupportedCountryIso('ID'), true);
  assert.equal(isSupportedCountryIso('CN'), true);
  assert.equal(isSupportedCountryIso('US'), true);
  assert.equal(isSupportedCountryIso('CA'), true);

  // Negative checks
  assert.equal(isSupportedCountryIso(''), false);
  assert.equal(isSupportedCountryIso('   '), false);
  assert.equal(isSupportedCountryIso('ZZ'), false);
  assert.equal(isSupportedCountryIso('SGP'), false);
  assert.equal(isSupportedCountryIso(null), false);
  assert.equal(isSupportedCountryIso(undefined), false);
  assert.equal(isSupportedCountryIso(123), false);
  assert.equal(isSupportedCountryIso(true), false);
  assert.equal(isSupportedCountryIso({}), false);
});

test('getCallingCodeForCountry returns correct prefix or null', () => {
  assert.equal(getCallingCodeForCountry('SG'), '+65');
  assert.equal(getCallingCodeForCountry('sg'), '+65');
  assert.equal(getCallingCodeForCountry('MY'), '+60');
  assert.equal(getCallingCodeForCountry('ID'), '+62');
  assert.equal(getCallingCodeForCountry('CN'), '+86');
  assert.equal(getCallingCodeForCountry('IN'), '+91');
  assert.equal(getCallingCodeForCountry('AU'), '+61');
  assert.equal(getCallingCodeForCountry('US'), '+1');
  assert.equal(getCallingCodeForCountry('CA'), '+1');
  assert.equal(getCallingCodeForCountry('IT'), '+39');

  // Negative checks
  assert.equal(getCallingCodeForCountry('ZZ'), null);
  assert.equal(getCallingCodeForCountry(''), null);
  assert.equal(getCallingCodeForCountry(null), null);
  assert.equal(getCallingCodeForCountry(undefined), null);
});
