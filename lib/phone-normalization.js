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
 * Helper to test if a value is a plain object ({}, Object.create(null)).
 * Rejects Array, Date, Map, Set, RegExp, Buffer, Error, and class instances.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
const isPlainObject = obj => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  try {
    const proto = Object.getPrototypeOf(obj);
    return proto === null || proto === Object.prototype;
  } catch (_) {
    return false;
  }
};

/**
 * Pure authoritative validation for Customer Identity, Member OTP, and customer phone matching.
 *
 * Requirements:
 * 1. String input:
 *    - Re-parsed using authoritative normalizeE164Phone.
 * 2. Object input:
 *    - Must be a plain object (rejects Array, Date, Map, Set, class instances).
 *    - Must have an own data property 'e164' of type string.
 *    - Rejects prototype-inherited 'e164'.
 *    - Rejects getter/setter for 'e164'.
 *    - Re-parses e164 authoritatively using normalizeE164Phone.
 *    - Derives countryIso2, callingCode, nationalNumber, and regionKind strictly from canonical re-parse.
 *    - If object includes any canonical fields (countryIso2, callingCode, nationalNumber, regionKind),
 *      any inconsistency with authoritative values FAILS CLOSED.
 *    - Rejects accessors/getters on any canonical fields or properties.
 *    - Safely handles throwing getters/Proxies without crashing or leaking PII.
 * 3. Identity eligibility:
 *    - Rejects any phone where countryIso2 is null or missing.
 *    - Rejects non-geographic numbers (regionKind !== 'iso3166').
 *    - Rejects exceptional code elements (AC, TA).
 *    - Rejects user-assigned code elements (XK).
 *    - Strictly accepts only regionKind === 'iso3166'.
 * 4. Output:
 *    - Returns a brand new canonical object { countryIso2, callingCode, nationalNumber, e164, regionKind, eligibleForCustomerIdentity: true }.
 *    - Never returns or mutates caller's input object.
 *
 * @param {string|object} input - E.164 string or plain object containing own e164 data property
 * @returns {object} Fresh canonical normalized phone object with eligibleForCustomerIdentity: true
 * @throws {PhoneValidationError}
 */
const validateCustomerIdentityPhone = input => {
  if (input === undefined || input === null) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input is required'
    );
  }

  let canonical;

  if (typeof input === 'string') {
    canonical = normalizeE164Phone(input);
  } else if (typeof input === 'object') {
    // 1. Must be a plain object (rejects Array, Date, Map, Set, class instances)
    if (!isPlainObject(input)) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'Phone input must be a string or plain object'
      );
    }

    // 2. Safely inspect input's own property descriptors to prevent malicious getters / Proxies
    let e164Desc;
    try {
      e164Desc = Object.getOwnPropertyDescriptor(input, 'e164');
    } catch (_) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'Invalid phone input object'
      );
    }

    if (!e164Desc) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'Phone input object must have an own e164 data property'
      );
    }

    // Must not be an accessor/getter/setter
    if (e164Desc.get !== undefined || e164Desc.set !== undefined) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'e164 property cannot be an accessor or getter'
      );
    }

    if (typeof e164Desc.value !== 'string') {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'e164 property must be a string'
      );
    }

    // Check for any throwing/accessor own properties on the object
    let ownKeys;
    try {
      ownKeys = Object.getOwnPropertyNames(input);
    } catch (_) {
      throw new PhoneValidationError(
        PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
        'Invalid phone input object'
      );
    }

    for (const key of ownKeys) {
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(input, key);
      } catch (_) {
        throw new PhoneValidationError(
          PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
          'Invalid phone input property'
        );
      }
      if (desc && (desc.get !== undefined || desc.set !== undefined)) {
        throw new PhoneValidationError(
          PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
          `Phone object property '${key}' cannot be an accessor or getter`
        );
      }
    }

    // 3. Authoritative re-parsing from e164 string
    canonical = normalizeE164Phone(e164Desc.value);

    // 4. Verify consistency with any caller-supplied canonical properties
    const consistencyFields = [
      { name: 'countryIso2', expected: canonical.countryIso2 },
      { name: 'callingCode', expected: canonical.callingCode },
      { name: 'nationalNumber', expected: canonical.nationalNumber },
      { name: 'regionKind', expected: canonical.regionKind }
    ];

    for (const { name, expected } of consistencyFields) {
      let propDesc;
      try {
        propDesc = Object.getOwnPropertyDescriptor(input, name);
      } catch (_) {
        throw new PhoneValidationError(
          PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
          `Invalid property '${name}' on phone object`
        );
      }

      if (!propDesc) {
        // Prototype inheritance check: if present on prototype, fail closed
        let onProto = false;
        try {
          onProto = name in input;
        } catch (_) {
          throw new PhoneValidationError(
            PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
            `Invalid property inspection on '${name}'`
          );
        }
        if (onProto) {
          throw new PhoneValidationError(
            PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
            `Property '${name}' cannot be inherited from prototype`
          );
        }
        continue;
      }

      const val = propDesc.value;
      if (val !== undefined && val !== null) {
        if (typeof val !== 'string' || val.trim() !== String(expected)) {
          throw new PhoneValidationError(
            PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
            `Phone property '${name}' does not match authoritative canonical value`
          );
        }
      }
    }
  } else {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_INPUT_REQUIRED,
      'Phone input must be a string or plain object'
    );
  }

  // 5. Final Authoritative Identity eligibility check
  if (!canonical.countryIso2) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
      'Phone number is not eligible for customer identity: country ISO is missing or null'
    );
  }

  if (canonical.regionKind !== REGION_KINDS.ISO3166) {
    throw new PhoneValidationError(
      PHONE_ERROR_CODES.PHONE_CUSTOMER_IDENTITY_INELIGIBLE,
      `Phone number is not eligible for customer identity: regionKind '${canonical.regionKind}' is not iso3166`
    );
  }

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
 *
 * @param {string|object} input
 * @returns {boolean}
 */
const isEligibleForCustomerIdentity = input => {
  try {
    validateCustomerIdentityPhone(input);
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
