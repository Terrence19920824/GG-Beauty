'use strict';

const {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry
} = require('libphonenumber-js');

/**
 * Top priority countries:
 * 1. SG Singapore (+65)
 * 2. MY Malaysia (+60)
 * 3. ID Indonesia (+62)
 * 4. CN Mainland China (+86)
 */
const PRIORITY_PHONE_COUNTRIES = Object.freeze([
  Object.freeze({ countryIso2: 'SG', callingCode: '+65' }),
  Object.freeze({ countryIso2: 'MY', callingCode: '+60' }),
  Object.freeze({ countryIso2: 'ID', callingCode: '+62' }),
  Object.freeze({ countryIso2: 'CN', callingCode: '+86' })
]);

const PRIORITY_COUNTRY_ISOS = Object.freeze(
  PRIORITY_PHONE_COUNTRIES.map(item => item.countryIso2)
);

/**
 * Region classification kinds:
 * - iso3166: Officially assigned ISO 3166-1 alpha-2 country/territory.
 * - exceptional: Exceptionally reserved ISO 3166-1 alpha-2 code elements (AC Ascension Island, TA Tristan da Cunha).
 * - user_assigned: User-assigned ISO 3166-1 alpha-2 code element (XK Kosovo).
 * - non_geographic: Non-geographic ITU calling codes (+800, +808, +870, etc.) without sovereign country assignment.
 */
const REGION_KINDS = Object.freeze({
  ISO3166: 'iso3166',
  EXCEPTIONAL: 'exceptional',
  USER_ASSIGNED: 'user_assigned',
  NON_GEOGRAPHIC: 'non_geographic'
});

// Private, encapsulated membership sets that are NEVER exported or modified.
const PRIVATE_EXCEPTIONAL_ISOS = new Set(['AC', 'TA']);
const PRIVATE_USER_ASSIGNED_ISOS = new Set(['XK']);
const PRIVATE_NON_GEOGRAPHIC_CODES = new Set([
  '+800',
  '+808',
  '+870',
  '+878',
  '+881',
  '+882',
  '+883',
  '+888'
]);

/**
 * Creates an immutable, uncontaminable public list.
 * It is a frozen string array with read-only .has() method.
 * Any attempt by callers to call .add(), .delete(), .clear(), .push(), etc. fails,
 * and even if tampered with, cannot alter the private internal authoritative sets.
 */
