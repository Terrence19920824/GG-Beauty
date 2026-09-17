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

let cachedSupportedCountries = null;

/**
 * Returns a stable, deduplicated, sorted list of all supported ISO 3166-1 alpha-2
 * countries with their canonical ITU calling codes (+...).
 *
 * Requirements:
 * - countryIso2 is unique.
 * - Calling codes may be shared (e.g. US and CA both share +1).
 * - Stable alphabetical order by countryIso2.
 * - Excludes non-geographic/pseudo regions.
 *
 * @returns {ReadonlyArray<Readonly<{ countryIso2: string, callingCode: string }>>}
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
        list.push(Object.freeze({
          countryIso2: iso,
          callingCode
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
 * Validates if the provided ISO string is a supported ISO 3166-1 alpha-2 country.
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

module.exports = {
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries,
  isSupportedCountryIso,
  getCallingCodeForCountry
};
