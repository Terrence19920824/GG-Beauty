'use strict';

const {
  hashToken,
  validateTokenFormat
} = require('./invitation-token');
const {
  MerchantProvisioningError,
  isValidTimezone,
  validateProvisioningInput,
  provisionMerchantInTransaction
} = require('./merchant-provisioning');
const {
  isSupportedCountryIso,
  getCallingCodeForCountry
} = require('./phone-country-metadata');

const INVITATION_STATES = Object.freeze({
  VALID: 'VALID',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  CONSUMED: 'ALREADY_CONSUMED',
  INVALID: 'INVALID'
});

const REQUEST_FIELDS = new Set([
  'token',
  'businessName',
  'slug',
  'locationName',
  'country',
  'address',
  'postalCode',
  'timezone',
  'currencyCode',
  'locale',
  'ownerDisplayName',
  'ownerLoginIdentifier',
  'password',
  'passwordConfirmation'
]);

const SUPPORTED_LOCALES = Object.freeze(new Set(['zh-CN', 'en']));

const SUPPORTED_CURRENCIES = Object.freeze(new Set([
  'SGD', 'MYR', 'IDR', 'CNY', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'HKD', 'JPY',
  'NZD', 'THB', 'KRW', 'TWD', 'VND', 'PHP', 'CHF', 'SEK', 'NOK', 'DKK', 'INR',
  'AED', 'SAR', 'QAR'
]));

class MerchantOnboardingError extends Error {
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.name = 'MerchantOnboardingError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const invitationStateFromRow = row => {
  if (!row) return INVITATION_STATES.INVALID;
  if (row.status === 'consumed' || row.consumed_at || row.resulting_shop_id) {
    return INVITATION_STATES.CONSUMED;
  }
  if (row.status === 'revoked' || row.revoked_at) {
    return INVITATION_STATES.REVOKED;
  }
  if (row.status === 'expired' || row.is_expired === true) {
    return INVITATION_STATES.EXPIRED;
  }
  return row.status === 'pending'
    ? INVITATION_STATES.VALID
    : INVITATION_STATES.INVALID;
};

const errorForInvitationState = state => {
  const errors = {
    [INVITATION_STATES.INVALID]: [
      'INVITATION_INVALID',
      404,
      'Invitation is invalid'
    ],
    [INVITATION_STATES.EXPIRED]: [
      'INVITATION_EXPIRED',
      410,
      'Invitation has expired'
    ],
    [INVITATION_STATES.REVOKED]: [
      'INVITATION_REVOKED',
      410,
      'Invitation has been revoked'
    ],
    [INVITATION_STATES.CONSUMED]: [
      'INVITATION_ALREADY_CONSUMED',
      409,
      'Invitation has already been used'
    ]
  };
  const [code, status, message] = errors[state] || errors[INVITATION_STATES.INVALID];
  return new MerchantOnboardingError(code, status, message);
};

const normalizeRequiredText = (value, maxLength, code, label) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new MerchantOnboardingError(
      code,
      400,
      `${label} is required and must not exceed ${maxLength} characters`
    );
  }
  return normalized;
};

const normalizeOptionalText = (value, maxLength, code, label) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new MerchantOnboardingError(code, 400, `${label} is invalid`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new MerchantOnboardingError(
      code,
      400,
      `${label} must not exceed ${maxLength} characters`
    );
  }
  return normalized || null;
};

