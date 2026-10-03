'use strict';

const crypto = require('crypto');

const PLATFORM_SESSION_COOKIE = 'gg_beauty_platform_session';
const PLATFORM_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const PLATFORM_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PLATFORM_LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const PLATFORM_LOGIN_LOCK_THRESHOLD = 5;
const MIN_SECRET_LENGTH = 32;
const MAX_REVOKED_SESSIONS = 10000;
const MAX_RATE_LIMIT_ENTRIES = 10000;

// Ephemeral process boot identifier to invalidate past sessions across restarts
const serverBootId = crypto.randomUUID
  ? crypto.randomUUID()
  : crypto.randomBytes(16).toString('hex');

const platformLoginRateLimits = new Map();
const revokedSessions = new Map(); // Map of jti => expiresAt
const recentAuditEvents = [];

const safeTimingCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

const isStrongSecret = secret => {
  return typeof secret === 'string' && secret.trim().length >= MIN_SECRET_LENGTH;
};

const pruneRevokedSessions = () => {
  const now = Date.now();
  for (const [jti, expiresAt] of revokedSessions.entries()) {
    if (expiresAt <= now) {
      revokedSessions.delete(jti);
    }
  }
  if (revokedSessions.size > MAX_REVOKED_SESSIONS) {
    const excess = revokedSessions.size - MAX_REVOKED_SESSIONS;
    let count = 0;
    for (const key of revokedSessions.keys()) {
      revokedSessions.delete(key);
      count++;
      if (count >= excess) break;
    }
  }
};

const pruneRateLimits = () => {
  const now = Date.now();
  for (const [ip, entry] of platformLoginRateLimits.entries()) {
    if (entry.lockedUntil && entry.lockedUntil <= now && entry.resetAt <= now) {
      platformLoginRateLimits.delete(ip);
    } else if (!entry.lockedUntil && entry.resetAt <= now) {
      platformLoginRateLimits.delete(ip);
    }
  }
  if (platformLoginRateLimits.size > MAX_RATE_LIMIT_ENTRIES) {
    const excess = platformLoginRateLimits.size - MAX_RATE_LIMIT_ENTRIES;
    let count = 0;
    for (const key of platformLoginRateLimits.keys()) {
      platformLoginRateLimits.delete(key);
      count++;
      if (count >= excess) break;
    }
  }
};

const resolveClientIp = req => {
  if (!req) return 'unknown';
  let ip = 'unknown';
  // If trust proxy is explicitly enabled on Express app, req.ip is populated by Express safely
  if (req.app && typeof req.app.get === 'function' && req.app.get('trust proxy')) {
    ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  } else {
    // Otherwise, use direct socket address (do NOT trust unverified x-forwarded-for headers)
    ip = (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
  }
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip;
};

const parseCookies = request => {
  const cookies = {};
  const cookieHeader = request && request.headers ? request.headers.cookie || '' : '';

  cookieHeader.split(';').forEach(part => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) return;
    const name = part.slice(0, separatorIndex).trim();
    if (!name) return;
    const encodedValue = part.slice(separatorIndex + 1).trim();
    try {
      cookies[name] = decodeURIComponent(encodedValue);
    } catch (_error) {
      cookies[name] = '';
    }
  });

  return cookies;
};

