'use strict';

const {
  generateToken,
  hashToken,
  validateTokenFormat,
  validateTokenHashFormat
} = require('./invitation-token');

const DEFAULT_INVITATION_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;

class MerchantInvitationError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'MerchantInvitationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates a new merchant onboarding invitation.
 * Stores ONLY the SHA-256 hash in merchant_onboarding_invitations.
 * Raw token is returned in the result object for deliberate one-time display and is not persisted.
 *
 * @param {object} dbOrPool PostgreSQL client or pool
 * @param {object} [options={}]
 * @param {string} [options.merchantNameHint]
 * @param {string} [options.contactEmail]
 * @param {string} [options.contactPhone]
 * @param {number} [options.ttlDays=7]
 * @param {string} [options.createdBy='platform_cli']
 * @param {string} [options.baseUrl='http://localhost:3000']
 * @returns {Promise<object>}
 */
async function createMerchantInvitation(dbOrPool, options = {}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new MerchantInvitationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const nameHint = typeof options.merchantNameHint === 'string'
    ? options.merchantNameHint.trim().slice(0, 200) || null
    : null;

  const contactEmail = typeof options.contactEmail === 'string'
    ? options.contactEmail.trim().slice(0, 255) || null
    : null;

  const contactPhone = typeof options.contactPhone === 'string'
    ? options.contactPhone.trim().slice(0, 50) || null
    : null;

  const createdBy = typeof options.createdBy === 'string' && options.createdBy.trim()
    ? options.createdBy.trim().slice(0, 100)
    : 'platform_cli';

  let ttlDays = DEFAULT_INVITATION_TTL_DAYS;
  if (options.ttlDays !== undefined && options.ttlDays !== null) {
    const parsed = Number(options.ttlDays);
    if (!Number.isInteger(parsed) || parsed < MIN_TTL_DAYS || parsed > MAX_TTL_DAYS) {
      throw new MerchantInvitationError(
        'INVALID_TTL',
        400,
        `ttlDays must be an integer between ${MIN_TTL_DAYS} and ${MAX_TTL_DAYS}`
      );
    }
    ttlDays = parsed;
  }

  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);

  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const sql = `
    INSERT INTO public.merchant_onboarding_invitations (
      token_hash,
      status,
      expires_at,
      merchant_name_hint,
      contact_email,
      contact_phone,
      created_by
    ) VALUES ($1, 'pending', $2, $3, $4, $5, $6)
    RETURNING id, status, expires_at, created_at
  `;

  const result = await dbOrPool.query(sql, [
    tokenHash,
    expiresAt,
    nameHint,
    contactEmail,
    contactPhone,
    createdBy
  ]);

  const row = result.rows[0];

  const baseUrl = (typeof options.baseUrl === 'string' && options.baseUrl.trim())
    ? options.baseUrl.trim().replace(/\/+$/, '')
    : 'http://localhost:3000';

  const onboardingUrl = `${baseUrl}/onboarding.html?token=${rawToken}`;

  return {
    invitationId: row.id,
    rawToken,
    tokenHash,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    merchantNameHint: nameHint,
    contactEmail,
    contactPhone,
    createdBy,
    onboardingUrl
  };
}

/**
 * Finds an invitation by raw token or token hash.
 * Computes effective status (marks as expired if past expires_at).
 *
 * @param {object} dbOrPool
 * @param {string} rawTokenOrHash
 * @param {object} [options={ isHash: false }]
 * @returns {Promise<object|null>}
 */
async function findInvitation(dbOrPool, rawTokenOrHash, options = {}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new MerchantInvitationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  if (typeof rawTokenOrHash !== 'string' || !rawTokenOrHash.trim()) {
    return null;
  }

  const tokenHash = options.isHash
    ? rawTokenOrHash.trim().toLowerCase()
    : hashToken(rawTokenOrHash.trim());

  if (!validateTokenHashFormat(tokenHash)) {
    return null;
  }

  const result = await dbOrPool.query(
    `SELECT
       id,
       token_hash,
       status,
       expires_at,
       consumed_at,
       revoked_at,
       resulting_shop_id,
       merchant_name_hint,
       contact_email,
       contact_phone,
       created_by,
       created_at,
       updated_at
     FROM public.merchant_onboarding_invitations
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const now = new Date();
  const isExpired = row.status === 'pending' && new Date(row.expires_at) <= now;

  return {
    id: row.id,
    tokenHash: row.token_hash,
    status: isExpired ? 'expired' : row.status,
    rawStatus: row.status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    resultingShopId: row.resulting_shop_id,
    merchantNameHint: row.merchant_name_hint,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isValid: row.status === 'pending' && !isExpired
  };
}

/**
 * Revokes a pending invitation.
 *
 * @param {object} dbOrPool
 * @param {string} invitationId
 * @returns {Promise<boolean>}
 */
async function revokeInvitation(dbOrPool, invitationId) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new MerchantInvitationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const result = await dbOrPool.query(
    `UPDATE public.merchant_onboarding_invitations
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [invitationId]
  );

  return result.rowCount > 0;
}

module.exports = {
  DEFAULT_INVITATION_TTL_DAYS,
  MIN_TTL_DAYS,
  MAX_TTL_DAYS,
  MerchantInvitationError,
  createMerchantInvitation,
  findInvitation,
  revokeInvitation
};
