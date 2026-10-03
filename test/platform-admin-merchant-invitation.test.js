'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const { generateToken, hashToken } = require('../lib/invitation-token');
const {
  createMerchantInvitation,
  listMerchantInvitations,
  revokeInvitation,
  findInvitation
} = require('../lib/merchant-invitation');
const {
  createPlatformAuth,
  PLATFORM_SESSION_COOKIE,
  MIN_SECRET_LENGTH,
  sanitizeAuditDetails,
  isSensitiveKey
} = require('../lib/platform-auth');

const TEST_PLATFORM_TOKEN = 'test-platform-secret-token-32-chars-long!';
const TEST_PLATFORM_SESSION_SECRET = 'test-platform-session-secret-32-chars-diff!';

const listen = () => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

const loginPlatformAdmin = async (baseUrl, token = TEST_PLATFORM_TOKEN) => {
  const res = await fetch(`${baseUrl}/api/platform/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': baseUrl
    },
    body: JSON.stringify({ token })
  });
  const setCookie = res.headers.get('set-cookie');
  return {
    res,
    cookie: setCookie ? setCookie.split(';')[0] : null
  };
};

test('Platform Admin Authentication & Credential Strength: Enforces 32-char threshold, secret separation, and fails closed', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Unconfigured credentials -> FAIL CLOSED (503)
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    const noConfigRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(noConfigRes.status, 503);
    const noConfigBody = await noConfigRes.json();
    assert.equal(noConfigBody.code, 'PLATFORM_AUTH_NOT_CONFIGURED');

    // 2. Weak platform token (< 32 chars) -> FAIL CLOSED (503)
    app.locals.platformAdminToken = 'too-short';
    app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
    const weakTokenRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(weakTokenRes.status, 503);
    const weakTokenBody = await weakTokenRes.json();
    assert.equal(weakTokenBody.code, 'PLATFORM_AUTH_NOT_CONFIGURED');

    // 3. Weak session secret (< 32 chars) -> FAIL CLOSED (503)
    app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
    app.locals.platformSessionSecret = 'too-short-session-secret';
    const weakSecretRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(weakSecretRes.status, 503);

    // 4. Identical auth token and session secret -> FAIL CLOSED (503)
    app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
    app.locals.platformSessionSecret = TEST_PLATFORM_TOKEN;
    const identicalRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(identicalRes.status, 503);

    // Now configure valid, independent secrets (>= 32 chars)
    app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
    app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;

    // 5. Unauthenticated request to /api/platform/me fails with 401
    const unauthRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assert.equal(unauthBody.code, 'PLATFORM_AUTH_REQUIRED');

    // 6. Login with one-character candidate credential fails with 401
    const oneCharRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
      body: JSON.stringify({ token: 'a' })
    });
    assert.equal(oneCharRes.status, 401);
    const oneCharBody = await oneCharRes.json();
    assert.equal(oneCharBody.code, 'INVALID_CREDENTIALS');

    // 7. Login with 31-character candidate credential fails with 401
    const shortCandRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
      body: JSON.stringify({ token: 'a'.repeat(31) })
    });
    assert.equal(shortCandRes.status, 401);

    // 8. Login with wrong 32+ character credential fails with 401
    const wrongLongRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
      body: JSON.stringify({ token: 'wrong-platform-admin-credential-32-chars!' })
    });
    assert.equal(wrongLongRes.status, 401);

    // Reset rate limiter for the test IP so subsequent steps are not blocked
    if (app.locals.platformAuth) app.locals.platformAuth.resetRateLimit('127.0.0.1');

    // 9. Login with correct credential succeeds and sets secure cookie
    const loginRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    assert.equal(loginBody.success, true);
    assert.equal(loginBody.data.actor, 'platform_operator');

    const setCookie = loginRes.headers.get('set-cookie');
    assert.ok(setCookie, 'Must set cookie header');
    assert.match(setCookie, /gg_beauty_platform_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const sessionCookie = setCookie.split(';')[0];

    // 10. Authenticated request using cookie succeeds
    const meRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.success, true);
    assert.equal(meBody.data.actor, 'platform_operator');
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Session Revocation & Lifecycle: Immediate revocation, bootId restart invalidation, signature tampering rejection', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;

  try {
    // 1. Log in and obtain valid session
    const { cookie: sessionCookie } = await loginPlatformAdmin(baseUrl);
    assert.ok(sessionCookie);

    // Verify session works
    const meRes1 = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(meRes1.status, 200);

    // 2. Logout immediately and definitively revokes session server-side
    const logoutRes = await fetch(`${baseUrl}/api/platform/logout`, {
      method: 'POST',
      headers: {
        'Origin': baseUrl,
        'Cookie': sessionCookie
      }
    });
    assert.equal(logoutRes.status, 200);
    const logoutSetCookie = logoutRes.headers.get('set-cookie');
    assert.match(logoutSetCookie, /Max-Age=0/);

    // 3. Former session cookie is rejected server-side after logout
    const postLogoutRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(postLogoutRes.status, 401);
    const postLogoutBody = await postLogoutRes.json();
    assert.equal(postLogoutBody.code, 'PLATFORM_AUTH_REQUIRED');

    // 4. Signature tampering rejection: modify token signature
    const [cookieName, cookieVal] = sessionCookie.split('=');
    const rawToken = decodeURIComponent(cookieVal);
    const [payloadPart, sigPart] = rawToken.split('.');
    const tamperedToken = `${payloadPart}.${sigPart.slice(0, -4)}xxxx`;
    const tamperedRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': `${cookieName}=${encodeURIComponent(tamperedToken)}` }
    });
    assert.equal(tamperedRes.status, 401);

    // 5. Restart simulation: session created with a different bootId fails immediately
    const otherBootAuth = createPlatformAuth({
      getPlatformToken: () => TEST_PLATFORM_TOKEN,
      getSessionSecret: () => TEST_PLATFORM_SESSION_SECRET,
      bootId: 'old-instance-boot-id-12345678'
    });
    const preRestartToken = otherBootAuth.signSessionToken({
      actor: 'platform_operator',
      jti: 'jti-before-restart',
      bootId: 'old-instance-boot-id-12345678',
      exp: Date.now() + 3600000
    }, TEST_PLATFORM_SESSION_SECRET);

    const restartCheckRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(preRestartToken)}` }
    });
    assert.equal(restartCheckRes.status, 401);

    // 6. Expired session token is rejected
    const expiredToken = app.locals.platformAuth.signSessionToken({
      actor: 'platform_operator',
      jti: 'jti-expired',
      bootId: app.locals.platformAuth.serverBootId,
      exp: Date.now() - 1000 // expired 1s ago
    }, TEST_PLATFORM_SESSION_SECRET);

    const expiredRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Cookie': `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(expiredToken)}` }
    });
    assert.equal(expiredRes.status, 401);
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Authentication Rate Limiting & Bypass Prevention: Lockout after 5 failures and Bearer bypass eliminated', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;

  try {
    // 1. Bearer token path MUST be rejected (alternative bypass removed)
    const bearerRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: { 'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}` }
    });
    assert.equal(bearerRes.status, 401, 'Bearer header must not bypass session auth');
    const bearerBody = await bearerRes.json();
    assert.equal(bearerBody.code, 'PLATFORM_AUTH_REQUIRED');

    // 2. Throttling: 5 failed attempts allowed, 6th is locked out
    if (app.locals.platformAuth) app.locals.platformAuth.resetRateLimit('127.0.0.1');

    for (let i = 1; i <= 5; i++) {
      const failRes = await fetch(`${baseUrl}/api/platform/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
        body: JSON.stringify({ token: `invalid-attempt-number-${i}-32-chars-long` })
      });
      assert.equal(failRes.status, 401, `Attempt ${i} should be 401`);
    }

    // 6th attempt must be locked out with 429 RATE_LIMIT_EXCEEDED
    const lockedRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN }) // even with correct credentials!
    });
    assert.equal(lockedRes.status, 429);
    const lockedBody = await lockedRes.json();
    assert.equal(lockedBody.code, 'RATE_LIMIT_EXCEEDED');

    // Verify rate limit exceeded audit event was recorded
    const events = app.locals.platformAuth.getRecentAuditEvents();
    const rateLimitEvent = events.find(e => e.action === 'platform_rate_limit_exceeded');
    assert.ok(rateLimitEvent, 'Must audit platform_rate_limit_exceeded event');
    assert.equal(rateLimitEvent.result, 'failure');
  } finally {
    if (app.locals.platformAuth) app.locals.platformAuth.resetRateLimit('127.0.0.1');
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Render & Trusted Proxy Client IP Handling: Isolated rate-limit buckets and spoofed forwarding rejection', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;

  const originalTrustProxy = app.get('trust proxy');

  try {
    // 1. Enable trust proxy = 1 (matching Render's single-hop proxy architecture)
    app.set('trust proxy', 1);

    const clientIpA = '203.0.113.195';
    const clientIpB = '198.51.100.20';

    if (app.locals.platformAuth) {
      app.locals.platformAuth.resetRateLimit(clientIpA);
      app.locals.platformAuth.resetRateLimit(clientIpB);
    }

    // Client A fails 5 times
    for (let i = 1; i <= 5; i++) {
      const failRes = await fetch(`${baseUrl}/api/platform/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': baseUrl,
          'X-Forwarded-For': clientIpA
        },
        body: JSON.stringify({ token: `invalid-attempt-number-${i}-32-chars-long` })
      });
      assert.equal(failRes.status, 401);
    }

    // Client A 6th attempt is locked out (429)
    const lockedRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        'X-Forwarded-For': clientIpA
      },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(lockedRes.status, 429);

    // CRITICAL: Client B from a different IP must NOT share Client A's lockout bucket!
    const clientBRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        'X-Forwarded-For': clientIpB
      },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(clientBRes.status, 200, 'Client B must have separate rate-limit bucket and succeed');

    // 2. Attacker on locked clientIpA tries to spoof by prepending another IP
    // With trust proxy = 1, Express trusts only 1 hop from socket, so clientIpA remains resolved IP
    const spoofAttempt = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        'X-Forwarded-For': `8.8.8.8, ${clientIpA}`
      },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(spoofAttempt.status, 429, 'Spoofed header must not change identity of locked client');

    // 3. Untrusted context: when trust proxy is disabled, X-Forwarded-For is completely ignored
    app.set('trust proxy', false);
    if (app.locals.platformAuth) app.locals.platformAuth.resetRateLimit('127.0.0.1');

    const untrustedRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        'X-Forwarded-For': '1.2.3.4'
      },
      body: JSON.stringify({ token: 'wrong-token-32-chars-long-padding' })
    });
    assert.equal(untrustedRes.status, 401);

    // Verify rate limit was charged to direct socket IP (127.0.0.1), NOT 1.2.3.4
    const events = app.locals.platformAuth.getRecentAuditEvents();
    const loginFailEvent = events.find(e => e.action === 'platform_login_failed' && e.details && e.details.ip === '127.0.0.1');
    assert.ok(loginFailEvent, 'Must resolve to direct socket IP when trust proxy is false');
    assert.ok(!events.some(e => e.details && e.details.ip === '1.2.3.4'), 'Must not trust 1.2.3.4 from untrusted header');
  } finally {
    app.set('trust proxy', originalTrustProxy);
    if (app.locals.platformAuth) app.locals.platformAuth.resetRateLimit();
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    await new Promise(resolve => server.close(resolve));
  }
});

