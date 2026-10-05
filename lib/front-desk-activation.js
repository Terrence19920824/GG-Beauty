'use strict';

const bcrypt = require('bcryptjs');
const {
  generateToken,
  hashToken,
  validateTokenFormat
} = require('./invitation-token');
const {
  recordAuthAudit,
  normalizeLoginIdentifier,
  sanitizeAuditMetadata
} = require('./staff-activation');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_BYTES = 72; // UTF-8 byte boundary to prevent bcrypt truncation
const DEFAULT_INVITATION_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;

class FrontDeskActivationError extends Error {
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.name = 'FrontDeskActivationError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Creates a front desk invitation.
 * Role is strictly hardcoded to 'front_desk'.
 */
async function createFrontDeskInvitation(dbOrPool, {
  shopId,
  operatorId,
  displayNameHint = null,
  phone = null,
  email = null,
  ttlDays = DEFAULT_INVITATION_TTL_DAYS,
  baseUrl = 'http://localhost:3000'
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const parsedTtl = Number(ttlDays);
  if (!Number.isInteger(parsedTtl) || parsedTtl < MIN_TTL_DAYS || parsedTtl > MAX_TTL_DAYS) {
    throw new FrontDeskActivationError(
      'INVALID_TTL',
      400,
      `ttlDays must be an integer between ${MIN_TTL_DAYS} and ${MAX_TTL_DAYS}`
    );
  }

  // 1. Verify shop exists and is active
  const shopResult = await dbOrPool.query(
    `SELECT id, name, status FROM public.shops WHERE id = $1 LIMIT 1`,
    [shopId]
  );

  if (shopResult.rows.length === 0 || shopResult.rows[0].status !== 'active') {
    throw new FrontDeskActivationError('SHOP_NOT_FOUND', 404, 'Shop not found or inactive');
  }

  // 2. Generate secure token
  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + parsedTtl * 24 * 60 * 60 * 1000);

  const cleanHint = typeof displayNameHint === 'string' ? displayNameHint.trim().slice(0, 100) || null : null;
  const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 50) || null : null;
  const cleanEmail = typeof email === 'string' ? email.trim().slice(0, 255) || null : null;

  const insertSql = `
    INSERT INTO public.front_desk_invitations (
      shop_id,
      role,
      invited_phone,
      invited_email,
      display_name_hint,
      token_hash,
      status,
      expires_at,
      created_by_owner_account_id
    ) VALUES ($1, 'front_desk', $2, $3, $4, $5, 'pending', $6, $7)
    RETURNING id, status, expires_at, created_at
  `;

  const insertResult = await dbOrPool.query(insertSql, [
    shopId,
    cleanPhone,
    cleanEmail,
    cleanHint,
    tokenHash,
    expiresAt,
    operatorId
  ]);

  const row = insertResult.rows[0];
  const cleanBaseUrl = (typeof baseUrl === 'string' && baseUrl.trim())
    ? baseUrl.trim().replace(/\/+$/, '')
    : 'http://localhost:3000';
  const activationUrl = `${cleanBaseUrl}/front-desk-activate.html?token=${rawToken}`;

  // 3. Record safe audit event
  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'front_desk_invitation_created',
    targetType: 'front_desk',
    targetId: row.id,
    operatorType: 'owner',
    operatorId,
    metadata: {
      invitation_id: row.id,
      role: 'front_desk',
      expires_at: row.expires_at
    }
  });

  return {
    invitationId: row.id,
    rawToken,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    activationUrl
  };
}

/**
 * Revokes a pending front desk invitation.
 */
async function revokeFrontDeskInvitation(dbOrPool, {
  shopId,
  invitationId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const result = await dbOrPool.query(
    `UPDATE public.front_desk_invitations
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE shop_id = $1 AND id = $2 AND status = 'pending'
     RETURNING id`,
    [shopId, invitationId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'front_desk_invitation_revoked',
    targetType: 'front_desk',
    targetId: invitationId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      invitation_id: invitationId
    }
  });

  return true;
}

/**
 * Lists front desk members and pending invitations for a shop.
 * Plaintext passwords, password hashes, and token hashes are NEVER returned.
 */
