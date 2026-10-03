'use strict';

const crypto = require('crypto');

const PLATFORM_SESSION_COOKIE = 'gg_beauty_platform_session';
const PLATFORM_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const PLATFORM_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PLATFORM_LOGIN_RATE_LIMIT_MAX_REQUESTS = 10;
const PLATFORM_LOGIN_LOCK_THRESHOLD = 5;

const platformLoginRateLimits = new Map();
const revokedSessionJtis = new Set();

const safeTimingCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
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
 * @param {function} [options.getPlatformToken] Returns the configured platform admin token
 * @param {function} [options.isSameOriginRequest] CSRF defense check
 * @param {boolean} [options.isProduction]
 * @returns {object}
 */
function createPlatformAuth(options = {}) {
  const isProduction = options.isProduction !== undefined
    ? options.isProduction
    : process.env.NODE_ENV === 'production';

  const getPlatformToken = typeof options.getPlatformToken === 'function'
    ? options.getPlatformToken
    : () => process.env.PLATFORM_ADMIN_TOKEN;

  const isSameOriginRequest = typeof options.isSameOriginRequest === 'function'
    ? options.isSameOriginRequest
    : () => true;

  // Derives a 256-bit signing key for session HMACs from the platform token
  const getSigningSecret = () => {
    const token = getPlatformToken();
    if (!token) return null;
    return crypto.createHmac('sha256', 'gg-beauty-platform-session-salt').update(token).digest();
  };

  const signSessionToken = payload => {
    const signingSecret = getSigningSecret();
    if (!signingSecret) {
      throw new Error('PLATFORM_SIGNING_UNAVAILABLE');
    }
    const serializedPayload = JSON.stringify(payload);
    const encodedPayload = Buffer.from(serializedPayload, 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', signingSecret)
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  };

  const verifySessionToken = tokenString => {
    if (typeof tokenString !== 'string' || !tokenString.includes('.')) {
      return null;
    }
    const [encodedPayload, receivedSignature] = tokenString.split('.');
    if (!encodedPayload || !receivedSignature) {
      return null;
    }
    const signingSecret = getSigningSecret();
    if (!signingSecret) {
      return null;
    }
    const expectedSignature = crypto
      .createHmac('sha256', signingSecret)
      .update(encodedPayload)
      .digest('base64url');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const receivedBuf = Buffer.from(receivedSignature, 'utf8');
    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object') {
        return null;
      }
      if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
        return null;
      }
      if (payload.jti && revokedSessionJtis.has(payload.jti)) {
        return null;
      }
      return payload;
    } catch (_err) {
      return null;
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
      delete safeDetails.token;
      delete safeDetails.rawToken;
      delete safeDetails.tokenHash;
      delete safeDetails.password;
      delete safeDetails.secret;
      delete safeDetails.session;
      delete safeDetails.key;
      auditRecord.details = safeDetails;
    }
    if (process.env.NODE_ENV !== 'test') {
      console.info(JSON.stringify(auditRecord));
    }
    return auditRecord;
  };

  const checkRateLimit = ip => {
    const now = Date.now();
    let record = platformLoginRateLimits.get(ip);
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + PLATFORM_LOGIN_RATE_LIMIT_WINDOW_MS };
      platformLoginRateLimits.set(ip, record);
    }
    if (record.count >= PLATFORM_LOGIN_LOCK_THRESHOLD) {
      return false;
    }
    record.count++;
    return true;
  };

  const resetRateLimit = ip => {
    platformLoginRateLimits.delete(ip);
  };

  const requirePlatformAuth = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const configuredToken = getPlatformToken();
    if (!configuredToken) {
      return res.status(503).json({
        success: false,
        code: 'PLATFORM_AUTH_NOT_CONFIGURED',
        message: 'Platform administration is not configured'
      });
    }

    // 1. Check Bearer token in Authorization header
    const authHeader = req.headers && req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const candidateToken = authHeader.slice(7).trim();
      if (candidateToken && safeTimingCompare(candidateToken, configuredToken)) {
        req.platformAuth = {
          actor: 'platform_operator',
          authMethod: 'bearer'
        };
        return next();
      }
    }

    // 2. Check platform session cookie
    const cookies = parseCookies(req);
    const sessionCookie = cookies[PLATFORM_SESSION_COOKIE];
    if (sessionCookie) {
      const verified = verifySessionToken(sessionCookie);
      if (verified) {
        req.platformAuth = {
          actor: verified.actor || 'platform_operator',
          jti: verified.jti,
          authMethod: 'session'
        };
        return next();
      }
    }

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
      return res.status(403).json({
        success: false,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request rejected'
      });
    }

    const configuredToken = getPlatformToken();
    if (!configuredToken) {
      return res.status(503).json({
        success: false,
        code: 'PLATFORM_AUTH_NOT_CONFIGURED',
        message: 'Platform administration is not configured'
      });
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many failed login attempts. Please try again later.'
      });
    }

    const candidate = req.body && (req.body.token || req.body.key || req.body.password);
    if (!candidate || typeof candidate !== 'string' || !safeTimingCompare(candidate.trim(), configuredToken)) {
      auditPlatformEvent({
        actor: 'unauthenticated',
        action: 'platform_login_failed',
        result: 'failure',
        details: { ip: clientIp }
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
      exp: Date.now() + PLATFORM_SESSION_MAX_AGE_MS
    };

    const sessionToken = signSessionToken(payload);

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
      return res.status(403).json({
        success: false,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request rejected'
      });
    }

    const cookies = parseCookies(req);
    const sessionCookie = cookies[PLATFORM_SESSION_COOKIE];
    if (sessionCookie) {
      const verified = verifySessionToken(sessionCookie);
      if (verified && verified.jti) {
        revokedSessionJtis.add(verified.jti);
      }
    }

    res.setHeader(
      'Set-Cookie',
      `${PLATFORM_SESSION_COOKIE}=; ${clearPlatformCookieOptions(isProduction).join('; ')}`
    );

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
    createPlatformAuth,
    requirePlatformAuth,
    login,
    logout,
    me,
    auditPlatformEvent,
    signSessionToken,
    verifySessionToken,
    safeTimingCompare
  };
}

module.exports = {
  PLATFORM_SESSION_COOKIE,
  createPlatformAuth
};
