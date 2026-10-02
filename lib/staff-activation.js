'use strict';

const bcrypt = require('bcryptjs');
const {
  generateToken,
  hashToken,
  validateTokenFormat
} = require('./invitation-token');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_BYTES = 72; // UTF-8 byte boundary to prevent bcrypt truncation
const DEFAULT_INVITATION_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;
class StaffActivationError extends Error {
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.name = 'StaffActivationError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const MAX_SANITIZER_DEPTH = 10;

function isSecretKey(key) {
  if (typeof key !== 'string') return true;
  const trimmed = key.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const stripped = lower.replace(/[-_.\s]/g, '');

  // 1. Passwords and credentials
  if (stripped.includes('password') || stripped.includes('passwd')) {
    return true;
  }

  // 2. Tokens (raw, hashed, session, auth, jwt, etc.)
  if (stripped.includes('token')) {
    return true;
  }

  // 3. Secrets, API keys, private keys, signing keys, Render secrets, Supabase keys
  if (
    stripped.includes('secret') ||
    stripped.includes('apikey') ||
    stripped.includes('supabase') ||
    stripped.includes('privatekey') ||
    stripped.includes('signingkey') ||
    stripped.includes('masterkey') ||
    stripped.includes('accesskey')
  ) {
    return true;
  }

  // 4. Database URLs, connection strings, DB credentials
  if (
    stripped.includes('dburl') ||
    stripped.includes('databaseurl') ||
    stripped.includes('dbconn') ||
    stripped.includes('dbconnection') ||
    stripped.includes('databaseconnection') ||
    stripped.includes('connectionstring') ||
    stripped.includes('dburi') ||
    stripped.includes('databaseuri') ||
    stripped.includes('dbpass')
  ) {
    return true;
  }

  // 5. Session and Cookies
  if (stripped.includes('cookie') || stripped.includes('session')) {
    return true;
  }

  // 6. Hashes
  if (stripped.includes('hash')) {
    return true;
  }

  // 7. Authorization, Bearer, and Auth headers/keys
  if (
    stripped.includes('authorization') ||
    stripped.includes('credential') ||
    stripped.includes('bearer') ||
    stripped.includes('authtoken') ||
    stripped.includes('authkey') ||
    stripped.includes('authsecret') ||
    stripped.includes('authheader') ||
    stripped === 'auth'
  ) {
    return true;
  }

  return false;
}

function sanitizeAuditValue(val, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_SANITIZER_DEPTH) {
    return undefined;
  }
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val !== 'object') {
    return val;
  }
  if (seen.has(val)) {
    return undefined;
  }
  seen.add(val);

  if (Array.isArray(val)) {
    const sanitizedArray = [];
    for (const item of val) {
      const sanitizedItem = sanitizeAuditValue(item, depth + 1, seen);
      if (sanitizedItem !== undefined) {
        sanitizedArray.push(sanitizedItem);
      }
    }
    return sanitizedArray;
  }

  const sanitizedObj = {};
  for (const [key, value] of Object.entries(val)) {
    if (isSecretKey(key)) {
      continue;
    }
    const sanitizedChild = sanitizeAuditValue(value, depth + 1, seen);
    if (sanitizedChild !== undefined) {
      sanitizedObj[key] = sanitizedChild;
    }
  }
  return sanitizedObj;
}

function sanitizeAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return sanitizeAuditValue(metadata, 0, new WeakSet()) || {};
}

async function recordAuthAudit(clientOrPool, {
  shopId,
  eventType,
  targetType,
  targetId,
  operatorType,
  operatorId = null,
  metadata = {}
}) {
  const safeMeta = sanitizeAuditMetadata(metadata);
  const sql = `
    INSERT INTO public.merchant_auth_audit (
      shop_id,
      event_type,
      target_type,
      target_id,
      operator_type,
      operator_id,
      metadata,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING id
  `;
  const result = await clientOrPool.query(sql, [
    shopId,
    eventType,
    targetType,
    targetId,
    operatorType,
    operatorId,
    JSON.stringify(safeMeta)
  ]);
  return result.rows[0]?.id;
}

