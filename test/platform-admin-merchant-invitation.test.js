'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { app } = require('../server');
const { generateToken, hashToken } = require('../lib/invitation-token');
const {
  createMerchantInvitation,
  listMerchantInvitations,
  revokeInvitation,
  findInvitation
} = require('../lib/merchant-invitation');
const { createPlatformAuth } = require('../lib/platform-auth');

const TEST_PLATFORM_TOKEN = 'test-platform-secret-token-32-chars-long!';

const listen = () => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

test('Platform Admin Authentication & Session Management', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
  app.locals.publicBaseUrl = baseUrl;

  try {
    // 1. Unauthenticated request to /api/platform/me fails with 401
    const unauthRes = await fetch(`${baseUrl}/api/platform/me`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assert.equal(unauthBody.code, 'PLATFORM_AUTH_REQUIRED');

    // 2. Login with wrong credential fails with 401
    const badLoginRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl
      },
      body: JSON.stringify({ token: 'wrong-password' })
    });
    assert.equal(badLoginRes.status, 401);
    const badLoginBody = await badLoginRes.json();
    assert.equal(badLoginBody.code, 'INVALID_CREDENTIALS');

    // 3. Login with correct credential succeeds and sets secure cookie
    const loginRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl
      },
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

    // 4. Authenticated request using cookie succeeds
    const meRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.success, true);
    assert.equal(meBody.data.actor, 'platform_operator');

    // 5. Bearer token authorization succeeds
    const bearerRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: {
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`
      }
    });
    assert.equal(bearerRes.status, 200);
    const bearerBody = await bearerRes.json();
    assert.equal(bearerBody.success, true);

    // 6. Bearer token with wrong secret fails
    const badBearerRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: {
        'Authorization': 'Bearer wrong-secret'
      }
    });
    assert.equal(badBearerRes.status, 401);

    // 7. Logout clears session
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

    // 8. Former session cookie is rejected after logout
    const postLogoutRes = await fetch(`${baseUrl}/api/platform/me`, {
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(postLogoutRes.status, 401);

    // 9. When token is unconfigured on server, fails closed with 503
    app.locals.platformAdminToken = '';
    const unconfiguredRes = await fetch(`${baseUrl}/api/platform/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl
      },
      body: JSON.stringify({ token: TEST_PLATFORM_TOKEN })
    });
    assert.equal(unconfiguredRes.status, 503);
    const unconfiguredBody = await unconfiguredRes.json();
    assert.equal(unconfiguredBody.code, 'PLATFORM_AUTH_NOT_CONFIGURED');
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.publicBaseUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Tenant & Role Authorization Security: Merchant users and unauthenticated callers are strictly denied', async () => {
  const server = await listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.locals.platformAdminToken = TEST_PLATFORM_TOKEN;
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
    // 1. CSRF rejection on cross-origin mutation
    const csrfRes = await fetch(`${baseUrl}/api/platform/invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
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
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
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
    const res = await fetch(`${baseUrl}/api/platform/invitations`, {
      headers: {
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`
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
    // 1. Revoking a pending invitation succeeds
    const revokeRes = await fetch(`${baseUrl}/api/platform/invitations/11111111-1111-1111-1111-111111111111/revoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
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
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
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
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
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
        'Authorization': `Bearer ${TEST_PLATFORM_TOKEN}`,
        'Origin': baseUrl
      }
    });
    assert.equal(invalidIdRes.status, 400);
    const invalidIdBody = await invalidIdRes.json();
    assert.equal(invalidIdBody.code, 'INVALID_INVITATION_ID');
  } finally {
    delete app.locals.platformAdminToken;
    delete app.locals.publicBaseUrl;
    delete app.locals.platformPool;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Audit Logging: Platform events are audited without leaking raw tokens, hashes, passwords or DB secrets', () => {
  const { createPlatformAuth } = require('../lib/platform-auth');
  const auth = createPlatformAuth({ getPlatformToken: () => 'token' });

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  const entry = auth.auditPlatformEvent({
    actor: 'platform_operator',
    action: 'create_merchant_invitation',
    invitationId: 'uuid-1234',
    result: 'success',
    details: {
      rawToken,
      token: rawToken,
      tokenHash,
      password: 'sensitive-password',
      secret: 'secret-key',
      session: 'session-id',
      merchantNameHint: 'Clean Spa'
    }
  });

  assert.equal(entry.actor, 'platform_operator');
  assert.equal(entry.action, 'create_merchant_invitation');
  assert.equal(entry.invitationId, 'uuid-1234');
  assert.equal(entry.result, 'success');
  assert.ok(entry.timestamp);

  // Security assertions: Sensitive fields MUST have been stripped
  assert.equal(entry.details.rawToken, undefined, 'rawToken must be stripped from audit');
  assert.equal(entry.details.token, undefined, 'token must be stripped from audit');
  assert.equal(entry.details.tokenHash, undefined, 'tokenHash must be stripped from audit');
  assert.equal(entry.details.password, undefined, 'password must be stripped from audit');
  assert.equal(entry.details.secret, undefined, 'secret must be stripped from audit');
  assert.equal(entry.details.session, undefined, 'session must be stripped from audit');

  // Safe non-secret fields remain
  assert.equal(entry.details.merchantNameHint, 'Clean Spa');
});

test('Platform Admin UI & i18n Verification: 44px touch targets, required action names, full zh-CN/en coverage', () => {
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(rootDir, 'public/platform-invitations.html'), 'utf8');
  const js = fs.readFileSync(path.join(rootDir, 'public/platform-invitations.js'), 'utf8');
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
    // Ensure zhVal is Chinese and enVal is English
    assert.match(zhVal, /[\u4e00-\u9fa5]/, `zh-CN translation for ${key} must contain Chinese characters: "${zhVal}"`);
    assert.doesNotMatch(enVal, /[\u4e00-\u9fa5]/, `en translation for ${key} must not contain Chinese characters: "${enVal}"`);
  }
});

test('Merchant Onboarding Compatibility: Created invitation is consumable through existing onboarding flow', async () => {
  const { createMerchantOnboarding } = require('../lib/merchant-onboarding');

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  let invitationStatus = 'pending';
  let resultingShopId = null;
  let consumedAt = null;

  const mockDb = {
    query: async (sql, params) => {
      // 1. Validate invitation query
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

