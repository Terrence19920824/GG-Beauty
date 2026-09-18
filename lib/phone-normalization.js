'use strict';

const { parsePhoneNumberWithError } = require('libphonenumber-js');
const {
  isSupportedCountryIso,
  getCallingCodeForCountry,
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries,
  getCustomerPhoneSelectorCountries,
  searchCustomerPhoneSelectorCountries,
  REGION_KINDS,
  getRegionKind,
  EXCEPTIONAL_COUNTRY_ISOS,
  USER_ASSIGNED_COUNTRY_ISOS,
  NON_GEOGRAPHIC_CALLING_CODES,
  getExceptionalCountryIsos,
  getUserAssignedCountryIsos,
  getNonGeographicCallingCodes
} = require('./phone-country-metadata');

class PhoneValidationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PhoneValidationError';
    this.code = code;
  }
}

const PHONE_ERROR_CODES = Object.freeze({
  PHONE_INPUT_REQUIRED: 'PHONE_INPUT_REQUIRED',
  PHONE_COUNTRY_REQUIRED: 'PHONE_COUNTRY_REQUIRED',
  PHONE_COUNTRY_UNSUPPORTED: 'PHONE_COUNTRY_UNSUPPORTED',
  PHONE_INPUT_TOO_LONG: 'PHONE_INPUT_TOO_LONG',
  PHONE_EXTENSION_NOT_ALLOWED: 'PHONE_EXTENSION_NOT_ALLOWED',
  PHONE_MULTIPLE_VALUES_NOT_ALLOWED: 'PHONE_MULTIPLE_VALUES_NOT_ALLOWED',
  PHONE_INVALID_FOR_COUNTRY: 'PHONE_INVALID_FOR_COUNTRY',
  PHONE_E164_REQUIRED: 'PHONE_E164_REQUIRED',
  PHONE_E164_INVALID: 'PHONE_E164_INVALID',
  PHONE_CUSTOMER_IDENTITY_INELIGIBLE: 'PHONE_CUSTOMER_IDENTITY_INELIGIBLE'
});

/**
 * Checks whether a string conforms to canonical ITU E.164 format:
 * Must start with '+' followed by a non-zero digit and 6 to 14 additional digits
 * (total 7 to 15 digits).
 *
 * NOTE: ITU-T E.164 specifies a maximum of 15 digits (excluding '+').
 * The minimum of 7 digits is an application-level GG-Beauty product policy
 * (based on the shortest valid national subscriber numbers plus country calling
 * code across target operational markets), not an ITU guarantee.
 *
 * NOTE: This is a fast structural check and does NOT replace authoritative country validation.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
const isCanonicalE164 = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);

const sanitizeInputCheck = (untrimmed, isE164Mode) => {
  if (untrimmed.length > 50) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG,
      'Phone number is too long'
    );
  }

  // Reject control characters, newlines, tabs, and HTML/script injection characters
  if (/[\r\n\t\0\x00-\x1f<>]/.test(untrimmed)) {
    throw new PhoneValidationError(
      isE164Mode ? PHONE_ERROR_CODES.PHONE_E164_INVALID : PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number contains invalid characters'
    );
  }

  const raw = untrimmed.trim();

  // Reject phone extensions (e.g. ext, extn, extension, x456, post, #, ;)
  if (/(?:[#;]|(?:\b|\s|\d)(?:ext(?:ension|n)?|x|post)[.\s]*\d+)/i.test(raw)) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED,
      'Phone extensions are not allowed'
    );
  }

  // Reject multiple phone numbers or separators
  if (/[\/\\,]|(?:\s+or\s+)|或/.test(raw) || (raw.match(/\+/g) || []).length > 1) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_MULTIPLE_VALUES_NOT_ALLOWED,
      'Multiple phone numbers are not allowed'
    );
  }

  // Reject alphabetical letters
  if (/[a-zA-Z]/.test(raw)) {
    throw new PhoneValidationError(
      isE164Mode ? PHONE_ERROR_CODES.PHONE_E164_INVALID : PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number cannot contain letters'
    );
  }

  const digitMatches = raw.match(/\d/g);
  const digitCount = digitMatches ? digitMatches.length : 0;
  if (digitCount > 15) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG,
      'Phone number exceeds maximum digit length'
    );
  }
  if (isE164Mode && digitCount < 6) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_INVALID,
      'Phone number has too few digits'
    );
  }
  if (!isE164Mode && digitCount < 4) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number has too few digits'
    );
  }
};

/**
 * Normalizes a national phone number within an explicit country context.
 *
 * @param {object} input
 * @param {string} input.countryIso2 - ISO 3166-1 alpha-2 country code (case-insensitive)
 * @param {string} input.nationalNumber - User-provided national phone number
 * @returns {{ countryIso2: string, callingCode: string, nationalNumber: string, e164: string }}
 */