function normalizeLoginIdentifier(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Creates a staff activation invitation.
 * Enforces mandatory location requirement: staff must have at least one active location in this shop.
 */
async function createStaffActivationInvitation(dbOrPool, {
  shopId,
  staffId,
  operatorId,
  ttlDays = DEFAULT_INVITATION_TTL_DAYS,
  baseUrl = 'http://localhost:3000'
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const parsedTtl = Number(ttlDays);
  if (!Number.isInteger(parsedTtl) || parsedTtl < MIN_TTL_DAYS || parsedTtl > MAX_TTL_DAYS) {
    throw new StaffActivationError(
      'INVALID_TTL',
      400,
      `ttlDays must be an integer between ${MIN_TTL_DAYS} and ${MAX_TTL_DAYS}`
    );
  }

  // 1. Verify staff exists, belongs to this shop, and is active
  const staffResult = await dbOrPool.query(
    `SELECT id, name, is_active, can_login, staff_code, phone
     FROM public.staff
     WHERE id = $1 AND shop_id = $2
     LIMIT 1`,
    [staffId, shopId]
  );

  if (staffResult.rows.length === 0) {
    throw new StaffActivationError('STAFF_NOT_FOUND', 404, 'Staff member not found');
  }

  const staff = staffResult.rows[0];
  if (staff.is_active !== true) {
    throw new StaffActivationError('STAFF_INACTIVE', 400, 'Staff member is inactive and cannot be activated');
  }

  if (staff.can_login !== true) {
    throw new StaffActivationError('STAFF_LOGIN_DISABLED', 400, 'Staff member login permission is disabled');
  }

  // 2. MANDATORY CHECK: Staff must have at least one active location assignment in this shop
  const locationCheck = await dbOrPool.query(
    `SELECT sla.location_id
     FROM public.staff_location_assignments sla
     JOIN public.locations l ON l.id = sla.location_id AND l.shop_id = sla.shop_id
     WHERE sla.shop_id = $1
       AND sla.staff_id = $2
       AND sla.is_active = TRUE
       AND l.is_active = TRUE
     LIMIT 1`,
    [shopId, staffId]
  );

  if (locationCheck.rows.length === 0) {
    throw new StaffActivationError(
      'STAFF_LOCATION_REQUIRED',
      400,
      'Assign at least one work location before generating an activation link.'
    );
  }

  // 3. Verify no active staff account exists
  const existingAccount = await dbOrPool.query(
    `SELECT id, status FROM public.staff_accounts
     WHERE shop_id = $1 AND staff_id = $2
     LIMIT 1`,
    [shopId, staffId]
  );

  if (existingAccount.rows.length > 0 && existingAccount.rows[0].status === 'active') {
    throw new StaffActivationError(
      'STAFF_ACCOUNT_ALREADY_EXISTS',
      409,
      'Staff member already has an active account'
    );
  }

  // 4. Revoke any existing pending invitations for this staff member
  await dbOrPool.query(
    `UPDATE public.staff_activation_invitations
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE shop_id = $1 AND staff_id = $2 AND status = 'pending'`,
    [shopId, staffId]
  );

  // 5. Generate secure random token (raw token NEVER stored in database)
  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + parsedTtl * 24 * 60 * 60 * 1000);

  const insertSql = `
    INSERT INTO public.staff_activation_invitations (
      shop_id,
      staff_id,
      token_hash,
      status,
      expires_at,
      created_by_owner_account_id
    ) VALUES ($1, $2, $3, 'pending', $4, $5)
    RETURNING id, status, expires_at, created_at
  `;

  const insertResult = await dbOrPool.query(insertSql, [
    shopId,
    staffId,
    tokenHash,
    expiresAt,
    operatorId
  ]);

  const row = insertResult.rows[0];
  const cleanBaseUrl = (typeof baseUrl === 'string' && baseUrl.trim())
    ? baseUrl.trim().replace(/\/+$/, '')
    : 'http://localhost:3000';
  const activationUrl = `${cleanBaseUrl}/staff-activate.html?token=${rawToken}`;

  // 6. Record safe audit event
  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'staff_invitation_created',
    targetType: 'staff',
    targetId: staffId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      invitation_id: row.id,
      staff_id: staffId,
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
 * Revokes a pending staff activation invitation.
 */
async function revokeStaffActivationInvitation(dbOrPool, {
  shopId,
  staffId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const result = await dbOrPool.query(
    `UPDATE public.staff_activation_invitations
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE shop_id = $1 AND staff_id = $2 AND status = 'pending'
     RETURNING id`,
    [shopId, staffId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'staff_invitation_revoked',
    targetType: 'staff',
    targetId: staffId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      invitation_id: result.rows[0].id,
      staff_id: staffId
    }
  });

  return true;
}

/**
 * Validates a staff activation invitation token for the public activation page.
 */
async function validateStaffInvitation(dbOrPool, rawToken) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!validateTokenFormat(token)) {
    return { isValid: false, state: 'INVALID' };
  }

  const tokenHash = hashToken(token);
  const result = await dbOrPool.query(
    `SELECT
       sai.id,
       sai.shop_id,
       sai.staff_id,
       sai.status,
       sai.expires_at,
       sai.consumed_at,
       sai.revoked_at,
       sai.expires_at <= NOW() AS is_expired,
       s.name AS staff_name,
       s.staff_code,
       s.is_active AS staff_is_active,
       s.can_login AS staff_can_login,
       sh.name AS shop_name,
       sh.slug AS shop_slug,
       sh.status AS shop_status
     FROM public.staff_activation_invitations sai
     JOIN public.staff s ON s.id = sai.staff_id AND s.shop_id = sai.shop_id
     JOIN public.shops sh ON sh.id = sai.shop_id
     WHERE sai.token_hash = $1
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
  if (row.staff_is_active !== true || row.staff_can_login !== true || row.shop_status !== 'active') {
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
      staffName: row.staff_name,
      loginIdentifierHint: row.staff_code || null
    }
  };
}

/**
 * Consumes a staff activation invitation in a single concurrency-safe transaction.
 * Client does not control shop_id, staff_id, or permissions.
 */
async function consumeStaffActivationInvitation(pool, {
  token,
  username,
  password,
  passwordConfirmation,
  consumedIp = null
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database pool is required');
  }

  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!validateTokenFormat(rawToken)) {
    throw new StaffActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
  }

  // 1. Password validation
  const confirmation = passwordConfirmation !== undefined ? passwordConfirmation : password;
  if (typeof password !== 'string' || typeof confirmation !== 'string') {
    throw new StaffActivationError('INVALID_PASSWORD', 400, 'Password is required');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new StaffActivationError(
      'PASSWORD_TOO_SHORT',
      400,
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }

  // UTF-8 byte length safety (prevent silent truncation beyond 72 bytes)
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new StaffActivationError(
      'PASSWORD_TOO_LONG',
      400,
      'Password must not exceed 72 bytes in UTF-8 encoding'
    );
  }

  if (password !== confirmation) {
    throw new StaffActivationError(
      'PASSWORD_CONFIRMATION_MISMATCH',
      400,
      'Password confirmation does not match'
    );
  }

  // 2. Username validation
  const normalizedUsername = normalizeLoginIdentifier(username);
  if (!normalizedUsername || normalizedUsername.length < 3 || normalizedUsername.length > 50) {
    throw new StaffActivationError(
      'INVALID_LOGIN_IDENTIFIER',
      400,
      'Username must be between 3 and 50 characters'
    );
  }

  if (!/^[a-z0-9._-]+$/.test(normalizedUsername)) {
    throw new StaffActivationError(
      'INVALID_LOGIN_IDENTIFIER_FORMAT',
      400,
      'Username can only contain letters, numbers, dots, hyphens, and underscores'
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
         sai.id,
         sai.shop_id,
         sai.staff_id,
         sai.status,
         sai.expires_at,
         sai.consumed_at,
         sai.revoked_at,
         sai.expires_at <= NOW() AS is_expired,
         s.name AS staff_name,
         s.is_active AS staff_is_active,
         s.can_login AS staff_can_login,
         sh.name AS shop_name,
         sh.slug AS shop_slug,
         sh.status AS shop_status
       FROM public.staff_activation_invitations sai
       JOIN public.staff s ON s.id = sai.staff_id AND s.shop_id = sai.shop_id
       JOIN public.shops sh ON sh.id = sai.shop_id
       WHERE sai.token_hash = $1
       LIMIT 1
       FOR UPDATE OF sai`,
      [tokenHash]
    );

    if (invResult.rows.length === 0) {
      throw new StaffActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
    }

    const invitation = invResult.rows[0];

    if (invitation.status === 'consumed' || invitation.consumed_at) {
      throw new StaffActivationError('INVITATION_ALREADY_CONSUMED', 409, 'Invitation has already been used');
    }
    if (invitation.status === 'revoked' || invitation.revoked_at) {
      throw new StaffActivationError('INVITATION_REVOKED', 410, 'Invitation has been revoked');
    }
    if (invitation.status === 'expired' || invitation.is_expired) {
      throw new StaffActivationError('INVITATION_EXPIRED', 410, 'Invitation has expired');
    }
    if (invitation.status !== 'pending') {
      throw new StaffActivationError('INVITATION_INVALID', 404, 'Invitation is invalid');
    }
    if (invitation.staff_is_active !== true || invitation.staff_can_login !== true || invitation.shop_status !== 'active') {
      throw new StaffActivationError('STAFF_INACTIVE', 400, 'Staff member is no longer active');
    }

    // Verify active location assignment exists
    const locationResult = await client.query(
      `SELECT 1 FROM public.staff_location_assignments
       WHERE shop_id = $1 AND staff_id = $2 AND is_active = TRUE
       LIMIT 1`,
      [invitation.shop_id, invitation.staff_id]
    );

    if (locationResult.rows.length === 0) {
      throw new StaffActivationError('STAFF_LOCATION_REQUIRED', 400, 'Staff member has no active location');
    }

    // Verify username is not in use in this shop
    const userCollision = await client.query(
      `SELECT id FROM public.staff_accounts
       WHERE shop_id = $1 AND login_identifier_normalized = $2
       LIMIT 1`,
      [invitation.shop_id, normalizedUsername]
    );

    if (userCollision.rows.length > 0) {
      throw new StaffActivationError(
        'DUPLICATE_LOGIN_IDENTIFIER',
        409,
        'Username is already taken in this shop'
      );
    }

    // Verify no existing staff account exists for this staff member
    const existingStaffAccount = await client.query(
      `SELECT id FROM public.staff_accounts
       WHERE shop_id = $1 AND staff_id = $2
       LIMIT 1`,
      [invitation.shop_id, invitation.staff_id]
    );

    if (existingStaffAccount.rows.length > 0) {
      throw new StaffActivationError(
        'STAFF_ACCOUNT_ALREADY_EXISTS',
        409,
        'Staff account already exists'
      );
    }

    // Hash password with bcrypt cost 12
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    // Create staff account
    const accountInsert = await client.query(
      `INSERT INTO public.staff_accounts (
         shop_id,
         staff_id,
         login_identifier,
         login_identifier_normalized,
         password_hash,
         status,
         session_version,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 1, NOW(), NOW())
       RETURNING id`,
      [
        invitation.shop_id,
        invitation.staff_id,
        normalizedUsername,
        normalizedUsername,
        passwordHash
      ]
    );

    const staffAccountId = accountInsert.rows[0].id;

    // Create default least-privilege staff permissions
    await client.query(
      `INSERT INTO public.staff_permissions (
         shop_id,
         staff_account_id,
         can_view_customer_history,
         can_view_service_notes,
         can_view_own_sales,
         can_view_own_commission,
         can_view_full_customer_phone,
         can_move_own_appointments,
         can_update_own_appointment_status,
         created_at,
         updated_at
       ) VALUES ($1, $2, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, TRUE)
       ON CONFLICT (shop_id, staff_account_id) DO NOTHING`,
      [invitation.shop_id, staffAccountId]
    );

    // Mark invitation consumed
    const cleanIp = typeof consumedIp === 'string' ? consumedIp.trim().slice(0, 100) : null;
    const consumedResult = await client.query(
      `UPDATE public.staff_activation_invitations
       SET status = 'consumed',
           consumed_at = NOW(),
           resulting_staff_account_id = $1,
           consumed_ip = $2,
           updated_at = NOW()
       WHERE id = $3
         AND status = 'pending'
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING id`,
      [staffAccountId, cleanIp, invitation.id]
    );

    if (consumedResult.rows.length !== 1) {
      throw new StaffActivationError(
        'INVITATION_CONCURRENTLY_CHANGED',
        409,
        'Invitation is no longer available'
      );
    }

    // Record safe audit event
    await recordAuthAudit(client, {
      shopId: invitation.shop_id,
      eventType: 'staff_account_activated',
      targetType: 'staff',
      targetId: invitation.staff_id,
      operatorType: 'self_service',
      operatorId: null,
      metadata: {
        invitation_id: invitation.id,
        staff_id: invitation.staff_id,
        account_id: staffAccountId
      }
    });

    await client.query('COMMIT');
    transactionActive = false;

    return {
      success: true,
      shopSlug: invitation.shop_slug,
      username: normalizedUsername,
      loginUrl: '/staff-login.html'
    };
  } catch (error) {
    if (transactionActive && client) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        discardClient = true;
      }
    }
    if (error instanceof StaffActivationError) {
      throw error;
    }
    throw new StaffActivationError('ACTIVATION_FAILED', 500, 'Unable to complete activation');
  } finally {
    if (client) {
      client.release(discardClient || undefined);
    }
  }
}

