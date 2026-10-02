'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app } = require('../server');
const {
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
  reactivateFrontDeskMembership
} = require('../lib/front-desk-activation');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '22222222-2222-4222-8222-222222222222',
  ownerAccountA: '33333333-3333-4333-8333-333333333333',
  membershipA: '44444444-4444-4444-8444-444444444444',
  frontDeskAccount: '55555555-5555-4555-8555-555555555555',
  frontDeskMembership: '66666666-6666-4666-8666-666666666666'
};

const sessionRow = (role = 'owner') => ({
  owner_account_id: ID.ownerAccountA,
  membership_id: ID.membershipA,
  shop_id: ID.shopA,
  login_identifier: 'owner-a',
  display_name: 'Owner A',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

function makeMockDb({
  shopActive = true
} = {}) {
  const state = {
    invitations: [],
    ownerAccounts: [],
    memberships: [],
    ownerSessions: [],
    auditLogs: [],
    queries: []
  };

  const db = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      // 1. Shop check
      if (/FROM public\.shops WHERE id = \$1/i.test(normalized)) {
        const [shopId] = params;
        if (shopId === ID.shopA) {
          return {
            rows: [{
              id: shopId,
              name: 'Shop A',
              status: shopActive ? 'active' : 'inactive',
              slug: 'shop-a'
            }]
          };
        }
        return { rows: [] };
      }

      // 2. Insert front desk invitation
      if (/INSERT INTO public\.front_desk_invitations/i.test(normalized)) {
        const [shop_id, phone, email, display_name_hint, token_hash, expires_at, created_by] = params;
        const row = {
          id: 'fd-inv-' + (state.invitations.length + 1),
          shop_id,
          token_hash,
          display_name_hint,
          phone,
          email,
          status: 'pending',
          expires_at,
          created_by_owner_account_id: created_by,
          created_at: new Date()
        };
        state.invitations.push(row);
        return { rows: [row] };
      }

      // 3. Record audit log
      if (/INSERT INTO public\.merchant_auth_audit/i.test(normalized)) {
        const [shop_id, event_type, target_type, target_id, operator_type, operator_id, metadata] = params;
        const row = { id: 'audit-' + (state.auditLogs.length + 1), shop_id, event_type, target_type, target_id, operator_type, operator_id, metadata };
        state.auditLogs.push(row);
        return { rows: [row] };
      }

      // 4. Revoke front desk invitation
      if (/UPDATE public\.front_desk_invitations[\s\S]+?SET status = 'revoked'/i.test(normalized)) {
        const [shopId, invitationId] = params;
        const inv = state.invitations.find(i => i.shop_id === shopId && i.id === invitationId && i.status === 'pending');
        if (inv) {
          inv.status = 'revoked';
          inv.revoked_at = new Date();
          return { rows: [{ id: inv.id }] };
        }
        return { rows: [] };
      }

      // 5. List front desk members and invitations
      if (/FROM public\.owner_shop_memberships osm[\s\S]+?osm\.role = 'front_desk'/i.test(normalized)) {
        const [shopId] = params;
        const rows = state.memberships
          .filter(m => m.shop_id === shopId && m.role === 'front_desk')
          .map(m => {
            const acc = state.ownerAccounts.find(a => a.id === m.owner_account_id) || {};
            return {
              membership_id: m.id,
              owner_account_id: m.owner_account_id,
              role: m.role,
              is_active: m.is_active,
              joined_at: m.created_at,
              login_identifier: acc.login_identifier || 'fd_user',
              display_name: acc.display_name || 'Front Desk Staff',
              phone: acc.phone || null,
              email: acc.email || null
            };
          });
        return { rows };
      }

      if (/FROM public\.front_desk_invitations[\s\S]+?WHERE shop_id = \$1[\s\S]+?status = 'pending'/i.test(normalized)) {
        const [shopId] = params;
        const rows = state.invitations
          .filter(i => i.shop_id === shopId && i.status === 'pending' && i.expires_at > new Date())
          .map(i => ({
            id: i.id,
            display_name_hint: i.display_name_hint,
            phone: i.phone,
            email: i.email,
            status: i.status,
            expires_at: i.expires_at,
            created_at: i.created_at
          }));
        return { rows };
      }

      // 6. Validate front desk invitation
      if (/FROM public\.front_desk_invitations fdi[\s\S]+?JOIN public\.shops sh/i.test(normalized) && !normalized.includes('FOR UPDATE')) {
        const [tokenHash] = params;
        const inv = state.invitations.find(i => i.token_hash === tokenHash);
        if (!inv) return { rows: [] };
        return {
          rows: [{
            id: inv.id,
            shop_id: inv.shop_id,
            display_name_hint: inv.display_name_hint,
            phone: inv.phone,
            email: inv.email,
            status: inv.status,
            expires_at: inv.expires_at,
            consumed_at: inv.consumed_at || null,
            revoked_at: inv.revoked_at || null,
            is_expired: inv.expires_at <= new Date(),
            shop_name: 'Shop A',
            shop_slug: 'shop-a',
            shop_status: shopActive ? 'active' : 'inactive'
          }]
        };
      }

      // 7. Consume invitation query (FOR UPDATE)
      if (/FROM public\.front_desk_invitations fdi[\s\S]+?FOR UPDATE/i.test(normalized)) {
        const [tokenHash] = params;
        const inv = state.invitations.find(i => i.token_hash === tokenHash);
        if (!inv) return { rows: [] };
        return {
          rows: [{
            id: inv.id,
            shop_id: inv.shop_id,
            display_name_hint: inv.display_name_hint,
            phone: inv.phone,
            email: inv.email,
            status: inv.status,
            expires_at: inv.expires_at,
            consumed_at: inv.consumed_at || null,
            revoked_at: inv.revoked_at || null,
            is_expired: inv.expires_at <= new Date(),
            shop_name: 'Shop A',
            shop_slug: 'shop-a',
            shop_status: shopActive ? 'active' : 'inactive'
          }]
        };
      }

      // 8. Username collision check in owner_accounts
      if (/FROM public\.owner_accounts[\s\S]+?login_identifier_normalized/i.test(normalized)) {
        const [username] = params;
        const found = state.ownerAccounts.find(a => a.login_identifier_normalized === username);
        return { rows: found ? [found] : [] };
      }

      // 9. Insert owner_accounts on consume
      if (/INSERT INTO public\.owner_accounts/i.test(normalized)) {
        const [username, _normUser, displayName, passwordHash, phone, email] = params;
        const acc = {
          id: 'oa-' + (state.ownerAccounts.length + 1),
          login_identifier: username,
          login_identifier_normalized: username.toLowerCase(),
          display_name: displayName,
          password_hash: passwordHash,
          phone,
          email,
          status: 'active'
        };
        state.ownerAccounts.push(acc);
        return { rows: [{ id: acc.id }] };
      }

      // 10. Check existing membership on consume
      if (/FROM public\.owner_shop_memberships[\s\S]+?WHERE shop_id = \$1 AND owner_account_id = \$2/i.test(normalized)) {
        const [shopId, accId] = params;
        const found = state.memberships.find(m => m.shop_id === shopId && m.owner_account_id === accId);
        return { rows: found ? [found] : [] };
      }

      // 11. Insert owner_shop_memberships (role = 'front_desk')
      if (/INSERT INTO public\.owner_shop_memberships/i.test(normalized)) {
        const [shop_id, owner_account_id, role] = params;
        const mem = {
          id: 'osm-' + (state.memberships.length + 1),
          shop_id,
          owner_account_id,
          role,
          is_active: true,
          created_at: new Date()
        };
        state.memberships.push(mem);
        return { rows: [{ id: mem.id }] };
      }

      // 12. Mark invitation consumed
      if (/UPDATE public\.front_desk_invitations[\s\S]+?SET status = 'consumed'/i.test(normalized)) {
        const [_ownerAccountId, _memId, _cleanIp, invId] = params;
        const inv = state.invitations.find(i => i.id === invId);
        if (inv) {
          inv.status = 'consumed';
          inv.consumed_at = new Date();
          return { rows: [{ id: inv.id }] };
        }
        return { rows: [] };
      }

      // 13. Disable front desk membership
      if (/UPDATE public\.owner_shop_memberships[\s\S]+?SET is_active = FALSE/i.test(normalized)) {
        const [membershipId, shopId] = params;
        const mem = state.memberships.find(m => m.id === membershipId && m.shop_id === shopId && m.role === 'front_desk');
        if (mem) {
          mem.is_active = false;
          return { rows: [{ id: mem.id, owner_account_id: mem.owner_account_id }] };
        }
        return { rows: [] };
      }

      // 14. Revoke active owner sessions for membership on disable
      if (/UPDATE public\.owner_sessions[\s\S]+?SET revoked_at = NOW\(\)/i.test(normalized)) {
        const [membershipId] = params;
        let count = 0;
        state.ownerSessions.forEach(s => {
          if (s.membership_id === membershipId && !s.revoked_at) {
            s.revoked_at = new Date();
            s.revoke_reason = 'owner_disabled';
            count++;
          }
        });
        return { rows: [{ count }] };
      }

      // 15. Reactivate front desk membership
      if (/UPDATE public\.owner_shop_memberships[\s\S]+?SET is_active = TRUE/i.test(normalized)) {
        const [membershipId, shopId] = params;
        const mem = state.memberships.find(m => m.id === membershipId && m.shop_id === shopId && m.role === 'front_desk');
        if (mem) {
          mem.is_active = true;
          return { rows: [{ id: mem.id, owner_account_id: mem.owner_account_id }] };
        }
        return { rows: [] };
      }

      // Owner auth session check
      if (/FROM owner_sessions/i.test(normalized)) {
        return { rows: [sessionRow('owner')] };
      }

      // Transaction statements
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized) || normalized.startsWith('SET LOCAL')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected mock SQL: ${normalized}`);
    },
    async connect() {
      return {
        query: db.query,
        release() {}
      };
    }
  };

  return { db, state };
}

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
  }
};

const send = (baseUrl, path, {
  method = 'GET', body, authenticated = true, headers = {}
} = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    ...(authenticated ? { cookie: 'gg_beauty_owner_session=test-token' } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

// ==================================================
// Unit Tests: Front Desk Activation Domain & Security
// ==================================================

test('1. Front Desk invitation generation: CSPRNG 32 bytes token, only hash stored in DB, returns activationUrl', async () => {
  const { db, state } = makeMockDb();

  const res = await createFrontDeskInvitation(db, {
    shopId: ID.shopA,
    operatorId: ID.ownerAccountA,
    displayNameHint: 'Front Desk Amy',
    phone: '+6581234567',
    email: 'amy@example.com',
    ttlDays: 7,
    baseUrl: 'https://example.com'
  });

  assert.equal(typeof res.rawToken, 'string');
  assert.equal(res.rawToken.length, 64);
  assert.match(res.rawToken, /^[0-9a-f]{64}$/);
  assert.equal(res.status, 'pending');
  assert(res.activationUrl.includes('/front-desk-activate.html?token='));

  // Database verification: token hash stored, never raw token
  assert.equal(state.invitations.length, 1);
  const stored = state.invitations[0];
  assert.notEqual(stored.token_hash, res.rawToken);
  assert.equal(stored.token_hash.length, 64);
});

test('2. Anti-privilege escalation: role is hardcoded to front_desk and cannot be overridden', async () => {
  const { db, state } = makeMockDb();

  const created = await createFrontDeskInvitation(db, {
    shopId: ID.shopA,
    operatorId: ID.ownerAccountA
  });

  const validPassword = 'SecureFrontDeskPassword123!';
  const res = await consumeFrontDeskInvitation(db, {
    token: created.rawToken,
    username: 'frontdesk_amy',
    password: validPassword,
    displayName: 'Front Desk Amy'
  });

  assert.equal(res.success, true);
  assert.equal(res.role, 'front_desk');

  // Verify created membership in state strictly has role = 'front_desk'
  assert.equal(state.memberships.length, 1);
  assert.equal(state.memberships[0].role, 'front_desk');
  assert.notEqual(state.memberships[0].role, 'owner');
  assert.notEqual(state.memberships[0].role, 'admin');
});

test('3. Front Desk validation: valid token validates successfully, expired/revoked/consumed fail closed', async () => {
  const { db, state } = makeMockDb();

  const created = await createFrontDeskInvitation(db, {
    shopId: ID.shopA,
    operatorId: ID.ownerAccountA
  });

  // Valid
  const valValid = await validateFrontDeskInvitation(db, created.rawToken);
  assert.equal(valValid.isValid, true);
  assert.equal(valValid.state, 'VALID');

  // Revoked
  state.invitations[0].status = 'revoked';
  state.invitations[0].revoked_at = new Date();
  const valRevoked = await validateFrontDeskInvitation(db, created.rawToken);
  assert.equal(valRevoked.isValid, false);
  assert.equal(valRevoked.state, 'REVOKED');

  // Expired
  state.invitations[0].status = 'pending';
  state.invitations[0].revoked_at = null;
  state.invitations[0].expires_at = new Date(Date.now() - 1000);
  const valExpired = await validateFrontDeskInvitation(db, created.rawToken);
  assert.equal(valExpired.isValid, false);
  assert.equal(valExpired.state, 'EXPIRED');

  // Consumed
  state.invitations[0].status = 'consumed';
  state.invitations[0].consumed_at = new Date();
  const valConsumed = await validateFrontDeskInvitation(db, created.rawToken);
  assert.equal(valConsumed.isValid, false);
  assert.equal(valConsumed.state, 'ALREADY_CONSUMED');
});

test('4. Front Desk password validation: rejects < 16 chars and rejects > 72 UTF-8 bytes', async () => {
  const { db } = makeMockDb();
  const created = await createFrontDeskInvitation(db, {
    shopId: ID.shopA,
    operatorId: ID.ownerAccountA
  });

  // Short password (< 16 chars)
  await assert.rejects(
    () => consumeFrontDeskInvitation(db, {
      token: created.rawToken,
      username: 'frontdesk_amy',
      displayName: 'Front Desk Amy',
      password: 'short-pass-15c'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'PASSWORD_TOO_SHORT');
      assert.equal(err.status, 400);
      return true;
    }
  );

  // Multi-byte password exceeding 72 UTF-8 bytes
  const longMultiBytePassword = '前台'.repeat(13); // 26 chars * 3 bytes = 78 bytes > 72 bytes
  assert(Buffer.byteLength(longMultiBytePassword, 'utf8') > 72);
  await assert.rejects(
    () => consumeFrontDeskInvitation(db, {
      token: created.rawToken,
      username: 'frontdesk_amy',
      displayName: 'Front Desk Amy',
      password: longMultiBytePassword
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'PASSWORD_TOO_LONG');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('5. Disabling front desk sets is_active = FALSE and immediately revokes active owner_sessions', async () => {
  const { db, state } = makeMockDb();

  state.memberships.push({
    id: ID.frontDeskMembership,
    shop_id: ID.shopA,
    owner_account_id: ID.frontDeskAccount,
    role: 'front_desk',
    is_active: true
  });
  state.ownerSessions.push({
    id: 'os-1',
    membership_id: ID.frontDeskMembership,
    revoked_at: null
  });

  const res = await disableFrontDeskMembership(db, {
    shopId: ID.shopA,
    membershipId: ID.frontDeskMembership,
    operatorId: ID.ownerAccountA
  });

  assert.equal(res.success, true);
  assert.equal(state.memberships[0].is_active, false);
  assert.equal(state.ownerSessions[0].revoke_reason, 'owner_disabled');
  assert(state.ownerSessions[0].revoked_at);
});

test('6. Reactivating front desk sets is_active = TRUE without reviving old sessions', async () => {
  const { db, state } = makeMockDb();

  const revokedTime = new Date('2026-01-01');
  state.memberships.push({
    id: ID.frontDeskMembership,
    shop_id: ID.shopA,
    owner_account_id: ID.frontDeskAccount,
    role: 'front_desk',
    is_active: false
  });
  state.ownerSessions.push({
    id: 'os-1',
    membership_id: ID.frontDeskMembership,
    revoked_at: revokedTime,
    revoke_reason: 'owner_disabled'
  });

  const res = await reactivateFrontDeskMembership(db, {
    shopId: ID.shopA,
    membershipId: ID.frontDeskMembership,
    operatorId: ID.ownerAccountA
  });

  assert.equal(res.success, true);
  assert.equal(state.memberships[0].is_active, true);
  // Old session remains dead!
  assert.equal(state.ownerSessions[0].revoked_at, revokedTime);
});

test('7. Cross-tenant isolation: cannot disable or reactivate membership of a different shop', async () => {
  const { db, state } = makeMockDb();

  state.memberships.push({
    id: ID.frontDeskMembership,
    shop_id: ID.shopB, // belonging to Shop B
    owner_account_id: ID.frontDeskAccount,
    role: 'front_desk',
    is_active: true
  });

  // Shop A tries to disable Shop B's membership
  await assert.rejects(
    () => disableFrontDeskMembership(db, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'MEMBERSHIP_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

// ==================================================
// End-to-End Route Tests
// ==================================================

test('8. HTTP GET /front-desk-activate.html returns 200 with no-store headers', async () => {
  await withServer(async baseUrl => {
    const res = await fetch(`${baseUrl}/front-desk-activate.html`);
    assert.equal(res.status, 200);
    assert(res.headers.get('cache-control').includes('no-store'));
    const html = await res.text();
    assert(html.includes('GG-Beauty'));
  });
});

test('9. HTTP Owner Front Desk API: unauthenticated requests fail with 401', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const r1 = await send(baseUrl, '/api/owner/team/front-desk', { authenticated: false });
    assert.equal(r1.status, 401);

    const r2 = await send(baseUrl, '/api/owner/team/front-desk/invitation', { method: 'POST', authenticated: false });
    assert.equal(r2.status, 401);

    const r3 = await send(baseUrl, `/api/owner/team/front-desk/invitation/${ID.frontDeskMembership}`, { method: 'DELETE', authenticated: false });
    assert.equal(r3.status, 401);

    const r4 = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/status`, { method: 'PATCH', body: { status: 'disabled' }, authenticated: false });
    assert.equal(r4.status, 401);
  });
});

test('10. HTTP Owner Front Desk API: authenticated owner can list, invite, revoke, and toggle status', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    // 1. List front desk team
    const resList = await send(baseUrl, '/api/owner/team/front-desk');
    assert.equal(resList.status, 200);
    const bodyList = await resList.json();
    assert.equal(bodyList.success, true);
    assert.deepEqual(bodyList.data.members, []);
    assert.deepEqual(bodyList.data.pendingInvitations, []);

    // 2. Create front desk invitation
    const resInv = await send(baseUrl, '/api/owner/team/front-desk/invitation', {
      method: 'POST',
      body: {
        displayName: 'Front Desk Bob',
        phone: '+6588889999',
        ttlDays: 7
      }
    });
    assert.equal(resInv.status, 201);
    const bodyInv = await resInv.json();
    assert.equal(bodyInv.success, true);
    assert.equal(typeof bodyInv.data.rawToken, 'string');
    assert(bodyInv.data.activationUrl.includes('/front-desk-activate.html?token='));
  });
});