async function listFrontDeskMembers(dbOrPool, { shopId }) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  // 1. Query existing front desk accounts
  const accountsResult = await dbOrPool.query(
    `SELECT
       osm.id AS membership_id,
       osm.role,
       osm.is_active,
       osm.created_at AS member_since,
       oa.id AS account_id,
       oa.display_name,
       oa.login_identifier,
       oa.last_login_at
     FROM public.owner_shop_memberships osm
     JOIN public.owner_accounts oa ON oa.id = osm.owner_account_id
     WHERE osm.shop_id = $1 AND osm.role = 'front_desk'
     ORDER BY osm.created_at ASC`,
    [shopId]
  );

  // 2. Query pending invitations
  const invitationsResult = await dbOrPool.query(
    `SELECT
       id AS invitation_id,
       display_name_hint,
       invited_phone,
       invited_email,
       status,
       expires_at,
       created_at
     FROM public.front_desk_invitations
     WHERE shop_id = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [shopId]
  );

  return {
    members: accountsResult.rows.map(row => ({
      membershipId: row.membership_id,
      accountId: row.account_id,
      displayName: row.display_name,
      loginIdentifier: row.login_identifier,
      role: row.role,
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
      memberSince: row.member_since
    })),
    pendingInvitations: invitationsResult.rows.map(row => ({
      invitationId: row.invitation_id,
      displayNameHint: row.display_name_hint,
      invitedPhone: row.invited_phone,
      invitedEmail: row.invited_email,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    }))
  };
}

/**
 * Validates a front desk invitation token for the public activation page.
 */
async function validateFrontDeskInvitation(dbOrPool, rawToken) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!validateTokenFormat(token)) {
    return { isValid: false, state: 'INVALID' };
  }

  const tokenHash = hashToken(token);
  const result = await dbOrPool.query(
    `SELECT
       fdi.id,
       fdi.shop_id,
       fdi.role,
       fdi.display_name_hint,
       fdi.status,
       fdi.expires_at,
       fdi.consumed_at,
       fdi.revoked_at,
       fdi.expires_at <= NOW() AS is_expired,
       sh.name AS shop_name,
       sh.slug AS shop_slug,
       sh.status AS shop_status
     FROM public.front_desk_invitations fdi
     JOIN public.shops sh ON sh.id = fdi.shop_id
     WHERE fdi.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return { isValid: false, state: 'INVALID' };
  }

  const row = result.rows[0];

  if (row.status === 'consumed' || row.consumed_at) {
    return { isValid: false, state: 'ALREADY_CONSUMED' };
  }
  if (row.status === 'revoked' || row.revoked_at) {
    return { isValid: false, state: 'REVOKED' };
  }
  if (row.status === 'expired' || row.is_expired) {
    return { isValid: false, state: 'EXPIRED' };
  }
  if (row.shop_status !== 'active') {
    return { isValid: false, state: 'INACTIVE' };
  }
  if (row.status !== 'pending') {
    return { isValid: false, state: 'INVALID' };
  }

  return {
    isValid: true,
    state: 'VALID',
    data: {
      shopName: row.shop_name,
      displayNameHint: row.display_name_hint || null,
      role: 'front_desk'
    }
  };
}

/**
 * Consumes a front desk activation invitation in a single concurrency-safe transaction.
 * Role is strictly hardcoded to 'front_desk'. No path may create owner, manager, or admin.
 */