test('DOM & Browser State Security: One-time onboarding URL is wiped from DOM on logout and navigation', () => {
  const clientModule = require('../public/platform-invitations');

  // Set up mock DOM elements
  const mockElements = {
    'created-url-banner': { hidden: false },
    'created-url-input': {
      value: 'https://portal.gg-beauty.com/onboarding.html?token=secret123456',
      removeAttribute: function(_attr) { /* attribute removed */ }
    },
    'copy-message': { textContent: 'Onboarding link copied' },
    'login-view': { hidden: true },
    'main-view': { hidden: false },
    'logout-btn': { hidden: false }
  };

  const originalDocument = global.document;
  global.document = {
    getElementById: id => mockElements[id] || null,
    querySelectorAll: () => []
  };

  try {
    // Verify initial mock state has sensitive URL
    assert.equal(mockElements['created-url-input'].value, 'https://portal.gg-beauty.com/onboarding.html?token=secret123456');
    assert.equal(mockElements['created-url-banner'].hidden, false);

    // Call clearCreatedUrl
    assert.equal(typeof clientModule.clearCreatedUrl, 'function');
    clientModule.clearCreatedUrl();

    // Verify the URL and messages are completely wiped, and banner hidden
    assert.equal(mockElements['created-url-input'].value, '', 'Input value must be empty string');
    assert.equal(mockElements['copy-message'].textContent, '', 'Copy message must be cleared');
    assert.equal(mockElements['created-url-banner'].hidden, true, 'Banner must be hidden');
  } finally {
    global.document = originalDocument;
  }
});

