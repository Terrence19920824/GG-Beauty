'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const {
  FrontDeskActivationError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES
} = require('./front-desk-activation');
const { recordAuthAudit } = require('./staff-activation');

const BCRYPT_COST = 12;

// Character pools for temporary password generation (excluding ambiguous characters: 0, O, o, 1, l, I)
const UPPER_POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER_POOL = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT_POOL = '23456789';
const SYMBOL_POOL = '!@#$%&*+=-?';
const ALL_POOLS = UPPER_POOL + LOWER_POOL + DIGIT_POOL + SYMBOL_POOL;

/**
 * Generates a cryptographically secure, readable temporary password.
 * Guaranteed to have at least 1 uppercase, 1 lowercase, 1 digit, and 1 symbol.
 * Excludes easily confusable characters (0/O/o, 1/l/I).
 *
 * @param {number} [length=16]
 * @returns {string}
 */
function generateTemporaryPassword(length = 16) {
  if (length < MIN_PASSWORD_LENGTH) {
    length = MIN_PASSWORD_LENGTH;
  }

  // Ensure minimum entropy & complexity requirements
  const chars = [
    UPPER_POOL[crypto.randomInt(0, UPPER_POOL.length)],
    LOWER_POOL[crypto.randomInt(0, LOWER_POOL.length)],
    DIGIT_POOL[crypto.randomInt(0, DIGIT_POOL.length)],
    SYMBOL_POOL[crypto.randomInt(0, SYMBOL_POOL.length)]
  ];

  while (chars.length < length) {
    chars.push(ALL_POOLS[crypto.randomInt(0, ALL_POOLS.length)]);
  }

  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const temp = chars[i];
    chars[i] = chars[j];
    chars[j] = temp;
  }

  return chars.join('');
}

/**
 * Validates a user-supplied new password and confirmation.
 */