/**
 * Disables a staff login account.
 * Increments session_version and revokes all active sessions immediately.
 * Preserves historical staff, appointment, and service records.
 */
async function disableStaffAccount(dbOrPool, {
  shopId,
  staffId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  // 1. Update staff account: set status='disabled', increment session_version
  const updateResult = await dbOrPool.query(
    `UPDATE public.staff_accounts
     SET status = 'disabled',
         disabled_at = NOW(),
         session_version = session_version + 1,
         updated_at = NOW()
     WHERE shop_id = $1 AND staff_id = $2
     RETURNING id`,
    [shopId, staffId]
  );

  if (updateResult.rows.length === 0) {
    throw new StaffActivationError('STAFF_ACCOUNT_NOT_FOUND', 404, 'Staff account not found');
  }

  const accountId = updateResult.rows[0].id;

  // 2. Immediately revoke all active staff sessions for this account
  await dbOrPool.query(
    `UPDATE public.staff_sessions
     SET revoked_at = NOW(),
         revoke_reason = 'owner_disabled'
     WHERE shop_id = $1 AND staff_account_id = $2 AND revoked_at IS NULL`,
    [shopId, accountId]
  );

  // 3. Record safe audit event
  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'staff_account_disabled',
    targetType: 'staff',
    targetId: staffId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      staff_id: staffId,
      account_id: accountId,
      action: 'disabled'
    }
  });

  return { success: true };
}

