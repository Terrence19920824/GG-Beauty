'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  REGION_KINDS,
  EXCEPTIONAL_COUNTRY_ISOS,
  USER_ASSIGNED_COUNTRY_ISOS,
  NON_GEOGRAPHIC_CALLING_CODES,
  getRegionKind,
  getSupportedPhoneCountries,
  isSupportedCountryIso,
  getCallingCodeForCountry,
  getCustomerPhoneSelectorCountries,
  searchCustomerPhoneSelectorCountries
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

test('getSupportedPhoneCountries covers all standard regions with unique countryIso2 and regionKind', () => {
  const list = getSupportedPhoneCountries();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 240, `Expected >= 240 countries, got ${list.length}`);

  const seenIso = new Set();
  for (const item of list) {
    assert.ok(typeof item.countryIso2 === 'string');
    assert.match(item.countryIso2, /^[A-Z]{2}$/);
    assert.equal(item.iso2, item.countryIso2);
    assert.ok(!seenIso.has(item.countryIso2), `Duplicate countryIso2 found: ${item.countryIso2}`);
    seenIso.add(item.countryIso2);

    assert.ok(typeof item.callingCode === 'string');
    assert.match(item.callingCode, /^\+[1-9][0-9]{0,3}$/);
    assert.ok(typeof item.regionKind === 'string');
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
    assert.equal(found.regionKind, REGION_KINDS.ISO3166);
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

// ==========================================
// Region Classification Tests
// ==========================================
test('region classification: accurately classifies iso3166, exceptional, user_assigned, and non_geographic', () => {
  // iso3166
  assert.equal(getRegionKind('SG'), REGION_KINDS.ISO3166);
  assert.equal(getRegionKind('MY'), REGION_KINDS.ISO3166);
  assert.equal(getRegionKind('ID'), REGION_KINDS.ISO3166);
  assert.equal(getRegionKind('CN'), REGION_KINDS.ISO3166);
  assert.equal(getRegionKind('US'), REGION_KINDS.ISO3166);
  assert.equal(getRegionKind('GB'), REGION_KINDS.ISO3166);

  // Exceptional reservation: AC (Ascension Island) and TA (Tristan da Cunha)
  assert.equal(getRegionKind('AC'), REGION_KINDS.EXCEPTIONAL);
  assert.equal(getRegionKind('ac'), REGION_KINDS.EXCEPTIONAL);
  assert.equal(getRegionKind('TA'), REGION_KINDS.EXCEPTIONAL);
  assert.equal(getRegionKind('ta'), REGION_KINDS.EXCEPTIONAL);

  // User-assigned: XK (Kosovo)
  assert.equal(getRegionKind('XK'), REGION_KINDS.USER_ASSIGNED);
  assert.equal(getRegionKind('xk'), REGION_KINDS.USER_ASSIGNED);

  // Non-geographic calling codes
  assert.equal(getRegionKind(null, '+800'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '800'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+808'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+870'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+878'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+881'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+882'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+883'), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(null, '+888'), REGION_KINDS.NON_GEOGRAPHIC);

  // Null / undefined country ISO defaults to non_geographic
  assert.equal(getRegionKind(null), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(undefined), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind(''), REGION_KINDS.NON_GEOGRAPHIC);
  assert.equal(getRegionKind('UNKNOWN'), REGION_KINDS.NON_GEOGRAPHIC);
});

// ==========================================
// Customer Phone Selector API Tests
// ==========================================
test('getCustomerPhoneSelectorCountries: strict top 4 priority ordering and default filter', () => {
  const zhList = getCustomerPhoneSelectorCountries('zh-CN');
  const enList = getCustomerPhoneSelectorCountries('en');

  // Must have >= 240 items
  assert.ok(zhList.length >= 240);
  assert.equal(zhList.length, enList.length);

  // Top 4 MUST BE PRECISELY SG, MY, ID, CN
  assert.equal(zhList[0].iso2, 'SG');
  assert.equal(zhList[0].callingCode, '+65');
  assert.equal(zhList[0].localizedName, '新加坡');
  assert.equal(zhList[0].regionKind, 'iso3166');

  assert.equal(zhList[1].iso2, 'MY');
  assert.equal(zhList[1].callingCode, '+60');
  assert.equal(zhList[1].localizedName, '马来西亚');
  assert.equal(zhList[1].regionKind, 'iso3166');

  assert.equal(zhList[2].iso2, 'ID');
  assert.equal(zhList[2].callingCode, '+62');
  assert.equal(zhList[2].localizedName, '印度尼西亚');
  assert.equal(zhList[2].regionKind, 'iso3166');

  assert.equal(zhList[3].iso2, 'CN');
  assert.equal(zhList[3].callingCode, '+86');
  assert.equal(zhList[3].localizedName, '中国');
  assert.equal(zhList[3].regionKind, 'iso3166');

  // English top 4
  assert.equal(enList[0].iso2, 'SG');
  assert.equal(enList[0].callingCode, '+65');
  assert.equal(enList[0].localizedName, 'Singapore');

  assert.equal(enList[1].iso2, 'MY');
  assert.equal(enList[1].callingCode, '+60');
  assert.equal(enList[1].localizedName, 'Malaysia');

  assert.equal(enList[2].iso2, 'ID');
  assert.equal(enList[2].callingCode, '+62');
  assert.equal(enList[2].localizedName, 'Indonesia');

  assert.equal(enList[3].iso2, 'CN');
  assert.equal(enList[3].callingCode, '+86');
  assert.equal(enList[3].localizedName, 'China');

  // AC, TA, XK MUST NOT appear in the default selector
  assert.equal(zhList.some(x => x.iso2 === 'AC'), false);
  assert.equal(zhList.some(x => x.iso2 === 'TA'), false);
  assert.equal(zhList.some(x => x.iso2 === 'XK'), false);
  assert.equal(enList.some(x => x.iso2 === 'AC'), false);
  assert.equal(enList.some(x => x.iso2 === 'TA'), false);
  assert.equal(enList.some(x => x.iso2 === 'XK'), false);

  // Non-geographic calling codes MUST NOT appear
  assert.equal(zhList.some(x => x.callingCode === '+800'), false);
  assert.equal(zhList.some(x => x.callingCode === '+808'), false);
  assert.equal(zhList.some(x => x.callingCode === '+870'), false);

  // All returned items must have regionKind === 'iso3166'
  for (const item of zhList) {
    assert.equal(item.regionKind, REGION_KINDS.ISO3166);
  }

  // No duplicate iso2
  const seenIso = new Set();
  for (const item of zhList) {
    assert.ok(!seenIso.has(item.iso2), `Duplicate iso2: ${item.iso2}`);
    seenIso.add(item.iso2);
  }

  // Stable ordering: remaining items (from index 4 onwards) must be sorted by localizedName
  const remaining = zhList.slice(4);
  for (let i = 0; i < remaining.length - 1; i++) {
    const cmp = remaining[i].localizedName.localeCompare(remaining[i + 1].localizedName, 'zh-CN');
    assert.ok(cmp <= 0, `Ordering violation between ${remaining[i].localizedName} and ${remaining[i + 1].localizedName}`);
  }
});

test('getCustomerPhoneSelectorCountries: language purity (no bilingual concatenation)', () => {
  const zhList = getCustomerPhoneSelectorCountries('zh-CN');
  const enList = getCustomerPhoneSelectorCountries('en');

  // Chinese mode: localizedName must not contain ASCII English letters [a-zA-Z]
  for (const item of zhList) {
    assert.ok(
      !/[a-zA-Z]/.test(item.localizedName),
      `ZH name contains English letters: ${item.iso2} -> ${item.localizedName}`
    );
    assert.ok(
      !item.localizedName.includes('/'),
      `ZH name contains bilingual slash: ${item.iso2} -> ${item.localizedName}`
    );
  }

  // English mode: localizedName must not contain Chinese characters
  for (const item of enList) {
    assert.ok(
      !/[\u4e00-\u9fa5]/.test(item.localizedName),
      `EN name contains Chinese characters: ${item.iso2} -> ${item.localizedName}`
    );
    assert.ok(
      !item.localizedName.includes('/'),
      `EN name contains bilingual slash: ${item.iso2} -> ${item.localizedName}`
    );
  }
});

test('getCustomerPhoneSelectorCountries: deep immutability across calls', () => {
  const list1 = getCustomerPhoneSelectorCountries('zh-CN');
  const initialLen = list1.length;
  const originalName = list1[0].localizedName;
  const originalCode = list1[0].callingCode;

  // Caller mutates array
  list1.pop();
  list1.shift();
  assert.equal(list1.length, initialLen - 2);

  // Caller mutates object properties
  if (list1[0]) {
    list1[0].localizedName = 'MODIFIED_LOCALIZED_NAME';
    list1[0].callingCode = '+9999';
    list1[0].iso2 = 'ZZ';
    list1[0].regionKind = 'hacked';
  }

  // Subsequent call MUST return fresh, unpolluted data
  const list2 = getCustomerPhoneSelectorCountries('zh-CN');
  assert.equal(list2.length, initialLen);
  assert.equal(list2[0].iso2, 'SG');
  assert.equal(list2[0].localizedName, originalName);
  assert.equal(list2[0].callingCode, originalCode);
  assert.equal(list2[0].regionKind, 'iso3166');
});

// ==========================================
// Search Functionality Tests
// ==========================================
test('searchCustomerPhoneSelectorCountries: searches by Calling Code, ISO, and Country Name', () => {
  // 1. Calling Code search
  const resCodeWithPlus = searchCustomerPhoneSelectorCountries('+65', 'zh-CN');
  assert.ok(resCodeWithPlus.some(x => x.iso2 === 'SG'));

  const resCodeWithoutPlus = searchCustomerPhoneSelectorCountries('65', 'zh-CN');
  assert.ok(resCodeWithoutPlus.some(x => x.iso2 === 'SG'));

  // Shared calling code (+1) returns multiple (US, CA, etc.)
  const res1 = searchCustomerPhoneSelectorCountries('+1', 'en');
  assert.ok(res1.some(x => x.iso2 === 'US'));
  assert.ok(res1.some(x => x.iso2 === 'CA'));

  // 2. ISO search
  const resIsoUpper = searchCustomerPhoneSelectorCountries('SG', 'zh-CN');
  assert.ok(resIsoUpper.some(x => x.iso2 === 'SG'));

  const resIsoLower = searchCustomerPhoneSelectorCountries('my', 'zh-CN');
  assert.ok(resIsoLower.some(x => x.iso2 === 'MY'));

  // 3. Country Name search (Chinese)
  const resNameZh = searchCustomerPhoneSelectorCountries('新加坡', 'zh-CN');
  assert.equal(resNameZh.length, 1);
  assert.equal(resNameZh[0].iso2, 'SG');

  // Country Name search (English)
  const resNameEn = searchCustomerPhoneSelectorCountries('Malaysia', 'en');
  assert.equal(resNameEn.length, 1);
  assert.equal(resNameEn[0].iso2, 'MY');

  // Empty or invalid search returns all
  assert.equal(searchCustomerPhoneSelectorCountries('', 'zh-CN').length, getCustomerPhoneSelectorCountries('zh-CN').length);
  assert.equal(searchCustomerPhoneSelectorCountries(null, 'zh-CN').length, getCustomerPhoneSelectorCountries('zh-CN').length);
});