const platformCookieOptions = isProduction => [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${Math.floor(PLATFORM_SESSION_MAX_AGE_MS / 1000)}`,
  ...(isProduction ? ['Secure'] : [])
];

const clearPlatformCookieOptions = isProduction => [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  'Max-Age=0',
  'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ...(isProduction ? ['Secure'] : [])
];

/**
 * Creates Platform Authentication middleware and route handlers.
 *
 * @param {object} options
 * @param {function} [options.getPlatformToken] Returns the configured platform admin authentication credential
 * @param {function} [options.getSessionSecret] Returns the independent HMAC session signing secret
 * @param {function} [options.isSameOriginRequest] CSRF defense check
 * @param {boolean} [options.isProduction]
 * @param {string} [options.bootId] Optional server boot ID override for testing
 * @returns {object}
 */
function createPlatformAuth(options = {}) {
  const isProduction = options.isProduction !== undefined
    ? options.isProduction
    : process.env.NODE_ENV === 'production';

  const bootId = options.bootId || serverBootId;

  const getPlatformToken = typeof options.getPlatformToken === 'function'
    ? options.getPlatformToken
    : () => process.env.PLATFORM_ADMIN_TOKEN;

  const getSessionSecret = typeof options.getSessionSecret === 'function'
    ? options.getSessionSecret
    : () => process.env.PLATFORM_SESSION_SECRET;

  const isSameOriginRequest = typeof options.isSameOriginRequest === 'function'
    ? options.isSameOriginRequest
    : () => true;

  // Verifies that both authentication secret and session signing secret are configured,
  // meet minimum length (>= 32 chars), and are independent from each other.
  const validateConfiguration = () => {
    const platformToken = getPlatformToken();
    const sessionSecret = getSessionSecret();

    if (!isStrongSecret(platformToken) || !isStrongSecret(sessionSecret)) {
      return { ok: false, reason: 'SECRETS_INSUFFICIENT_LENGTH' };
    }

    if (platformToken.trim() === sessionSecret.trim()) {
      return { ok: false, reason: 'SECRETS_MUST_BE_INDEPENDENT' };
    }

    return { ok: true, platformToken: platformToken.trim(), sessionSecret: sessionSecret.trim() };
  };

  const signSessionToken = (payload, sessionSecret) => {
    const serializedPayload = JSON.stringify(payload);
    const encodedPayload = Buffer.from(serializedPayload, 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', sessionSecret)
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  };

  const verifySessionToken = (tokenString, sessionSecret) => {
    pruneRevokedSessions();

    if (typeof tokenString !== 'string' || !tokenString.includes('.')) {
      return { ok: false, reason: 'MALFORMED', payload: null };
    }
    const [encodedPayload, receivedSignature] = tokenString.split('.');
    if (!encodedPayload || !receivedSignature) {
      return { ok: false, reason: 'MALFORMED', payload: null };
    }

    const expectedSignature = crypto
      .createHmac('sha256', sessionSecret)
      .update(encodedPayload)
      .digest('base64url');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const receivedBuf = Buffer.from(receivedSignature, 'utf8');
    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      return { ok: false, reason: 'INVALID_SIGNATURE', payload: null };
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: 'MALFORMED', payload: null };
      }
      if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
        return { ok: false, reason: 'EXPIRED', payload };
      }
      // Require matching server boot ID so copied logged-out sessions cannot revive on restart
      if (payload.bootId !== bootId) {
        return { ok: false, reason: 'BOOT_ID_MISMATCH', payload };
      }
      if (payload.jti && revokedSessions.has(payload.jti)) {
        return { ok: false, reason: 'REVOKED', payload };
      }
      return { ok: true, payload };
    } catch (_err) {
      return { ok: false, reason: 'MALFORMED', payload: null };
    }
  };

  const auditPlatformEvent = ({ actor, action, invitationId, result = 'success', details }) => {
    const auditRecord = {
      auditType: 'PLATFORM_SECURITY_AUDIT',
      actor: actor || 'platform_operator',
      action,
      invitationId: invitationId || null,
      timestamp: new Date().toISOString(),
      result
    };
    if (details && typeof details === 'object') {
      const safeDetails = { ...details };
      // Strictly sanitize all secret/credential/token material from audit entries
      delete safeDetails.token;
      delete safeDetails.rawToken;
      delete safeDetails.tokenHash;
      delete safeDetails.token_hash;
      delete safeDetails.password;
      delete safeDetails.secret;
      delete safeDetails.signingSecret;
      delete safeDetails.session;
      delete safeDetails.sessionCookie;
      delete safeDetails.key;
      delete safeDetails.DATABASE_URL;
      delete safeDetails.dbPassword;
      delete safeDetails.apiKey;
      delete safeDetails.onboardingUrl;

      // Ensure no nested strings leak raw tokens or sensitive URLs
      for (const [k, v] of Object.entries(safeDetails)) {
        if (typeof v === 'string' && (v.includes('token=') || v.includes('invitation_token') || v.length > 500)) {
          delete safeDetails[k];
        }
      }

      auditRecord.details = safeDetails;
    }
    recentAuditEvents.push(auditRecord);
    if (recentAuditEvents.length > 200) {
      recentAuditEvents.shift();
    }
    if (process.env.NODE_ENV !== 'test') {
      console.info(JSON.stringify(auditRecord));
    }
    return auditRecord;
  };

  const checkRateLimit = ip => {
    pruneRateLimits();
    const now = Date.now();
    let record = platformLoginRateLimits.get(ip);
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + PLATFORM_LOGIN_RATE_LIMIT_WINDOW_MS, lockedUntil: null };
      platformLoginRateLimits.set(ip, record);
    }

    if (record.lockedUntil && record.lockedUntil > now) {
      return false;
    }

    if (record.count >= PLATFORM_LOGIN_LOCK_THRESHOLD) {
      record.lockedUntil = now + PLATFORM_LOGIN_LOCK_DURATION_MS;
      return false;
    }

    return true;
  };

  const recordFailedAttempt = ip => {
    pruneRateLimits();
    const now = Date.now();
    let record = platformLoginRateLimits.get(ip);
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + PLATFORM_LOGIN_RATE_LIMIT_WINDOW_MS, lockedUntil: null };
      platformLoginRateLimits.set(ip, record);
    }
    record.count++;
    if (record.count >= PLATFORM_LOGIN_LOCK_THRESHOLD) {
      record.lockedUntil = now + PLATFORM_LOGIN_LOCK_DURATION_MS;
    }
  };

  const resetRateLimit = ip => {
    if (!ip) {
      platformLoginRateLimits.clear();
      return;
    }
    const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    platformLoginRateLimits.delete(cleanIp);
    platformLoginRateLimits.delete(`::ffff:${cleanIp}`);
  };

  const requirePlatformAuth = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const config = validateConfiguration();
    if (!config.ok) {
      auditPlatformEvent({
        actor: 'system',
        action: 'platform_unauthorized_attempt',
        result: 'failure',
        details: { path: req.originalUrl || req.path, reason: config.reason }
      });
      return res.status(503).json({
        success: false,
        code: 'PLATFORM_AUTH_NOT_CONFIGURED',
        message: 'Platform administration is not configured'
      });
    }

    // Browser-based session cookie is the ONLY permitted authentication method for V1
    const cookies = parseCookies(req);
    const sessionCookie = cookies[PLATFORM_SESSION_COOKIE];
    const clientIp = resolveClientIp(req);

    if (sessionCookie) {
      const verifyResult = verifySessionToken(sessionCookie, config.sessionSecret);
      if (verifyResult.ok) {
        req.platformAuth = {
          actor: verifyResult.payload.actor || 'platform_operator',
          jti: verifyResult.payload.jti,
          authMethod: 'session'
        };
        return next();
      }

      if (verifyResult.reason === 'EXPIRED') {
        auditPlatformEvent({
          actor: 'unauthenticated',
          action: 'platform_session_expired',
          result: 'failure',
          details: { path: req.originalUrl || req.path, ip: clientIp }
        });
      } else if (verifyResult.reason === 'REVOKED') {
        auditPlatformEvent({
          actor: 'unauthorized',
          action: 'platform_session_invalid',
          result: 'failure',
          details: { path: req.originalUrl || req.path, ip: clientIp, reason: 'session_revoked' }
        });
      } else {
        auditPlatformEvent({
          actor: 'unauthorized',
          action: 'platform_session_invalid',
          result: 'failure',
          details: { path: req.originalUrl || req.path, ip: clientIp, reason: (verifyResult.reason || 'invalid').toLowerCase() }
        });
      }

      return res.status(401).json({
        success: false,
        code: 'PLATFORM_AUTH_REQUIRED',
        message: 'Platform admin authorization required'
      });
    }

    // Audit unauthorized attempt
    auditPlatformEvent({
      actor: 'unauthorized',
      action: 'platform_unauthorized_attempt',
      result: 'failure',
      details: {
        path: req.originalUrl || req.path,
        method: req.method,
        ip: clientIp,
        hasOwnerCookie: Boolean(cookies.gg_beauty_owner_session),
        hasStaffCookie: Boolean(cookies.gg_beauty_staff_session),
        hasCustomerCookie: Boolean(cookies.gg_customer_session)
      }
    });

    // Strict rejection for any unauthenticated or merchant-level callers
    return res.status(401).json({
      success: false,
      code: 'PLATFORM_AUTH_REQUIRED',
      message: 'Platform admin authorization required'
    });
  };

  const login = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.headers && req.headers.origin && typeof isSameOriginRequest === 'function' && !isSameOriginRequest(req)) {
      auditPlatformEvent({
        actor: 'unauthenticated',
        action: 'platform_csrf_rejected',
        result: 'failure',
        details: {
          path: '/api/platform/login',
          origin: req.headers.origin
        }
      });
      return res.status(403).json({
        success: false,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request rejected'
      });
    }

    const config = validateConfiguration();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        code: 'PLATFORM_AUTH_NOT_CONFIGURED',
        message: 'Platform administration is not configured'
      });
    }

    const clientIp = resolveClientIp(req);
    if (!checkRateLimit(clientIp)) {
      auditPlatformEvent({
        actor: 'unauthenticated',
        action: 'platform_rate_limit_exceeded',
        result: 'failure',
        details: { ip: clientIp }
      });
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many failed login attempts. Please try again later.'
      });
    }

    const candidate = req.body && (req.body.token || req.body.key || req.body.password);
    const candidateString = typeof candidate === 'string' ? candidate.trim() : '';
    const isCandidateValid = candidateString.length >= MIN_SECRET_LENGTH;

    // Constant-time comparison: always compute SHA-256 and timingSafeEqual
    const tokenMatches = safeTimingCompare(candidateString, config.platformToken);
    const matches = isCandidateValid && tokenMatches;

    if (!matches) {
      recordFailedAttempt(clientIp);
      auditPlatformEvent({
        actor: 'unauthenticated',
        action: 'platform_login_failed',
        result: 'failure',
        details: {
          ip: clientIp,
          reason: !candidateString
            ? 'missing_credential'
            : (isCandidateValid ? 'invalid_credential' : 'credential_below_minimum_length')
        }
      });
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid platform credential'
      });
    }

    resetRateLimit(clientIp);

    const jti = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const payload = {
      actor: 'platform_operator',
      jti,
      bootId,
      exp: Date.now() + PLATFORM_SESSION_MAX_AGE_MS
    };

    const sessionToken = signSessionToken(payload, config.sessionSecret);

    res.setHeader(
      'Set-Cookie',
      `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; ${platformCookieOptions(isProduction).join('; ')}`
    );

    auditPlatformEvent({
      actor: 'platform_operator',
      action: 'platform_login_success',
      result: 'success',
      details: { jti }
    });

    return res.json({
      success: true,
      data: {
        actor: 'platform_operator'
      }
    });
  };

  const logout = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.headers && req.headers.origin && typeof isSameOriginRequest === 'function' && !isSameOriginRequest(req)) {
      auditPlatformEvent({
        actor: 'unauthenticated',
        action: 'platform_csrf_rejected',
        result: 'failure',
        details: {
          path: '/api/platform/logout',
          origin: req.headers.origin
        }
      });
      return res.status(403).json({
        success: false,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request rejected'
      });
    }

    const config = validateConfiguration();
    const cookies = parseCookies(req);
    const sessionCookie = cookies[PLATFORM_SESSION_COOKIE];
    let revokedJti = null;

    if (sessionCookie && config.ok) {
      const verifyResult = verifySessionToken(sessionCookie, config.sessionSecret);
      if (verifyResult.payload && verifyResult.payload.jti) {
        revokedSessions.set(verifyResult.payload.jti, verifyResult.payload.exp || (Date.now() + PLATFORM_SESSION_MAX_AGE_MS));
        revokedJti = verifyResult.payload.jti;
      }
    }

    res.setHeader(
      'Set-Cookie',
      `${PLATFORM_SESSION_COOKIE}=; ${clearPlatformCookieOptions(isProduction).join('; ')}`
    );

    if (revokedJti) {
      auditPlatformEvent({
        actor: 'platform_operator',
        action: 'platform_session_revoked',
        result: 'success',
        details: { jti: revokedJti }
      });
    }

    auditPlatformEvent({
      actor: req.platformAuth ? req.platformAuth.actor : 'platform_operator',
      action: 'platform_logout',
      result: 'success'
    });

    return res.json({
      success: true
    });
  };

  const me = (req, res) => {
    return res.json({
      success: true,
      data: {
        actor: req.platformAuth ? req.platformAuth.actor : 'platform_operator'
      }
    });
  };

  return {
    PLATFORM_SESSION_COOKIE,
    MIN_SECRET_LENGTH,
    serverBootId: bootId,
    createPlatformAuth,
    requirePlatformAuth,
    login,
    logout,
    me,
    auditPlatformEvent,
    signSessionToken,
    verifySessionToken,
    validateConfiguration,
    safeTimingCompare,
    isStrongSecret,
    resetRateLimit,
    getRecentAuditEvents: () => [...recentAuditEvents],
    clearRecentAuditEvents: () => { recentAuditEvents.length = 0; },
    _revokedSessions: revokedSessions,
    _rateLimits: platformLoginRateLimits
  };
}

module.exports = {
  PLATFORM_SESSION_COOKIE,
  MIN_SECRET_LENGTH,
  createPlatformAuth
};