async function consumeFrontDeskInvitation(pool, {
  token,
  displayName,
  username,
  password,
  passwordConfirmation,
  consumedIp = null
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database pool is required');
  }

  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!validateTokenFormat(rawToken)) {
    throw new FrontDeskActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
  }

  // 1. Display name validation
  const cleanDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  if (!cleanDisplayName || cleanDisplayName.length > 100) {
    throw new FrontDeskActivationError('INVALID_DISPLAY_NAME', 400, 'Display name is required (up to 100 characters)');
  }

  // 2. Username validation (globally unique for owner_accounts)
  const normalizedUsername = normalizeLoginIdentifier(username);
  if (!normalizedUsername || normalizedUsername.length < 3 || normalizedUsername.length > 50) {
    throw new FrontDeskActivationError(
      'INVALID_LOGIN_IDENTIFIER',
      400,
      'Username must be between 3 and 50 characters'
    );
  }

  if (!/^[a-z0-9._-]+$/.test(normalizedUsername)) {
    throw new FrontDeskActivationError(
      'INVALID_LOGIN_IDENTIFIER_FORMAT',
      400,
      'Username can only contain letters, numbers, dots, hyphens, and underscores'
    );
  }

  // 3. Password validation
  const confirmation = passwordConfirmation !== undefined ? passwordConfirmation : password;
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

  // UTF-8 byte length safety
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

  const tokenHash = hashToken(rawToken);

  let client;
  let transactionActive = false;
  let discardClient = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionActive = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    // Lock invitation row
    const invResult = await client.query(
      `SELECT
         fdi.id,
         fdi.shop_id,
         fdi.role,
         fdi.status,
         fdi.expires_at,
         fdi.consumed_at,
         fdi.revoked_at,
         fdi.expires_at <= NOW() AS is_expired,
         sh.name AS shop_name,
         sh.slug AS shop_slug,
         sh.status AS shop_status
       FROM public.front_desk_invitations fdi
       JOIN public.shops sh ON sh.id = fdi.shop_id
       WHERE fdi.token_hash = $1
       LIMIT 1
       FOR UPDATE OF fdi`,
      [tokenHash]
    );

    if (invResult.rows.length === 0) {
      throw new FrontDeskActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
    }

    const invitation = invResult.rows[0];

    if (invitation.status === 'consumed' || invitation.consumed_at) {
      throw new FrontDeskActivationError('INVITATION_ALREADY_CONSUMED', 409, 'Invitation has already been used');
    }
    if (invitation.status === 'revoked' || invitation.revoked_at) {
      throw new FrontDeskActivationError('INVITATION_REVOKED', 410, 'Invitation has been revoked');
    }
    if (invitation.status === 'expired' || invitation.is_expired) {
      throw new FrontDeskActivationError('INVITATION_EXPIRED', 410, 'Invitation has expired');
    }
    if (invitation.status !== 'pending') {
      throw new FrontDeskActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
    }
    if (invitation.shop_status !== 'active') {
      throw new FrontDeskActivationError('SHOP_INACTIVE', 400, 'Shop is no longer active');
    }

    // CRITICAL SECURITY ENFORCEMENT: Server hardcodes role to 'front_desk'.
    // Client cannot override role, cannot become owner, manager, or admin.
    const hardcodedRole = 'front_desk';

    // Verify username is not in use across owner_accounts (global uniqueness)
    const existingAccount = await client.query(
      `SELECT id FROM public.owner_accounts
       WHERE login_identifier_normalized = $1
       LIMIT 1`,
      [normalizedUsername]
    );

    if (existingAccount.rows.length > 0) {
      throw new FrontDeskActivationError(
        'DUPLICATE_LOGIN_IDENTIFIER',
        409,
        'Username is already taken'
      );
    }

    // Hash password with bcrypt cost 12
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    // Create owner_accounts row
    const accountInsert = await client.query(
      `INSERT INTO public.owner_accounts (
         login_identifier,
         login_identifier_normalized,
         password_hash,
         display_name,
         is_active,
         session_version,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, TRUE, 1, NOW(), NOW())
       RETURNING id`,
      [
        normalizedUsername,
        normalizedUsername,
        passwordHash,
        cleanDisplayName
      ]
    );

    const ownerAccountId = accountInsert.rows[0].id;

    // Create owner_shop_memberships with strictly role = 'front_desk'
    const membershipInsert = await client.query(
      `INSERT INTO public.owner_shop_memberships (
         owner_account_id,
         shop_id,
         role,
         is_active,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, TRUE, NOW(), NOW())
       RETURNING id`,
      [ownerAccountId, invitation.shop_id, hardcodedRole]
    );

    const membershipId = membershipInsert.rows[0].id;

    // Mark invitation consumed
    const cleanIp = typeof consumedIp === 'string' ? consumedIp.trim().slice(0, 100) : null;
    const consumedResult = await client.query(
      `UPDATE public.front_desk_invitations
       SET status = 'consumed',
           consumed_at = NOW(),
           resulting_owner_account_id = $1,
           resulting_membership_id = $2,
           consumed_ip = $3,
           updated_at = NOW()
       WHERE id = $4
         AND status = 'pending'
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING id`,
      [ownerAccountId, membershipId, cleanIp, invitation.id]
    );

    if (consumedResult.rows.length !== 1) {
      throw new FrontDeskActivationError(
        'INVITATION_CONCURRENTLY_CHANGED',
        409,
        'Invitation is no longer available'
      );
    }

    // Record safe audit event
    await recordAuthAudit(client, {
      shopId: invitation.shop_id,
      eventType: 'front_desk_activated',
      targetType: 'front_desk',
      targetId: membershipId,
      operatorType: 'self_service',
      operatorId: null,
      metadata: {
        invitation_id: invitation.id,
        membership_id: membershipId,
        account_id: ownerAccountId
      }
    });

    await client.query('COMMIT');
    transactionActive = false;

    return {
      success: true,
      shopSlug: invitation.shop_slug,
      username: normalizedUsername,
      role: 'front_desk',
      loginUrl: '/admin.html'
    };
  } catch (error) {
    if (transactionActive && client) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        discardClient = true;
      }
    }
    if (error instanceof FrontDeskActivationError) {
      throw error;
    }
    throw new FrontDeskActivationError('ACTIVATION_FAILED', 500, 'Unable to complete activation');
  } finally {
    if (client) {
      client.release(discardClient || undefined);
    }
  }
}