/**
 * Reactivates a disabled staff login account.
 * Old sessions remain invalid. User must log in again with new session.
 */
async function reactivateStaffAccount(dbOrPool, {
  shopId,
  staffId,
  operatorId
}) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  const updateResult = await dbOrPool.query(
    `UPDATE public.staff_accounts
     SET status = 'active',
         disabled_at = NULL,
         locked_until = NULL,
         failed_login_attempts = 0,
         updated_at = NOW()
     WHERE shop_id = $1 AND staff_id = $2
     RETURNING id`,
    [shopId, staffId]
  );

  if (updateResult.rows.length === 0) {
    throw new StaffActivationError('STAFF_ACCOUNT_NOT_FOUND', 404, 'Staff account not found');
  }

  const accountId = updateResult.rows[0].id;

  await recordAuthAudit(dbOrPool, {
    shopId,
    eventType: 'staff_account_reactivated',
    targetType: 'staff',
    targetId: staffId,
    operatorType: 'owner',
    operatorId,
    metadata: {
      staff_id: staffId,
      account_id: accountId,
      action: 'reactivated'
    }
  });

  return { success: true };
}

/**
 * Retrieves staff account status, active location existence, and latest invitation.
 */
async function getStaffAccountInfo(dbOrPool, { shopId, staffId }) {
  if (!dbOrPool || typeof dbOrPool.query !== 'function') {
    throw new StaffActivationError('INVALID_DATABASE_CLIENT', 500, 'Database client is required');
  }

  // 1. Verify staff exists in this shop
  const staffRes = await dbOrPool.query(
    `SELECT id, name, staff_code, is_active, can_login FROM public.staff WHERE id = $1 AND shop_id = $2 LIMIT 1`,
    [staffId, shopId]
  );
  if (staffRes.rows.length === 0) {
    throw new StaffActivationError('STAFF_NOT_FOUND', 404, 'Staff member not found');
  }
  const staff = staffRes.rows[0];

  // 2. Check active location assignments
  const locRes = await dbOrPool.query(
    `SELECT 1 FROM public.staff_location_assignments sla
     JOIN public.locations l ON l.id = sla.location_id AND l.shop_id = sla.shop_id
     WHERE sla.shop_id = $1 AND sla.staff_id = $2 AND sla.is_active = TRUE AND l.is_active = TRUE
     LIMIT 1`,
    [shopId, staffId]
  );
  const hasActiveLocation = locRes.rows.length > 0;

  // 3. Check staff account
  const accountRes = await dbOrPool.query(
    `SELECT id, username, status, failed_login_attempts, locked_until, disabled_at, created_at, updated_at
     FROM public.staff_accounts
     WHERE shop_id = $1 AND staff_id = $2
     LIMIT 1`,
    [shopId, staffId]
  );
  const account = accountRes.rows.length > 0 ? accountRes.rows[0] : null;

  // 4. Check latest invitation
  const invRes = await dbOrPool.query(
    `SELECT id, status, expires_at, created_at, consumed_at, revoked_at,
            (expires_at <= NOW()) AS is_expired
     FROM public.staff_activation_invitations
     WHERE shop_id = $1 AND staff_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [shopId, staffId]
  );
  let invitation = null;
  if (invRes.rows.length > 0) {
    const inv = invRes.rows[0];
    invitation = {
      id: inv.id,
      status: (inv.status === 'pending' && inv.is_expired) ? 'expired' : inv.status,
      expiresAt: inv.expires_at,
      createdAt: inv.created_at,
      consumedAt: inv.consumed_at,
      revokedAt: inv.revoked_at
    };
  }

  return {
    staff: {
      id: staff.id,
      name: staff.name,
      staffCode: staff.staff_code,
      isActive: staff.is_active,
      canLogin: staff.can_login
    },
    hasActiveLocation,
    hasAccount: !!account,
    account: account ? {
      id: account.id,
      username: account.username,
      status: account.status,
      disabledAt: account.disabled_at,
      lockedUntil: account.locked_until,
      createdAt: account.created_at,
      updatedAt: account.updated_at
    } : null,
    latestInvitation: invitation
  };
}

module.exports = {
  StaffActivationError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  DEFAULT_INVITATION_TTL_DAYS,
  createStaffActivationInvitation,
  revokeStaffActivationInvitation,
  validateStaffInvitation,
  consumeStaffActivationInvitation,
  disableStaffAccount,
  reactivateStaffAccount,
  getStaffAccountInfo,
  recordAuthAudit,
  sanitizeAuditMetadata,
  normalizeLoginIdentifier
};