const normalizeNationalPhone = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input is required'
    );
  }

  const { countryIso2, nationalNumber } = input;

  if (countryIso2 === undefined || countryIso2 === null) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
      'Country ISO is required'
    );
  }

  if (typeof countryIso2 !== 'string') {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
      'Country ISO is required'
    );
  }

  const trimmedIso = countryIso2.trim();
  if (!trimmedIso) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
      'Country ISO is required'
    );
  }

  const iso = trimmedIso.toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso) || !isSupportedCountryIso(iso)) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_COUNTRY_UNSUPPORTED,
      'Unsupported country ISO'
    );
  }

  if (nationalNumber === undefined || nationalNumber === null) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone number is required'
    );
  }

  if (typeof nationalNumber !== 'string') {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number must be a string'
    );
  }

  const raw = nationalNumber.trim();
  if (!raw) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone number is required'
    );
  }

  sanitizeInputCheck(nationalNumber, false);

  let parsed;
  try {
    parsed = parsePhoneNumberWithError(raw, iso);
  } catch (err) {
    if (err && (err.message === 'TOO_LONG' || (err.name === 'ParseError' && err.message === 'TOO_LONG'))) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG,
        'Phone number is too long'
      );
    }
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number is invalid for specified country'
    );
  }

  if (!parsed || !parsed.isValid()) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number is invalid for specified country'
    );
  }

  if (parsed.ext) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED,
      'Phone extensions are not allowed'
    );
  }

  const expectedCallingCode = getCallingCodeForCountry(iso);
  const actualCallingCode = `+${parsed.countryCallingCode}`;

  if (actualCallingCode !== expectedCallingCode) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number calling code does not match specified country'
    );
  }

  if (parsed.country && parsed.country !== iso) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Phone number does not belong to specified country'
    );
  }

  const e164 = parsed.number;
  if (!isCanonicalE164(e164)) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
      'Normalized phone number is not canonical E.164'
    );
  }

  const regionKind = getRegionKind(iso, actualCallingCode);

  return {
    countryIso2: iso,
    callingCode: actualCallingCode,
    nationalNumber: String(parsed.nationalNumber),
    e164: String(e164),
    regionKind
  };
};

/**
 * Normalizes an international E.164 phone number string.
 *
 * @param {string} e164Input - Full international phone number starting with '+'
 * @returns {{ countryIso2: string|null, callingCode: string, nationalNumber: string, e164: string, regionKind: string }}
 */
const normalizeE164Phone = e164Input => {
  if (e164Input === undefined || e164Input === null) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input is required'
    );
  }

  if (typeof e164Input !== 'string') {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_REQUIRED,
      'E.164 phone number must start with +'
    );
  }

  const raw = e164Input.trim();
  if (!raw) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input is required'
    );
  }

  if (!raw.startsWith('+')) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_REQUIRED,
      'E.164 phone number must start with +'
    );
  }

  sanitizeInputCheck(e164Input, true);

  let parsed;
  try {
    parsed = parsePhoneNumberWithError(raw);
  } catch (err) {
    if (err && (err.message === 'TOO_LONG' || (err.name === 'ParseError' && err.message === 'TOO_LONG'))) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_TOO_LONG,
        'Phone number is too long'
      );
    }
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_INVALID,
      'Invalid E.164 phone number'
    );
  }

  if (!parsed || !parsed.isValid()) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_INVALID,
      'Invalid E.164 phone number'
    );
  }

  if (parsed.ext) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_EXTENSION_NOT_ALLOWED,
      'Phone extensions are not allowed'
    );
  }

  const e164 = parsed.number;
  if (!isCanonicalE164(e164)) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_E164_INVALID,
      'Normalized phone number is not canonical E.164'
    );
  }

  const countryIso2 = parsed.country ? String(parsed.country) : null;
  const callingCode = `+${parsed.countryCallingCode}`;
  const regionKind = getRegionKind(countryIso2, callingCode);

  return {
    countryIso2,
    callingCode,
    nationalNumber: String(parsed.nationalNumber),
    e164: String(e164),
    regionKind
  };
};

/**
 * Pure authoritative validation for Customer Identity, Member OTP, and customer phone matching.
 *
 * Rules:
 * - Rejects any phone number where countryIso2 is null or missing.
 * - Rejects non-geographic numbers (regionKind !== 'iso3166').
 * - Rejects exceptional code elements (AC, TA).
 * - Rejects user-assigned code elements (XK).
 * - Strictly accepts only regionKind === 'iso3166'.
 * - Input must be a valid string or national phone input object.
 *
 * @param {string|object} input - E.164 string, national input object, or normalized phone object
 * @returns {object} Normalized phone object with eligibleForCustomerIdentity: true
 * @throws {PhoneValidationError}
 */