test('Adversarial Recursive Audit Sanitization: Secrets hidden in nested objects, arrays, and case-insensitive keys are purged', () => {
  const auth = createPlatformAuth({
    getPlatformToken: () => TEST_PLATFORM_TOKEN,
    getSessionSecret: () => TEST_PLATFORM_SESSION_SECRET
  });

  const rawToken = generateToken();
  const rawOnboardingUrl = `https://portal.gg-beauty.com/onboarding.html?token=${rawToken}`;
  const rawDbUrl = 'postgres://admin:super_secret_pw@db.render.com:5432/production';

  // Adversarial structure with secrets hidden under varied key formats and nesting
  const adversarialInput = {
    PLATFORM_ADMIN_TOKEN: 'super-secret-admin-token-value',
    PLATFORM_SESSION_SECRET: 'super-secret-session-key-value',
    api_key: 'top-secret-api-key',
    APIKEY: 'all-caps-api-key',
    generic_cookie: 'gg_beauty_platform_session=token-value',
    SESSION_TOKEN: 'session-token-1234',
    admin_password: 'super-sensitive-password',
    userPasswd: 'another-password',
    DATABASE_URL: rawDbUrl,
    Database_Url: rawDbUrl,
    custom_secret_key: 'custom-secret-key-data',
    user_credentials: {
      auth_token: 'nested-auth-token',
      apiKey: 'nested-api-key',
      authKey: 'nested-auth-key',
      privateKey: 'nested-private-key'
    },
    nested_data: {
      level1: {
        level2: {
          secret_data: 'deep-secret',
          safe_field: 'safe_nested_value'
        }
      }
    },
    list_of_items: [
      { token: 'item-token', label: 'item-1' },
      rawOnboardingUrl,
      rawDbUrl,
      'Bearer attacker-stolen-token-1234567890',
      'safe_string_item',
      null,
      12345
    ],
    unexpected_link: rawOnboardingUrl,
    unexpected_field_with_db: rawDbUrl,
    safe_merchant_hint: 'Lotus Bloom Spa',
    safe_count: 42
  };

  const record = auth.auditPlatformEvent({
    actor: 'platform_operator',
    action: 'create_merchant_invitation',
    invitationId: 'inv-uuid-adversarial',
    result: 'success',
    details: adversarialInput
  });

  const detailsJson = JSON.stringify(record.details);

  // Assert NO secrets or sensitive tokens survive anywhere in detailsJson
  assert.ok(!detailsJson.includes('super-secret-admin-token-value'), 'PLATFORM_ADMIN_TOKEN must not survive');
  assert.ok(!detailsJson.includes('super-secret-session-key-value'), 'PLATFORM_SESSION_SECRET must not survive');
  assert.ok(!detailsJson.includes('top-secret-api-key'), 'api_key must not survive');
  assert.ok(!detailsJson.includes('all-caps-api-key'), 'APIKEY must not survive');
  assert.ok(!detailsJson.includes('session-token-1234'), 'SESSION_TOKEN must not survive');
  assert.ok(!detailsJson.includes('super-sensitive-password'), 'password must not survive');
  assert.ok(!detailsJson.includes('another-password'), 'passwd must not survive');
  assert.ok(!detailsJson.includes('deep-secret'), 'nested secret must not survive');
  assert.ok(!detailsJson.includes('nested-auth-token'), 'nested token must not survive');
  assert.ok(!detailsJson.includes('nested-api-key'), 'nested apiKey must not survive');
  assert.ok(!detailsJson.includes('nested-auth-key'), 'nested authKey must not survive');
  assert.ok(!detailsJson.includes('nested-private-key'), 'nested privateKey must not survive');
  assert.ok(!detailsJson.includes('super_secret_pw'), 'database password must not survive');
  assert.ok(!detailsJson.includes('attacker-stolen-token-1234567890'), 'bearer token must not survive');
  assert.ok(!detailsJson.includes('?token='), 'onboarding token url must not survive');
  assert.ok(!detailsJson.includes(rawToken), 'raw token must not survive');

  // Assert keys were removed
  assert.equal(record.details.PLATFORM_ADMIN_TOKEN, undefined);
  assert.equal(record.details.PLATFORM_SESSION_SECRET, undefined);
  assert.equal(record.details.api_key, undefined);
  assert.equal(record.details.APIKEY, undefined);
  assert.equal(record.details.generic_cookie, undefined);
  assert.equal(record.details.SESSION_TOKEN, undefined);
  assert.equal(record.details.DATABASE_URL, undefined);
  assert.equal(record.details.user_credentials, undefined);

  // Assert nested safe fields remain
  assert.equal(record.details.nested_data.level1.level2.safe_field, 'safe_nested_value');
  assert.equal(record.details.safe_merchant_hint, 'Lotus Bloom Spa');
  assert.equal(record.details.safe_count, 42);

  // Assert arrays sanitized properly
  assert.equal(record.details.list_of_items[0].token, undefined);
  assert.equal(record.details.list_of_items[0].label, 'item-1');
  assert.equal(record.details.list_of_items[1], '[REDACTED]'); // onboarding url
  assert.equal(record.details.list_of_items[2], '[REDACTED]'); // db url
  assert.equal(record.details.list_of_items[3], '[REDACTED]'); // bearer string
  assert.equal(record.details.list_of_items[4], 'safe_string_item');
  assert.equal(record.details.list_of_items[5], null);
  assert.equal(record.details.list_of_items[6], 12345);

  // Assert unexpected fields with sensitive URLs are redacted
  assert.equal(record.details.unexpected_link, '[REDACTED]');
  assert.equal(record.details.unexpected_field_with_db, '[REDACTED]');

  // Assert input object was NOT mutated
  assert.equal(adversarialInput.PLATFORM_ADMIN_TOKEN, 'super-secret-admin-token-value');
  assert.equal(adversarialInput.api_key, 'top-secret-api-key');

  // Assert circular reference safety
  const circularObj = { safe: 'yes' };
  circularObj.cycle = circularObj;
  const circularRecord = auth.auditPlatformEvent({
    actor: 'platform_operator',
    action: 'circular_test',
    result: 'success',
    details: circularObj
  });
  assert.equal(circularRecord.details.safe, 'yes');
  assert.equal(circularRecord.details.cycle, '[CIRCULAR]');
});