function validateNewPassword(password, confirmation) {
  if (typeof password !== 'string' || typeof confirmation !== 'string') {
    throw new FrontDeskActivationError('INVALID_PASSWORD', 400, 'Password is required');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new FrontDeskActivationError(
      'PASSWORD_TOO_SHORT',
      400,
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new FrontDeskActivationError(
      'PASSWORD_TOO_LONG',
      400,
      'Password must not exceed 72 bytes in UTF-8 encoding'
    );
  }

  if (password !== confirmation) {
    throw new FrontDeskActivationError(
      'PASSWORD_CONFIRMATION_MISMATCH',
      400,
      'Password confirmation does not match'
    );
  }
}

/**
 * Resets a front-desk account password.
 * Supports dual modes:
 *   - 'auto': Server generates a high-entropy random password and returns it once.
 *   - 'manual': Owner manually specifies a compliant password.
 *
 * Security guarantees:
 *   - Old password is never read, returned, or logged.
 *   - Password hashed with bcrypt (cost 12).
 *   - owner_accounts.session_version incremented to invalidate all active sessions.
 *   - owner_sessions explicitly revoked for this membership.
 *   - failed_login_attempts reset and locked_until cleared.
 *   - Disabled accounts cannot be reset (fails closed).
 *   - Immutable audit record written with operator attribution.
 */
async function resetFrontDeskPassword(dbOrPool, {
  shopId,
  membershipId,
  operatorId,
  mode = 'auto',
  newPassword = null,
  confirmPassword = null,
  clientIp = null,
  userAgent = null
}) {
  if (!dbOrPool) {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const cleanMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (cleanMode !== 'auto' && cleanMode !== 'manual') {
    throw new FrontDeskActivationError('INVALID_MODE', 400, 'Mode must be either auto or manual');
  }

  // 1. Look up membership, account, and shop under strict tenant isolation
  const querySql = `
    SELECT
      osm.id AS membership_id,
      osm.shop_id,
      osm.role,
      osm.is_active AS membership_active,
      oa.id AS account_id,
      oa.login_identifier,
      oa.display_name,
      oa.is_active AS account_active,
      sh.status AS shop_status
    FROM public.owner_shop_memberships osm
    JOIN public.owner_accounts oa ON oa.id = osm.owner_account_id
    JOIN public.shops sh ON sh.id = osm.shop_id
    WHERE osm.id = $1 AND osm.shop_id = $2
    LIMIT 1
  `;
  const lookupResult = await dbOrPool.query(querySql, [membershipId, shopId]);

  if (lookupResult.rows.length === 0) {
    throw new FrontDeskActivationError('MEMBERSHIP_NOT_FOUND', 404, 'Front desk membership not found');
  }

  const member = lookupResult.rows[0];

  // RBAC safety: only front_desk role accounts may be reset via this endpoint
  if (member.role !== 'front_desk') {
    throw new FrontDeskActivationError('INVALID_TARGET_ROLE', 404, 'Only front desk accounts can be reset');
  }

  // Shop status check
  if (member.shop_status !== 'active') {
    throw new FrontDeskActivationError('SHOP_INACTIVE', 400, 'Shop is no longer active');
  }

  // Disabled account safety: cannot reset disabled accounts
  if (!member.membership_active || !member.account_active) {
    throw new FrontDeskActivationError(
      'ACCOUNT_DISABLED',
      400,
      '账号已停用，无法重置密码。请先启用账号。'
    );
  }

  // 2. Determine target plaintext password
  let plaintextPassword;
  if (cleanMode === 'auto') {
    plaintextPassword = generateTemporaryPassword(16);
  } else {
    validateNewPassword(newPassword, confirmPassword);
    plaintextPassword = newPassword;
  }

  // 3. Hash with bcrypt cost 12
  const passwordHash = await bcrypt.hash(plaintextPassword, BCRYPT_COST);

  // 4. Atomic transaction update
  let client;
  let shouldRelease = false;
  let transactionActive = false;

  if (typeof dbOrPool.connect === 'function') {
    client = await dbOrPool.connect();
    shouldRelease = true;
  } else {
    client = dbOrPool;
  }

  try {
    await client.query('BEGIN');
    transactionActive = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    // Update account: new password_hash, increment session_version, clear lockouts
    await client.query(
      `UPDATE public.owner_accounts
       SET password_hash = $1,
           session_version = session_version + 1,
           password_changed_at = NOW(),
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, member.account_id]
    );

    // Revoke all existing active owner sessions for this membership
    await client.query(
      `UPDATE public.owner_sessions
       SET revoked_at = NOW(),
           revoke_reason = 'password_reset'
       WHERE membership_id = $1 AND shop_id = $2 AND revoked_at IS NULL`,
      [member.membership_id, member.shop_id]
    );

    // Record immutable audit event
    const cleanIp = typeof clientIp === 'string' ? clientIp.trim().slice(0, 100) : null;
    const cleanUserAgent = typeof userAgent === 'string' ? userAgent.trim().slice(0, 255) : null;

    await recordAuthAudit(client, {
      shopId: member.shop_id,
      eventType: 'front_desk_password_reset',
      targetType: 'front_desk',
      targetId: member.membership_id,
      operatorType: 'owner',
      operatorId,
      metadata: {
        account_id: member.account_id,
        membership_id: member.membership_id,
        login_identifier: member.login_identifier,
        reset_mode: cleanMode,
        ip: cleanIp,
        user_agent: cleanUserAgent
      }
    });

    await client.query('COMMIT');
    transactionActive = false;

    return {
      success: true,
      membershipId: member.membership_id,
      accountId: member.account_id,
      loginIdentifier: member.login_identifier,
      displayName: member.display_name,
      temporaryPassword: cleanMode === 'auto' ? plaintextPassword : null,
      mustChangePassword: cleanMode === 'auto'
    };
  } catch (error) {
    if (transactionActive) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        // ignore
      }
    }
    throw error;
  } finally {
    if (shouldRelease && client) {
      client.release();
    }
  }
}

module.exports = {
  generateTemporaryPassword,
  validateNewPassword,
  resetFrontDeskPassword
};