const createPublicFrozenList = items => {
  const arr = [...items];
  Object.defineProperty(arr, 'has', {
    value: val => items.includes(val),
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(arr, 'add', {
    value: () => { throw new TypeError('Cannot modify frozen classification list'); },
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(arr, 'delete', {
    value: () => { throw new TypeError('Cannot modify frozen classification list'); },
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(arr, 'clear', {
    value: () => { throw new TypeError('Cannot modify frozen classification list'); },
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(arr);
};

const EXCEPTIONAL_COUNTRY_ISOS = createPublicFrozenList(['AC', 'TA']);
const USER_ASSIGNED_COUNTRY_ISOS = createPublicFrozenList(['XK']);
const NON_GEOGRAPHIC_CALLING_CODES = createPublicFrozenList([
  '+800',
  '+808',
  '+870',
  '+878',
  '+881',
  '+882',
  '+883',
  '+888'
]);

const getExceptionalCountryIsos = () => Object.freeze(['AC', 'TA']);
const getUserAssignedCountryIsos = () => Object.freeze(['XK']);
const getNonGeographicCallingCodes = () => Object.freeze([
  '+800',
  '+808',
  '+870',
  '+878',
  '+881',
  '+882',
  '+883',
  '+888'
]);

/**
 * Classifies a country ISO or international calling code into one of 4 canonical region kinds.
 * Only reads from private encapsulated authoritative Sets.
 *
 * @param {string|null|undefined} countryIso2
 * @param {string|null|undefined} [callingCode]
 * @returns {'iso3166'|'exceptional'|'user_assigned'|'non_geographic'}
 */
const getRegionKind = (countryIso2, callingCode) => {
  if (callingCode !== undefined && callingCode !== null) {
    const rawCode = String(callingCode).trim();
    const normalizedCode = rawCode.startsWith('+') ? rawCode : `+${rawCode}`;
    if (PRIVATE_NON_GEOGRAPHIC_CODES.has(normalizedCode)) {
      return REGION_KINDS.NON_GEOGRAPHIC;
    }
  }

  if (!countryIso2 || typeof countryIso2 !== 'string') {
    return REGION_KINDS.NON_GEOGRAPHIC;
  }

  const iso = countryIso2.trim().toUpperCase();
  if (PRIVATE_EXCEPTIONAL_ISOS.has(iso)) {
    return REGION_KINDS.EXCEPTIONAL;
  }
  if (PRIVATE_USER_ASSIGNED_ISOS.has(iso)) {
    return REGION_KINDS.USER_ASSIGNED;
  }
  if (/^[A-Z]{2}$/.test(iso) && isSupportedCountry(iso)) {
    return REGION_KINDS.ISO3166;
  }

  return REGION_KINDS.NON_GEOGRAPHIC;
};

let cachedSupportedCountries = null;

/**
 * Returns a stable, deduplicated, sorted list of all supported phone regions
 * with their canonical ITU calling codes (+...) and region classification.
 *
 * Requirements:
 * - countryIso2 is unique.
 * - Calling codes may be shared (e.g. US and CA both share +1).
 * - Stable alphabetical order by countryIso2.
 *
 * @returns {ReadonlyArray<Readonly<{ countryIso2: string, iso2: string, callingCode: string, regionKind: string }>>}
 */
const getSupportedPhoneCountries = () => {
  if (cachedSupportedCountries) {
    return cachedSupportedCountries;
  }

  const rawCountries = getCountries();
  const seen = new Set();
  const list = [];

  for (const iso of rawCountries) {
    if (typeof iso === 'string' && /^[A-Z]{2}$/.test(iso) && !seen.has(iso)) {
      seen.add(iso);
      try {
        const callingCode = `+${getCountryCallingCode(iso)}`;
        const regionKind = getRegionKind(iso, callingCode);
        list.push(Object.freeze({
          countryIso2: iso,
          iso2: iso,
          callingCode,
          regionKind
        }));
      } catch (_) {
        // Exclude any region that does not have a valid calling code
      }
    }
  }

  list.sort((a, b) => a.countryIso2.localeCompare(b.countryIso2));
  cachedSupportedCountries = Object.freeze(list);
  return cachedSupportedCountries;
};

/**
 * Validates if the provided ISO string is a supported country in libphonenumber-js.
 *
 * @param {string} iso
 * @returns {boolean}
 */
const isSupportedCountryIso = iso => {
  if (typeof iso !== 'string') return false;
  const normalized = iso.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) && isSupportedCountry(normalized);
};

/**
 * Returns the calling code for a valid country ISO (e.g. '+65'), or null if unsupported.
 *
 * @param {string} iso
 * @returns {string|null}
 */
const getCallingCodeForCountry = iso => {
  if (!isSupportedCountryIso(iso)) return null;
  const normalized = iso.trim().toUpperCase();
  try {
    return `+${getCountryCallingCode(normalized)}`;
  } catch (_) {
    return null;
  }
};

const displayNamesZh = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const displayNamesEn = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Normalizes locale parameter to 'zh-CN' or 'en'.
 *
 * @param {string} [locale]
 * @returns {'zh-CN'|'en'}
 */
const normalizeLocale = locale => {
  if (typeof locale === 'string' && locale.trim().toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en';
};

/**
 * Authoritative Selector API for Customer Phone Country Selection.
 *
 * Requirements:
 * - Output items contain: { iso2, countryIso2, callingCode, localizedName, regionKind }
 * - Default filter: strictly regionKind === 'iso3166'.
 * - AC and TA (exceptional) and XK (user_assigned) are excluded.
 * - Non-geographic calling codes are excluded.
 * - Top 4 priority items are strictly: SG, MY, ID, CN.
 * - Remaining items are sorted stably by localizedName in the given locale, tie-broken by iso2.
 * - Single-language rendering: zh-CN has zero English letters; en has zero Chinese characters; no bilingual slashes.
 * - Immutability: returns fresh array and fresh objects on every invocation to prevent caller mutation from polluting internal data.
 *
 * @param {string} [locale='zh-CN'] - 'zh-CN' or 'en'
 * @returns {Array<{ iso2: string, countryIso2: string, callingCode: string, localizedName: string, regionKind: string }>}
 */
const getCustomerPhoneSelectorCountries = (locale = 'zh-CN') => {
  const normLocale = normalizeLocale(locale);
  const dn = normLocale === 'zh-CN' ? displayNamesZh : displayNamesEn;
  const allCountries = getSupportedPhoneCountries();

  // Filter strictly to iso3166 (excludes AC, TA, XK, non_geographic)
  const eligible = allCountries.filter(c => c.regionKind === REGION_KINDS.ISO3166);

  // Top 4 priority items
  const priorityItems = [];
  for (const iso of PRIORITY_COUNTRY_ISOS) {
    const found = eligible.find(c => c.countryIso2 === iso);
    if (found) {
      const localizedName = dn.of(found.countryIso2) || found.countryIso2;
      priorityItems.push({
        iso2: found.countryIso2,
        countryIso2: found.countryIso2,
        callingCode: found.callingCode,
        localizedName,
        regionKind: found.regionKind
      });
    }
  }

  // Remaining items
  const remaining = [];
  for (const c of eligible) {
    if (!PRIORITY_COUNTRY_ISOS.includes(c.countryIso2)) {
      const localizedName = dn.of(c.countryIso2) || c.countryIso2;
      remaining.push({
        iso2: c.countryIso2,
        countryIso2: c.countryIso2,
        callingCode: c.callingCode,
        localizedName,
        regionKind: c.regionKind
      });
    }
  }

  remaining.sort((a, b) => {
    const cmp = a.localizedName.localeCompare(b.localizedName, normLocale);
    return cmp !== 0 ? cmp : a.iso2.localeCompare(b.iso2);
  });

  return [...priorityItems, ...remaining];
};

/**
 * Pure function search over customer phone selector countries.
 * Searches by country name, calling code, or ISO2 code.
 * Returns fresh objects.
 *
 * @param {string} query
 * @param {string} [locale='zh-CN']
 * @returns {Array<{ iso2: string, countryIso2: string, callingCode: string, localizedName: string, regionKind: string }>}
 */
const searchCustomerPhoneSelectorCountries = (query, locale = 'zh-CN') => {
  const list = getCustomerPhoneSelectorCountries(locale);
  if (!query || typeof query !== 'string') {
    return list;
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return list;
  }
  const qWithoutPlus = q.startsWith('+') ? q.slice(1) : q;

  return list.filter(item => {
    if (item.iso2.toLowerCase().includes(q)) return true;
    if (item.callingCode.toLowerCase().includes(q)) return true;
    const codeDigits = item.callingCode.replace(/^\+/, '');
    if (qWithoutPlus && codeDigits.startsWith(qWithoutPlus)) return true;
    if (item.localizedName.toLowerCase().includes(q)) return true;
    return false;
  });
};

module.exports = {
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  REGION_KINDS,
  EXCEPTIONAL_COUNTRY_ISOS,
  USER_ASSIGNED_COUNTRY_ISOS,
  NON_GEOGRAPHIC_CALLING_CODES,
  getExceptionalCountryIsos,
  getUserAssignedCountryIsos,
  getNonGeographicCallingCodes,
  getRegionKind,
  getSupportedPhoneCountries,
  isSupportedCountryIso,
  getCallingCodeForCountry,
  getCustomerPhoneSelectorCountries,
  searchCustomerPhoneSelectorCountries
};