test('Audit Logging for Validation & Configuration Failure Paths: Malformed UUID revoke and invalid auth config', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
  app.locals.publicBaseUrl = baseUrl;

  try {
    const { cookie: sessionCookie } = await loginPlatformAdmin(baseUrl);
    assert.ok(sessionCookie);

    if (app.locals.platformAuth) app.locals.platformAuth.clearRecentAuditEvents();

    // 1. Malformed invitation UUID in revoke request -> HTTP 400 + audit failure
    const malformedRevokeRes = await fetch(`${baseUrl}/api/platform/invitations/not-a-valid-uuid/revoke`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Origin': baseUrl
      }
    });
    assert.equal(malformedRevokeRes.status, 400);
    const malformedBody = await malformedRevokeRes.json();
    assert.equal(malformedBody.code, 'INVALID_INVITATION_ID');

    const eventsAfterRevoke = app.locals.platformAuth.getRecentAuditEvents();
    const revokeFailEvent = eventsAfterRevoke.find(e => e.action === 'revoke_merchant_invitation_failed');
    assert.ok(revokeFailEvent, 'Must audit revoke_merchant_invitation_failed for malformed UUID');
    assert.equal(revokeFailEvent.result, 'failure');
    assert.equal(revokeFailEvent.details.reason, 'invalid_invitation_id_format');

    // 2. Unconfigured / invalid Platform Admin configuration during login -> HTTP 503 + audit failure
    app.locals.platformAdminToken = 'too-short';
    const unconfigLoginRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl
      },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(unconfigLoginRes.status, 503);
    const unconfigBody = await unconfigLoginRes.json();
    assert.equal(unconfigBody.code, 'PLATFORM_AUTH_NOT_CONFIGURED');

    const eventsAfterLogin = app.locals.platformAuth.getRecentAuditEvents();
    const loginConfigFailEvent = eventsAfterLogin.find(
      e => e.action === 'platform_login_failed' && e.actor === 'system'
    );
    assert.ok(loginConfigFailEvent, 'Must audit platform_login_failed with actor system on invalid config');
    assert.equal(loginConfigFailEvent.result, 'failure');
    assert.equal(loginConfigFailEvent.details.reason, 'SECRETS_INSUFFICIENT_LENGTH');
    assert.equal(loginConfigFailEvent.details.path, '/api/platform/login');

    // Security assertion: no secret value leaked in audit details
    assert.equal(JSON.stringify(loginConfigFailEvent).includes('too-short'), false);
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    delete app.locals.publicBaseUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Structured Security Audit Logging: All required events emitted without leaking secrets, tokens, or hashes', () => {
  const auth = createPlatformAuth({
    getPlatformToken: () => TEST_PLATFORM_TOKEN,
    getSessionSecret: () => TEST_PLATFORM_SESSION_SECRET
  });

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  // Test event sanitization
  const record = auth.auditPlatformEvent({
    actor: 'platform_operator',
    action: 'create_merchant_invitation',
    invitationId: 'uuid-1234',
    result: 'success',
    details: {
      rawToken,
      token: rawToken,
      tokenHash,
      token_hash: tokenHash,
      password: 'super-sensitive-password',
      secret: 'platform-secret',
      sessionCookie: 'session=xyz',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      onboardingUrl: `https://example.com/onboarding.html?token=${rawToken}`,
      merchantNameHint: 'Clean Spa'
    }
  });

  // Verify structure
  assert.equal(record.auditType, 'PLATFORM_SECURITY_AUDIT');
  assert.equal(record.actor, 'platform_operator');
  assert.equal(record.action, 'create_merchant_invitation');
  assert.equal(record.invitationId, 'uuid-1234');
  assert.equal(record.result, 'success');
  assert.ok(record.timestamp);

  // Security assertions: Sensitive fields MUST have been stripped
  assert.equal(record.details.rawToken, undefined);
  assert.equal(record.details.token, undefined);
  assert.equal(record.details.tokenHash, undefined);
  assert.equal(record.details.token_hash, undefined);
  assert.equal(record.details.password, undefined);
  assert.equal(record.details.secret, undefined);
  assert.equal(record.details.sessionCookie, undefined);
  assert.equal(record.details.DATABASE_URL, undefined);
  assert.equal(record.details.onboardingUrl, undefined);

  // Safe non-secret fields remain
  assert.equal(record.details.merchantNameHint, 'Clean Spa');

  // Verify all required event actions can be safely emitted
  const requiredEventActions = [
    { action: 'platform_login_success', actor: 'platform_operator' },
    { action: 'platform_login_failed', actor: 'unauthenticated' },
    { action: 'platform_rate_limit_exceeded', actor: 'unauthenticated' },
    { action: 'platform_logout', actor: 'platform_operator' },
    { action: 'platform_session_revoked', actor: 'platform_operator' },
    { action: 'platform_session_expired', actor: 'unauthenticated' },
    { action: 'platform_session_invalid', actor: 'unauthorized' },
    { action: 'platform_unauthorized_attempt', actor: 'unauthorized' },
    { action: 'platform_csrf_rejected', actor: 'unauthenticated' },
    { action: 'create_merchant_invitation', actor: 'platform_operator' },
    { action: 'create_merchant_invitation_failed', actor: 'platform_operator' },
    { action: 'revoke_merchant_invitation', actor: 'platform_operator' },
    { action: 'revoke_merchant_invitation_failed', actor: 'platform_operator' }
  ];

  for (const { action, actor } of requiredEventActions) {
    const entry = auth.auditPlatformEvent({ action, actor, result: 'success' });
    assert.equal(entry.action, action);
    assert.equal(entry.actor, actor);
    assert.equal(entry.auditType, 'PLATFORM_SECURITY_AUDIT');
  }
});