const validateMerchantOnboardingInput = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MerchantOnboardingError(
      'INVALID_ONBOARDING_REQUEST',
      400,
      'Onboarding request is invalid'
    );
  }

  if (Object.keys(body).some(key => !REQUEST_FIELDS.has(key))) {
    throw new MerchantOnboardingError(
      'INVALID_ONBOARDING_REQUEST',
      400,
      'Onboarding request contains unsupported fields'
    );
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!validateTokenFormat(token)) throw errorForInvitationState(INVITATION_STATES.INVALID);

  const rawCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
  if (!rawCountry || !isSupportedCountryIso(rawCountry)) {
    throw new MerchantOnboardingError(
      'INVALID_COUNTRY',
      400,
      'Country is invalid or unsupported'
    );
  }
  const country = rawCountry;
  const defaultPhoneCountryCode = getCallingCodeForCountry(country);

  const currencyCode = typeof body.currencyCode === 'string'
    ? body.currencyCode.trim().toUpperCase()
    : '';
  if (!currencyCode || !SUPPORTED_CURRENCIES.has(currencyCode)) {
    throw new MerchantOnboardingError(
      'INVALID_CURRENCY_CODE',
      400,
      'Currency code is unsupported'
    );
  }

  const locale = typeof body.locale === 'string' ? body.locale.trim() : '';
  if (!locale || !SUPPORTED_LOCALES.has(locale)) {
    throw new MerchantOnboardingError(
      'INVALID_LOCALE',
      400,
      'Business locale is not supported'
    );
  }

  if (typeof body.password !== 'string' || typeof body.passwordConfirmation !== 'string') {
    throw new MerchantOnboardingError(
      'INVALID_PASSWORD',
      400,
      'Password and password confirmation are required'
    );
  }
  if (body.password.length < 16) {
    throw new MerchantOnboardingError(
      'PASSWORD_TOO_SHORT',
      400,
      'Password must contain at least 16 characters'
    );
  }
  if (Buffer.byteLength(body.password, 'utf8') > 72) {
    throw new MerchantOnboardingError(
      'PASSWORD_TOO_LONG',
      400,
      'Password must not exceed 72 bytes in UTF-8 encoding'
    );
  }
  if (body.password !== body.passwordConfirmation) {
    throw new MerchantOnboardingError(
      'PASSWORD_CONFIRMATION_MISMATCH',
      400,
      'Password confirmation does not match'
    );
  }

  const businessName = normalizeRequiredText(
    body.businessName,
    200,
    'INVALID_MERCHANT_NAME',
    'Business name'
  );
  const locationName = normalizeRequiredText(
    body.locationName,
    200,
    'INVALID_LOCATION_NAME',
    'Location name'
  );
  const ownerDisplayName = normalizeRequiredText(
    body.ownerDisplayName,
    200,
    'INVALID_OWNER_DISPLAY_NAME',
    'Owner display name'
  );
  const ownerLoginIdentifier = normalizeRequiredText(
    body.ownerLoginIdentifier,
    200,
    'INVALID_OWNER_IDENTIFIER',
    'Owner login identifier'
  );
  const timezone = normalizeRequiredText(
    body.timezone,
    100,
    'INVALID_TIMEZONE',
    'Timezone'
  );
  if (!isValidTimezone(timezone)) {
    throw new MerchantOnboardingError(
      'INVALID_TIMEZONE',
      400,
      `Timezone "${timezone}" is invalid`
    );
  }
  const address = normalizeOptionalText(
    body.address,
    255,
    'INVALID_ADDRESS',
    'Business address'
  );
  const postalCode = normalizeOptionalText(
    body.postalCode,
    16,
    'INVALID_POSTAL_CODE',
    'Postal code'
  );

  const provisioning = validateProvisioningInput({
    name: businessName,
    slug: body.slug,
    tenantMode: 'live',
    location: { name: locationName, timezone },
    categories: [],
    owner: {
      loginIdentifier: ownerLoginIdentifier,
      displayName: ownerDisplayName,
      password: body.password
    },
    settings: {
      countryCode: country,
      defaultPhoneCountryCode,
      publicDisplayName: businessName,
      publicAddress: address,
      publicPostalCode: postalCode,
      currencyCode,
      defaultLocale: locale
    }
  });

  return { token, provisioning };
};

const selectInvitation = async (db, tokenHash, { lock = false } = {}) => {
  const result = await db.query(
    `SELECT
       id,
       status,
       expires_at <= NOW() AS is_expired,
       consumed_at,
       revoked_at,
       resulting_shop_id,
       merchant_name_hint
     FROM public.merchant_onboarding_invitations
     WHERE token_hash = $1
     LIMIT 1
     ${lock ? 'FOR UPDATE' : ''}`,
    [tokenHash]
  );
  return result.rows[0] || null;
};

const getInvitationStatus = async (dbOrPool, rawToken) => {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!validateTokenFormat(token)) {
    return { state: INVITATION_STATES.INVALID };
  }

  const row = await selectInvitation(dbOrPool, hashToken(token));
  const state = invitationStateFromRow(row);
  return state === INVITATION_STATES.VALID
    ? { state, merchantNameHint: row.merchant_name_hint || null }
    : { state };
};