/**
 * Disables a front desk membership.
 * owner_shop_memberships.is_active = FALSE.
 * Revokes all currently active owner_sessions for that membership immediately.
 * Preserves historical records.
 */
async function disableFrontDeskMembership(dbOrPool, {
  shopId,
  membershipId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  // 1. Update membership: set is_active = FALSE
  const updateResult = await dbOrPool.query(
    `UPDATE public.owner_shop_memberships
     SET is_active = FALSE,
         updated_at = NOW()
     WHERE id = $1 AND shop_id = $2 AND role = 'front_desk'
     RETURNING id, owner_account_id`,
    [membershipId, shopId]
  );

  if (updateResult.rows.length === 0) {
    throw new FrontDeskActivationError('MEMBERSHIP_NOT_FOUND', 404, 'Front desk membership not found');
  }

  const { owner_account_id: accountId } = updateResult.rows[0];

  // 2. Immediately revoke all active owner sessions for this membership
  await dbOrPool.query(
    `UPDATE public.owner_sessions
     SET revoked_at = NOW(),
         revoke_reason = 'owner_disabled'
     WHERE membership_id = $1 AND shop_id = $2 AND revoked_at IS NULL`,
    [membershipId, shopId]
  );

  // 3. Record safe audit event
  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'front_desk_disabled',
    targetType: 'front_desk',
    targetId: membershipId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      membership_id: membershipId,
      account_id: accountId,
      action: 'disabled'
    }
  });

  return { success: true };
}

/**
 * Reactivates a disabled front desk membership.
 * owner_shop_memberships.is_active = TRUE.
 * DO NOT restore old sessions. User must log in again.
 */
async function reactivateFrontDeskMembership(dbOrPool, {
  shopId,
  membershipId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new FrontDeskActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const updateResult = await dbOrPool.query(
    `UPDATE public.owner_shop_memberships
     SET is_active = TRUE,
         updated_at = NOW()
     WHERE id = $1 AND shop_id = $2 AND role = 'front_desk'
     RETURNING id, owner_account_id`,
    [membershipId, shopId]
  );

  if (updateResult.rows.length === 0) {
    throw new FrontDeskActivationError('MEMBERSHIP_NOT_FOUND', 404, 'Front desk membership not found');
  }

  const { owner_account_id: accountId } = updateResult.rows[0];

  // Old sessions remain revoked! User must log in again.

  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'front_desk_reactivated',
    targetType: 'front_desk',
    targetId: membershipId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      membership_id: membershipId,
      account_id: accountId,
      action: 'reactivated'
    }
  });

  return { success: true };
}

module.exports = {
  FrontDeskActivationError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  DEFAULT_INVITATION_TTL_DAYS,
  createFrontDeskInvitation,
  revokeFrontDeskInvitation,
  listFrontDeskMembers,
  validateFrontDeskInvitation,
  consumeFrontDeskInvitation,
  disableFrontDeskMembership,
  reactivateFrontDeskMembership,
  sanitizeAuditMetadata,
  resetFrontDeskPassword: (...args) => require('./front-desk-password-reset').resetFrontDeskPassword(...args)
};