test('Tenant & Role Authorization Security: Merchant users and unauthenticated callers are strictly denied', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
  app.locals.publicBaseUrl = baseUrl;

  try {
    const endpoints = [
      { method: 'GET', url: `${baseUrl}/api/platform/invitations` },
      { method: 'POST', url: `${baseUrl}/api/platform/invitations`, body: { ttlDays: 7 } },
      { method: 'POST', url: `${baseUrl}/api/platform/invitations/11111111-1111-1111-1111-111111111111/revoke` }
    ];

    // Explicitly verify denial for each forbidden actor:
    const forbiddenIdentities = [
      { name: 'unauthenticated', headers: {} },
      { name: 'merchant owner', headers: { 'Cookie': 'gg_beauty_owner_session=test-owner-token' } },
      { name: 'merchant manager', headers: { 'Cookie': 'gg_beauty_owner_session=test-manager-token' } },
      { name: 'merchant admin', headers: { 'Cookie': 'gg_beauty_owner_session=test-admin-token' } },
      { name: 'merchant front desk', headers: { 'Cookie': 'gg_beauty_owner_session=test-front-desk-token' } },
      { name: 'merchant staff', headers: { 'Cookie': 'gg_beauty_staff_session=test-staff-token' } },
      { name: 'customer', headers: { 'Cookie': 'gg_customer_session=test-customer-token' } },
      { name: 'forged platform bearer', headers: { 'Authorization': 'Bearer attacker-fake-token' } },
      { name: 'forged platform session', headers: { 'Cookie': 'gg_beauty_platform_session=invalid.token' } }
    ];

    for (const identity of forbiddenIdentities) {
      for (const endpoint of endpoints) {
        const fetchOpts = {
          method: endpoint.method,
          headers: {
            'Content-Type': 'application/json',
            'Origin': baseUrl,
            ...identity.headers
          }
        };
        if (endpoint.body) fetchOpts.body = JSON.stringify(endpoint.body);

        const res = await fetch(endpoint.url, fetchOpts);
        assert.ok(
          res.status === 401 || res.status === 403,
          `Expected 401 or 403 for ${identity.name} on ${endpoint.method} ${endpoint.url}, got ${res.status}`
        );
        const body = await res.json();
        assert.equal(body.success, false);
      }
    }
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    delete app.locals.publicBaseUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Platform Admin Invitation Creation: Token hash storage, trusted PUBLIC_BASE_URL, and no Shop/Owner provisioning', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const trustedPublicBase = 'https://portal.gg-beauty.com';

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
  app.locals.publicBaseUrl = trustedPublicBase;

  const executedQueries = [];
  const mockDb = {
    query: async (sql, params) => {
      executedQueries.push({ sql, params });
      return {
        rows: [{
          id: '22222222-2222-2222-2222-222222222222',
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 86400000),
          created_at: new Date()
        }]
      };
    }
  };
  app.locals.platformPool = mockDb;

  try {
    const { cookie: sessionCookie } = await loginPlatformAdmin(baseUrl);
    assert.ok(sessionCookie);

    // 1. CSRF rejection on cross-origin mutation
    const csrfRes = await fetch(`${baseUrl}/api/platform/invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'Origin': 'https://evil-attacker.com'
      },
      body: JSON.stringify({ merchantNameHint: 'Spa Bloom', ttlDays: 7 })
    });
    assert.equal(csrfRes.status, 403);
    const csrfBody = await csrfRes.json();
    assert.equal(csrfBody.code, 'ORIGIN_NOT_ALLOWED');

    // 2. Successful invitation creation by authorized Platform Admin
    const createRes = await fetch(`${baseUrl}/api/platform/invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'Origin': baseUrl,
        'Host': 'attacker-host-header.com' // Attacker attempts Host header injection
      },
      body: JSON.stringify({
        merchantNameHint: 'Spa Bloom',
        contactEmail: 'owner@bloom.com',
        contactPhone: '+65 9111 2222',
        ttlDays: 14
      })
    });

    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.success, true);
    const data = createBody.data;

    // Check returned data
    assert.equal(data.invitationId, '22222222-2222-2222-2222-222222222222');
    assert.equal(data.status, 'pending');
    assert.equal(data.merchantNameHint, 'Spa Bloom');
    assert.equal(data.contactEmail, 'owner@bloom.com');
    assert.equal(data.contactPhone, '+65 9111 2222');
    assert.equal(data.createdBy, 'platform_operator');

    // Security assertion: tokenHash must NOT be in the API response
    assert.equal(data.tokenHash, undefined, 'tokenHash must not be exposed in API response');
    assert.equal(data.rawToken, undefined, 'rawToken property must not be exposed directly in API response');

    // Onboarding URL must use the trusted server-configured public base URL
    assert.ok(data.onboardingUrl.startsWith(trustedPublicBase), 'Must use trusted PUBLIC_BASE_URL');
    assert.ok(!data.onboardingUrl.includes('attacker-host-header.com'), 'Must NOT reflect client Host header');
    assert.match(data.onboardingUrl, /\/onboarding\.html\?token=[0-9a-f]{64}$/);

    // Database assertions:
    assert.equal(executedQueries.length, 1, 'Only one insert query must be executed');
    const { sql, params } = executedQueries[0];
    assert.match(sql, /INSERT INTO public\.merchant_onboarding_invitations/);
    assert.match(params[0], /^[0-9a-f]{64}$/, 'First parameter must be SHA-256 token hash');

    // Extract the raw token from the onboardingUrl
    const urlToken = new URL(data.onboardingUrl).searchParams.get('token');
    assert.ok(urlToken && urlToken.length === 64);
    assert.equal(hashToken(urlToken), params[0], 'Hash in DB must match hash of raw token');

    // Critical assertion: raw token must NOT be in SQL or DB parameters
    assert.doesNotMatch(sql, new RegExp(urlToken));
    for (const p of params) {
      if (typeof p === 'string') {
        assert.ok(!p.includes(urlToken), 'Raw token must not appear in any DB parameter');
      }
    }

    // STRICT PROVISIONING SEPARATION:
    // Creation must NOT touch shops, locations, owner_accounts, staff, etc.
    const touchedTables = executedQueries.map(q => q.sql.toLowerCase());
    assert.ok(!touchedTables.some(t => t.includes('shops') && !t.includes('merchant_onboarding_invitations')));
    assert.ok(!touchedTables.some(t => t.includes('locations')));
    assert.ok(!touchedTables.some(t => t.includes('owner_accounts')));
    assert.ok(!touchedTables.some(t => t.includes('staff')));
    assert.ok(!touchedTables.some(t => t.includes('appointments')));
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    delete app.locals.publicBaseUrl;
    delete app.locals.platformPool;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Platform Admin Invitation Listing: Safe metadata only, never exposes token/hash, handles effective expired status', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
  app.locals.publicBaseUrl = baseUrl;

  const pastDate = new Date(Date.now() - 3600000);
  const futureDate = new Date(Date.now() + 86400000);

  const mockDb = {
    query: async (sql) => {
      // Must not query token_hash
      assert.ok(!sql.toLowerCase().includes('token_hash'), 'list query must NEVER select token_hash');

      return {
        rows: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            status: 'pending',
            expires_at: futureDate,
            consumed_at: null,
            revoked_at: null,
            merchant_name_hint: 'Active Shop',
            contact_email: 'active@shop.com',
            contact_phone: '+65 9111 1111',
            created_by: 'platform_operator',
            created_at: new Date(),
            updated_at: new Date()
          },
          {
            id: '22222222-2222-2222-2222-222222222222',
            status: 'pending', // Pending in DB, but expires_at is past -> must compute 'expired'
            expires_at: pastDate,
            consumed_at: null,
            revoked_at: null,
            merchant_name_hint: 'Expired Shop',
            contact_email: 'expired@shop.com',
            contact_phone: null,
            created_by: 'platform_cli',
            created_at: pastDate,
            updated_at: pastDate
          },
          {
            id: '33333333-3333-3333-3333-333333333333',
            status: 'consumed',
            expires_at: futureDate,
            consumed_at: new Date(),
            revoked_at: null,
            merchant_name_hint: 'Consumed Shop',
            contact_email: null,
            contact_phone: null,
            created_by: 'platform_operator',
            created_at: new Date(),
            updated_at: new Date()
          },
          {
            id: '44444444-4444-4444-4444-444444444444',
            status: 'revoked',
            expires_at: futureDate,
            consumed_at: null,
            revoked_at: new Date(),
            merchant_name_hint: 'Revoked Shop',
            contact_email: null,
            contact_phone: null,
            created_by: 'platform_operator',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      };
    }
  };
  app.locals.platformPool = mockDb;

  try {
    const { cookie: sessionCookie } = await loginPlatformAdmin(baseUrl);
    assert.ok(sessionCookie);

    const res = await fetch(`${baseUrl}/api/platform/invitations`, {
      headers: {
        'Cookie': sessionCookie
      }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 4);

    const [active, expired, consumed, revoked] = body.data;

    // Active
    assert.equal(active.status, 'pending');
    assert.equal(active.id, '11111111-1111-1111-1111-111111111111');

    // Expired calculation
    assert.equal(expired.status, 'expired', 'Dynamic status must be expired when expires_at <= NOW');

    // Consumed
    assert.equal(consumed.status, 'consumed');
    assert.ok(consumed.consumedAt);

    // Revoked
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revokedAt);

    // SECURITY: Ensure NO secret fields exist in any item
    for (const item of body.data) {
      assert.equal(item.tokenHash, undefined, 'tokenHash must not be exposed');
      assert.equal(item.token_hash, undefined, 'token_hash must not be exposed');
      assert.equal(item.rawToken, undefined, 'rawToken must not be in list output');
      assert.equal(item.onboardingUrl, undefined, 'onboardingUrl must not be in list output');
    }
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    delete app.locals.publicBaseUrl;
    delete app.locals.platformPool;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Platform Admin Invitation Revocation: Pending invitation can be revoked, consumed/expired cannot be reused', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.platformSessionSecret = TEST_PLATFORM_SESSION_SECRET;
  app.locals.publicBaseUrl = baseUrl;

  // Track invitation statuses in memory mock
  const invitationsStore = new Map([
    ['11111111-1111-1111-1111-111111111111', { id: '11111111-1111-1111-1111-111111111111', status: 'pending' }],
    ['22222222-2222-2222-2222-222222222222', { id: '22222222-2222-2222-2222-222222222222', status: 'consumed' }],
    ['33333333-3333-3333-3333-333333333333', { id: '33333333-3333-3333-3333-333333333333', status: 'revoked' }]
  ]);

  const mockDb = {
    query: async (sql, params) => {
      if (/UPDATE public\.merchant_onboarding_invitations/i.test(sql)) {
        const id = params[0];
        const record = invitationsStore.get(id);
        if (record && record.status === 'pending') {
          record.status = 'revoked';
          return { rowCount: 1, rows: [{ id }] };
        }
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
  app.locals.platformPool = mockDb;

  try {
    const { cookie: sessionCookie } = await loginPlatformAdmin(baseUrl);
    assert.ok(sessionCookie);

    // 1. Revoking a pending invitation succeeds
    const revokeRes = await fetch(`${baseUrl}/api/platform/invitations/11111111-1111-1111-1111-111111111111/revoke`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Origin': baseUrl
      }
    });
    assert.equal(revokeRes.status, 200);
    const revokeBody = await revokeRes.json();
    assert.equal(revokeBody.success, true);
    assert.equal(revokeBody.data.status, 'revoked');
    assert.equal(invitationsStore.get('11111111-1111-1111-1111-111111111111').status, 'revoked');

    // 2. Revoking an already revoked invitation fails with 409
    const doubleRevokeRes = await fetch(`${baseUrl}/api/platform/invitations/11111111-1111-1111-1111-111111111111/revoke`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Origin': baseUrl
      }
    });
    assert.equal(doubleRevokeRes.status, 409);
    const doubleRevokeBody = await doubleRevokeRes.json();
    assert.equal(doubleRevokeBody.code, 'INVITATION_NOT_REVOCABLE');

    // 3. Revoking an already consumed invitation fails with 409
    const consumedRevokeRes = await fetch(`${baseUrl}/api/platform/invitations/22222222-2222-2222-2222-222222222222/revoke`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Origin': baseUrl
      }
    });
    assert.equal(consumedRevokeRes.status, 409);
    const consumedRevokeBody = await consumedRevokeRes.json();
    assert.equal(consumedRevokeBody.code, 'INVITATION_NOT_REVOCABLE');

    // 4. Invalid UUID format returns 400
    const invalidIdRes = await fetch(`${baseUrl}/api/platform/invitations/not-a-uuid/revoke`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Origin': baseUrl
      }
    });
    assert.equal(invalidIdRes.status, 400);
    const invalidIdBody = await invalidIdRes.json();
    assert.equal(invalidIdBody.code, 'INVALID_INVITATION_ID');
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.platformSessionSecret;
    delete app.locals.publicBaseUrl;
    delete app.locals.platformPool;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Platform Admin UI & i18n Verification: 44px touch targets, required action names, full zh-CN/en coverage', () => {
  const rootDir = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(rootDir, 'public/platform-invitations.html'), 'utf8');
  const i18n = require('../public/shared-i18n');

  // 1. Minimum touch target requirement (44px)
  assert.match(html, /button,\s*input,\s*select\s*\{\s*min-height:\s*44px;\s*\}/, 'CSS must enforce 44px min-height for buttons/inputs');
  assert.match(html, /btn-primary[\s\S]*?min-height:\s*44px/, 'Primary buttons must have min 44px touch target');
  assert.match(html, /btn-secondary[\s\S]*?min-height:\s*44px/, 'Secondary buttons must have min 44px touch target');
  assert.match(html, /btn-danger[\s\S]*?min-height:\s*44px/, 'Danger buttons must have min 44px touch target');

  // 2. Required actions: Create Invitation and Copy Link
  assert.equal(i18n.t('platformInviteNew', 'zh-CN'), '邀请新商家', 'Chinese invite button must be 邀请新商家');
  assert.equal(i18n.t('platformInviteNew', 'en'), 'Invite New Merchant', 'English invite button must be Invite New Merchant');
  assert.equal(i18n.t('platformCopyLink', 'zh-CN'), '复制链接', 'Chinese copy button must be 复制链接');
  assert.equal(i18n.t('platformCopyLink', 'en'), 'Copy Link', 'English copy button must be Copy Link');

  // 3. Form input fields
  assert.match(html, /name="merchantNameHint"/, 'Must include merchantNameHint field');
  assert.match(html, /name="contactEmail"/, 'Must include contactEmail field');
  assert.match(html, /name="contactPhone"/, 'Must include contactPhone field');
  assert.match(html, /name="ttlDays"/, 'Must include ttlDays field');

  // 4. Filter tabs
  assert.match(html, /data-filter="all"/, 'Must include All filter tab');
  assert.match(html, /data-filter="pending"/, 'Must include Pending filter tab');
  assert.match(html, /data-filter="consumed"/, 'Must include Consumed filter tab');
  assert.match(html, /data-filter="expired"/, 'Must include Expired filter tab');
  assert.match(html, /data-filter="revoked"/, 'Must include Revoked filter tab');

  // 5. Script linkage
  assert.match(html, /src="\/shared-i18n\.js"/, 'Must include shared-i18n.js');
  assert.match(html, /src="\/platform-invitations\.js"/, 'Must include platform-invitations.js');

  // 6. Complete i18n coverage without missing keys
  const requiredI18nKeys = [
    'platformPageTitle',
    'platformTitle',
    'platformSubtitle',
    'platformInviteNew',
    'platformMerchantNameHint',
    'platformContactEmail',
    'platformContactPhone',
    'platformTtlDays',
    'platformCreateSubmit',
    'platformCreating',
    'platformCreatedSuccess',
    'platformCreatedHelp',
    'platformCopyLink',
    'platformLinkCopied',
    'platformStatusPending',
    'platformStatusConsumed',
    'platformStatusExpired',
    'platformStatusRevoked',
    'platformFilterAll',
    'platformFilterPending',
    'platformFilterConsumed',
    'platformFilterExpired',
    'platformFilterRevoked',
    'platformCreatedAt',
    'platformExpiresAt',
    'platformConsumedAt',
    'platformRevokedAt',
    'platformRevoke',
    'platformConfirmRevoke',
    'platformNoInvitations',
    'platformLoadingInvitations',
    'platformLoginTitle',
    'platformLoginHelp',
    'platformLoginSecret',
    'platformLoginSubmit',
    'platformLoginFailed',
    'platformLogout'
  ];

  for (const key of requiredI18nKeys) {
    const zhVal = i18n.t(key, 'zh-CN');
    const enVal = i18n.t(key, 'en');
    assert.ok(zhVal && zhVal !== key, `Missing zh-CN translation for ${key}`);
    assert.ok(enVal && enVal !== key, `Missing en translation for ${key}`);
    assert.match(zhVal, /[\u4e00-\u9fa5]/, `zh-CN translation for ${key} must contain Chinese characters: "${zhVal}"`);
    assert.doesNotMatch(enVal, /[\u4e00-\u9fa5]/, `en translation for ${key} must not contain Chinese characters: "${enVal}"`);
  }
});