const consumeMerchantInvitation = async (
  pool,
  body,
  options = {}
) => {
  if (!pool || typeof pool.connect !== 'function') {
    throw new MerchantOnboardingError(
      'INVALID_DATABASE_CLIENT',
      500,
      'Database client is required'
    );
  }

  const validated = validateMerchantOnboardingInput(body);
  const tokenHash = hashToken(validated.token);
  const provision = options.provisionInTransaction || provisionMerchantInTransaction;
  const consumedIp = typeof options.consumedIp === 'string'
    ? options.consumedIp.trim().slice(0, 100) || null
    : null;

  let client;
  let transactionActive = false;
  let discardClient = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionActive = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const invitation = await selectInvitation(client, tokenHash, { lock: true });
    const state = invitationStateFromRow(invitation);
    if (state !== INVITATION_STATES.VALID) throw errorForInvitationState(state);

    const merchant = await provision(
      client,
      validated.provisioning,
      { inputValidated: true, rejectExistingOwner: true }
    );

    const consumed = await client.query(
      `UPDATE public.merchant_onboarding_invitations
       SET status = 'consumed',
           consumed_at = NOW(),
           resulting_shop_id = $1,
           consumed_ip = $2,
           updated_at = NOW()
       WHERE id = $3
         AND status = 'pending'
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING id`,
      [merchant.shop.id, consumedIp, invitation.id]
    );

    if (consumed.rows.length !== 1) {
      throw new MerchantOnboardingError(
        'INVITATION_CONCURRENTLY_CHANGED',
        409,
        'Invitation is no longer available'
      );
    }

    await client.query('COMMIT');
    transactionActive = false;

    return {
      success: true,
      shop: {
        slug: merchant.shop.slug,
        name: merchant.shop.name
      },
      location: {
        name: merchant.location.name,
        timezone: merchant.location.timezone
      },
      owner: {
        loginIdentifier: merchant.owner.loginIdentifier,
        role: merchant.owner.role
      },
      loginPath: '/admin.html'
    };
  } catch (error) {
    if (transactionActive && client) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        discardClient = true;
      }
    }

    if (error instanceof MerchantOnboardingError || error instanceof MerchantProvisioningError) {
      throw error;
    }

    throw new MerchantOnboardingError(
      'ONBOARDING_FAILED',
      500,
      'Unable to complete onboarding'
    );
  } finally {
    if (client && typeof client.release === 'function') {
      client.release(discardClient || undefined);
    }
  }
};

const createMerchantOnboarding = ({
  pool,
  isSameOriginRequest,
  safeErrorCode = error => error && error.code || 'unknown_error'
}) => {
  const setNoStore = response => response.setHeader('Cache-Control', 'no-store');
  const requireSameOrigin = (request, response) => {
    if (typeof isSameOriginRequest === 'function' && !isSameOriginRequest(request)) {
      response.status(403).json({ success: false, code: 'ORIGIN_NOT_ALLOWED' });
      return false;
    }
    return true;
  };

  const validateInvitation = async (request, response) => {
    setNoStore(response);
    if (!requireSameOrigin(request, response)) return;
    const keys = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? Object.keys(request.body)
      : [];
    if (keys.length !== 1 || keys[0] !== 'token') {
      return response.status(400).json({
        success: false,
        code: 'INVALID_VALIDATION_REQUEST'
      });
    }
    try {
      const data = await getInvitationStatus(pool, request.body.token);
      return response.json({ success: true, data });
    } catch (error) {
      console.error('Merchant invitation validation error:', safeErrorCode(error));
      return response.status(500).json({
        success: false,
        code: 'INVITATION_VALIDATION_FAILED'
      });
    }
  };

  const consumeInvitation = async (request, response) => {
    setNoStore(response);
    if (!requireSameOrigin(request, response)) return;
    try {
      const result = await consumeMerchantInvitation(pool, request.body, {
        consumedIp: request.ip
      });
      return response.status(201).json({ success: true, data: result });
    } catch (error) {
      if (error instanceof MerchantOnboardingError || error instanceof MerchantProvisioningError) {
        return response.status(error.status).json({
          success: false,
          code: error.code
        });
      }
      console.error('Merchant invitation consumption error:', safeErrorCode(error));
      return response.status(500).json({
        success: false,
        code: 'ONBOARDING_FAILED'
      });
    }
  };

  return { validateInvitation, consumeInvitation };
};

module.exports = {
  INVITATION_STATES,
  MerchantOnboardingError,
  SUPPORTED_LOCALES,
  SUPPORTED_CURRENCIES,
  invitationStateFromRow,
  validateMerchantOnboardingInput,
  getInvitationStatus,
  consumeMerchantInvitation,
  createMerchantOnboarding
};
