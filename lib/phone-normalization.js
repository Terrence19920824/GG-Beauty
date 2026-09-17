'use strict';

const { parsePhoneNumberWithError } = require('libphonenumber-js');
const {
  isSupportedCountryIso,
  getCallingCodeForCountry,
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries
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
  PHONE_E164_INVALID: 'PHONE_E164_INVALID'
});

/**
 * Checks whether a string conforms to canonical ITU E.164 format:
 * Must start with '+' followed by a non-zero digit and 6 to 14 additional digits
 * (total 7 to 15 digits).
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

  return {
    countryIso2: iso,
    callingCode: actualCallingCode,
    nationalNumber: String(parsed.nationalNumber),
    e164: String(e164)
  };
};

/**
 * Normalizes an international E.164 phone number string.
 *
 * @param {string} e164Input - Full international phone number starting with '+'
 * @returns {{ countryIso2: string|null, callingCode: string, nationalNumber: string, e164: string }}
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

  return {
    countryIso2: parsed.country ? String(parsed.country) : null,
    callingCode: `+${parsed.countryCallingCode}`,
    nationalNumber: String(parsed.nationalNumber),
    e164: String(e164)
  };
};

module.exports = {
  PhoneValidationError,
  PHONE_ERROR_CODES,
  isCanonicalE164,
  normalizeNationalPhone,
  normalizeE164Phone,
  PRIORITY_PHONE_COUNTRIES,
  PRIORITY_COUNTRY_ISOS,
  getSupportedPhoneCountries
};