test('Merchant Onboarding Compatibility: Created invitation is consumable through existing onboarding flow', async () => {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  let invitationStatus = 'pending';
  let resultingShopId = null;
  let consumedAt = null;

  const mockDb = {
    query: async (sql) => {
      if (/FROM public\.merchant_onboarding_invitations/i.test(sql)) {
        return {
          rows: [{
            id: 'mock-invitation-uuid',
            token_hash: tokenHash,
            status: invitationStatus,
            expires_at: new Date(Date.now() + 7 * 86400000),
            consumed_at: consumedAt,
            revoked_at: null,
            resulting_shop_id: resultingShopId,
            merchant_name_hint: 'Compatible Spa',
            contact_email: 'owner@compatiblespa.com',
            contact_phone: '+65 9876 5432',
            created_by: 'platform_operator'
          }]
        };
      }
      return { rows: [] };
    }
  };

  // Find invitation with raw token
  const invitation = await findInvitation(mockDb, rawToken);
  assert.ok(invitation, 'Invitation must be found by raw token');
  assert.equal(invitation.status, 'pending');
  assert.equal(invitation.isValid, true);
  assert.equal(invitation.merchantNameHint, 'Compatible Spa');

  // Verify revocation stops consumption
  invitationStatus = 'revoked';
  const revokedInvitation = await findInvitation(mockDb, rawToken);
  assert.equal(revokedInvitation.status, 'revoked');
  assert.equal(revokedInvitation.isValid, false);
});