/**
 * Pure authoritative validation for Customer Identity, Member OTP, and customer phone matching.
 *
 * Strict STRING-ONLY input contract:
 * - Only primitive string phone numbers are accepted.
 * - Non-string inputs (objects, arrays, dates, maps, sets, class instances, String objects,
 *   functions, proxies) immediately fail closed without property inspection or coercion.
 * - E.164 strings starting with '+' are authoritatively re-parsed via normalizeE164Phone.
 * - National format strings require an explicit countryIso2 string parameter; never defaults to SG.
 * - Rejects non-geographic numbers (regionKind !== 'iso3166').
 * - Rejects exceptional code elements (AC, TA).
 * - Rejects user-assigned code elements (XK).
 * - Strictly accepts only regionKind === 'iso3166'.
 * - All error codes and messages are fixed, static constants without PII or dynamic input.
 * - Does not retain input references in error instances.
 *
 * @param {string} input - Primitive phone number string (E.164 or national format)
 * @param {string} [countryIso2] - Country ISO 3166-1 alpha-2 (required if input is national format)
 * @returns {object} Fresh canonical normalized phone object with eligibleForCustomerIdentity: true
 * @throws {PhoneValidationError}
 */
const validateCustomerIdentityPhone = (input, countryIso2) => {
  // 1. Primitive string check - fail closed immediately on non-strings
  if (typeof input !== 'string') {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input must be a string'
    );
  }

  const raw = input.trim();
  if (!raw) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone number is required'
    );
  }

  let canonical;

  if (raw.startsWith('+')) {
    // E.164 string: authoritative re-parse
    canonical = normalizeE164Phone(raw);

    // If caller explicitly passed countryIso2, ensure it matches
    if (countryIso2 !== undefined && countryIso2 !== null) {
      if (typeof countryIso2 !== 'string') {
        throw new PhoneValidationError(
          PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
          'Country ISO must be a string'
        );
      }
      const iso = countryIso2.trim().toUpperCase();
      if (iso !== canonical.countryIso2) {
        throw new PhoneValidationError(
          PHONE_ERROR_CODES.PHONE_INVALID_FOR_COUNTRY,
          'Phone number does not match specified country'
        );
      }
    }
  } else {
    // National string: requires explicit countryIso2, never defaults to SG
    if (countryIso2 === undefined || countryIso2 === null) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
        'Country ISO is required for national phone number'
      );
    }
    if (typeof countryIso2 !== 'string') {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
        'Country ISO must be a string'
      );
    }
    const iso = countryIso2.trim().toUpperCase();
    if (!iso) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_COUNTRY_REQUIRED,
        'Country ISO is required for national phone number'
      );
    }

    canonical = normalizeNationalPhone({ countryIso2: iso, nationalNumber: raw });
  }

  // 2. Authoritative Customer Identity eligibility check
  if (!canonical.countryIso2) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
      'Phone number is not eligible for customer identity: country ISO is missing'
    );
  }

  if (canonical.regionKind !== REGION_KINDS.ISO3166) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
      'Phone number is not eligible for customer identity: region is not iso3166'
    );
  }

  // 3. Return isolated canonical object
  return {
    countryIso2: canonical.countryIso2,
    callingCode: canonical.callingCode,
    nationalNumber: canonical.nationalNumber,
    e164: canonical.e164,
    regionKind: canonical.regionKind,
    eligibleForCustomerIdentity: true
  };
};

/**
 * Pure check whether a phone number is eligible for Customer Identity / Member OTP.
 * Only accepts primitive string inputs.
 *
 * @param {string} input
 * @param {string} [countryIso2]
 * @returns {boolean}
 */
const isEligibleForCustomerIdentity = (input, countryIso2) => {
  try {
    validateCustomerIdentityPhone(input, countryIso2);
    return true;
  } catch (_) {
    return false;
  }
};

const validateOtpPhone = validateCustomerIdentityPhone;
const isEligibleForOtp = isEligibleForCustomerIdentity;

module.exports = {
  PhoneValidationError,
  PHONE_ERROR_CODES,
  REGION_KINDS,
  isCanonicalE164,
  normalizeNationalPhone,
  normalizeE164Phone,
  validateCustomerIdentityPhone,
  isEligibleForCustomerIdentity,
  validateOtpPhone,
  isEligibleForOtp,
  getCustomerPhoneSelectorCountries,
  searchCustomerPhoneSelectorCountries,
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries,
  isSupportedCountryIso,
  getCallingCodeForCountry,
  getRegionKind,
  EXCEPTIONAL_COUNTRY_ISOS,
  USER_ASSIGNED_COUNTRY_ISOS,
  NON_GEOGRAPHIC_CALLING_CODES,
  getExceptionalCountryIsos,
  getUserAssignedCountryIsos,
  getNonGeographicCallingCodes
};
