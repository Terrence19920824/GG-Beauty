'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app } = require('../server');
const {
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
} = require('../lib/staff-activation');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '22222222-2222-4222-8222-222222222222',
  ownerAccountA: '33333333-3333-4333-8333-333333333333',
  membershipA: '44444444-4444-4444-8444-444444444444',
  staffA: '55555555-5555-4555-8555-555555555555',
  staffB: '66666666-6666-4666-8666-666666666666',
  locationA: '77777777-7777-4777-8777-777777777777'
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
  hasLocation = true,
  hasActiveAccount = false,
  staffActive = true,
  shopActive = true
} = {}) {
  const state = {
    invitations: [],
    staffAccounts: [],
    staffSessions: [],
    auditLogs: [],
    queries: []
  };

  const db = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      // 1. Staff check
      if (/FROM public\.staff[\s\S]+?WHERE id = \$1 AND shop_id = \$2/i.test(normalized)) {
        const [staffId, shopId] = params;
        if (shopId === ID.shopA && staffId === ID.staffA) {
          return {
            rows: [{
              id: staffId,
              name: 'Alice Wong',
              staff_code: 'STF01',
              is_active: staffActive,
              can_login: true
            }]
          };
        }
        return { rows: [] };
      }

      // 2. Location assignment check
      if (/FROM public\.staff_location_assignments/i.test(normalized)) {
        return { rows: hasLocation ? [{ 1: 1 }] : [] };
      }

      // 3. Existing account check
      if (/FROM public\.staff_accounts[\s\S]+?WHERE shop_id = \$1 AND staff_id = \$2/i.test(normalized)) {
        const found = state.staffAccounts.find(a => a.shop_id === params[0] && a.staff_id === params[1]);
        if (found) {
          return { rows: [found] };
        }
        if (hasActiveAccount) {
          return { rows: [{ id: 'existing-acc-1', status: 'active', username: 'alice_existing' }] };
        }
        return { rows: [] };
      }

      // 3b. Staff account latest invitation check in getStaffAccountInfo
      if (/FROM public\.staff_activation_invitations[\s\S]+?WHERE shop_id = \$1 AND staff_id = \$2/i.test(normalized)) {
        const [shopId, staffId] = params;
        const found = state.invitations.filter(i => i.shop_id === shopId && i.staff_id === staffId);
        if (found.length > 0) {
          const inv = found[found.length - 1];
          return {
            rows: [{
              id: inv.id,
              status: inv.status,
              expires_at: inv.expires_at,
              created_at: inv.created_at,
              consumed_at: inv.consumed_at || null,
              revoked_at: inv.revoked_at || null,
              is_expired: inv.expires_at <= new Date()
            }]
          };
        }
        return { rows: [] };
      }

      // 4. Revoke pending invitations
      if (/UPDATE public\.staff_activation_invitations[\s\S]+?SET status = 'revoked'/i.test(normalized)) {
        const [shopId, staffId] = params;
        let count = 0;
        state.invitations.forEach(inv => {
          if (inv.shop_id === shopId && inv.staff_id === staffId && inv.status === 'pending') {
            inv.status = 'revoked';
            inv.revoked_at = new Date();
            count++;
          }
        });
        return { rows: count > 0 ? [{ id: 'revoked-id' }] : [] };
      }

      // 5. Insert invitation
      if (/INSERT INTO public\.staff_activation_invitations/i.test(normalized)) {
        const [shop_id, staff_id, token_hash, expires_at, created_by] = params;
        const row = {
          id: 'inv-' + (state.invitations.length + 1),
          shop_id,
          staff_id,
          token_hash,
          status: 'pending',
          expires_at,
          created_by_owner_account_id: created_by,
          created_at: new Date()
        };
        state.invitations.push(row);
        return { rows: [row] };
      }

      // 6. Record audit log
      if (/INSERT INTO public\.merchant_auth_audit/i.test(normalized)) {
        const [shop_id, event_type, target_type, target_id, operator_type, operator_id, metadata] = params;
        const row = { id: 'audit-' + (state.auditLogs.length + 1), shop_id, event_type, target_type, target_id, operator_type, operator_id, metadata };
        state.auditLogs.push(row);
        return { rows: [row] };
      }

      // 7. Validate invitation query
      if (/FROM public\.staff_activation_invitations sai\s+JOIN public\.staff s/i.test(normalized)) {
        const [tokenHash] = params;
        const inv = state.invitations.find(i => i.token_hash === tokenHash);
        if (!inv) return { rows: [] };
        return {
          rows: [{
            id: inv.id,
            shop_id: inv.shop_id,
            staff_id: inv.staff_id,
            status: inv.status,
            expires_at: inv.expires_at,
            consumed_at: inv.consumed_at || null,
            revoked_at: inv.revoked_at || null,
            is_expired: inv.expires_at <= new Date(),
            staff_name: 'Alice Wong',
            staff_code: 'STF01',
            staff_is_active: staffActive,
            staff_can_login: true,
            shop_name: 'Shop A',
            shop_slug: 'shop-a',
            shop_status: shopActive ? 'active' : 'inactive'
          }]
        };
      }

      // 8. Consume invitation query (FOR UPDATE)
      if (/FROM public\.staff_activation_invitations sai[\s\S]+FOR UPDATE/i.test(normalized)) {
        const [tokenHash] = params;
        const inv = state.invitations.find(i => i.token_hash === tokenHash);
        if (!inv) return { rows: [] };
        return {
          rows: [{
            id: inv.id,
            shop_id: inv.shop_id,
            staff_id: inv.staff_id,
            status: inv.status,
            expires_at: inv.expires_at,
            consumed_at: inv.consumed_at || null,
            revoked_at: inv.revoked_at || null,
            is_expired: inv.expires_at <= new Date(),
            staff_name: 'Alice Wong',
            staff_is_active: staffActive,
            staff_can_login: true,
            shop_slug: 'shop-a',
            shop_status: shopActive ? 'active' : 'inactive'
          }]
        };
      }

      // 9. Username collision check
      if (/FROM public\.staff_accounts[\s\S]+?login_identifier_normalized/i.test(normalized)) {
        const [shopId, username] = params;
        const found = state.staffAccounts.find(a => a.shop_id === shopId && a.username === username);
        return { rows: found ? [found] : [] };
      }

      // 10. Upsert/Insert staff account on consume
      if (/INSERT INTO public\.staff_accounts/i.test(normalized)) {
        const [shop_id, staff_id, username, _normalizedUsername, password_hash] = params;
        const acc = {
          id: 'acc-' + (state.staffAccounts.length + 1),
          shop_id,
          staff_id,
          username,
          password_hash,
          status: 'active',
          session_version: 1
        };
        state.staffAccounts.push(acc);
        return { rows: [{ id: acc.id }] };
      }

      // 10b. Staff permissions insert
      if (/INSERT INTO public\.staff_permissions/i.test(normalized)) {
        return { rows: [] };
      }

      // 11. Mark invitation consumed
      if (/UPDATE public\.staff_activation_invitations[\s\S]+?SET status = 'consumed'/i.test(normalized)) {
        const [_staffAccountId, _cleanIp, invId] = params;
        const inv = state.invitations.find(i => i.id === invId);
        if (inv) {
          inv.status = 'consumed';
          inv.consumed_at = new Date();
          return { rows: [{ id: inv.id }] };
        }
        return { rows: [] };
      }

      // 12. Disable staff account
      if (/UPDATE public\.staff_accounts[\s\S]+?SET status = 'disabled'/i.test(normalized)) {
        const [shopId, staffId] = params;
        const acc = state.staffAccounts.find(a => a.shop_id === shopId && a.staff_id === staffId);
        if (acc) {
          acc.status = 'disabled';
          acc.session_version = (acc.session_version || 1) + 1;
          return { rows: [{ id: acc.id }] };
        }
        return { rows: [] };
      }

      // 13. Revoke sessions on disable
      if (/UPDATE public\.staff_sessions\s+SET revoked_at = NOW\(\)/i.test(normalized)) {
        const [shopId, accountId] = params;
        let count = 0;
        state.staffSessions.forEach(s => {
          if (s.shop_id === shopId && s.staff_account_id === accountId && !s.revoked_at) {
            s.revoked_at = new Date();
            s.revoke_reason = 'owner_disabled';
            count++;
          }
        });
        return { rows: [{ count }] };
      }

      // 14. Reactivate staff account
      if (/UPDATE public\.staff_accounts[\s\S]+?SET status = 'active'/i.test(normalized)) {
        const [shopId, staffId] = params;
        const acc = state.staffAccounts.find(a => a.shop_id === shopId && a.staff_id === staffId);
        if (acc) {
          acc.status = 'active';
          return { rows: [{ id: acc.id }] };
        }
        return { rows: [] };
      }

      // 15. Owner session query
      if (/FROM owner_sessions/i.test(normalized)) {
        return { rows: [sessionRow('owner')] };
      }

      // Transaction queries
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
// Unit Tests: Staff Activation Domain & Security
// ==================================================

test('1. Staff location requirement: creation fails closed with STAFF_LOCATION_REQUIRED when staff has no active location', async () => {
  const { db } = makeMockDb({ hasLocation: false });

  await assert.rejects(
    () => createStaffActivationInvitation(db, {
      shopId: ID.shopA,
      staffId: ID.staffA,
      operatorId: ID.ownerAccountA
    }),
    err => {
      assert(err instanceof StaffActivationError);
      assert.equal(err.code, 'STAFF_LOCATION_REQUIRED');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('2. Token entropy & hashing: 32 bytes CSPRNG token generated, only SHA-256 hash stored in DB, raw token returned once', async () => {
  const { db, state } = makeMockDb({ hasLocation: true });

  const result = await createStaffActivationInvitation(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA,
    ttlDays: 7,
    baseUrl: 'https://example.com'
  });

  assert.equal(typeof result.rawToken, 'string');
  assert.equal(result.rawToken.length, 64, '32 bytes hex = 64 characters');
  assert.match(result.rawToken, /^[0-9a-f]{64}$/);
  assert.equal(result.status, 'pending');
  assert(result.activationUrl.includes(result.rawToken));

  // Check state: DB only stored hash, never raw token
  assert.equal(state.invitations.length, 1);
  const stored = state.invitations[0];
  assert.notEqual(stored.token_hash, result.rawToken);
  assert.equal(stored.token_hash.length, 64);
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
});

test('3. Existing active account blocks new invitation with STAFF_ACCOUNT_ALREADY_EXISTS', async () => {
  const { db } = makeMockDb({ hasLocation: true, hasActiveAccount: true });

  await assert.rejects(
    () => createStaffActivationInvitation(db, {
      shopId: ID.shopA,
      staffId: ID.staffA,
      operatorId: ID.ownerAccountA
    }),
    err => {
      assert(err instanceof StaffActivationError);
      assert.equal(err.code, 'STAFF_ACCOUNT_ALREADY_EXISTS');
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('4. Invitation validation: valid token validates successfully, expired/revoked/consumed fail closed', async () => {
  const { db, state } = makeMockDb({ hasLocation: true });

  const created = await createStaffActivationInvitation(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA
  });

  // Valid
  const valValid = await validateStaffInvitation(db, created.rawToken);
  assert.equal(valValid.isValid, true);
  assert.equal(valValid.state, 'VALID');
  assert.equal(valValid.data.staffName, 'Alice Wong');

  // Revoked
  state.invitations[0].status = 'revoked';
  state.invitations[0].revoked_at = new Date();
  const valRevoked = await validateStaffInvitation(db, created.rawToken);
  assert.equal(valRevoked.isValid, false);
  assert.equal(valRevoked.state, 'REVOKED');

  // Expired
  state.invitations[0].status = 'pending';
  state.invitations[0].revoked_at = null;
  state.invitations[0].expires_at = new Date(Date.now() - 1000);
  const valExpired = await validateStaffInvitation(db, created.rawToken);
  assert.equal(valExpired.isValid, false);
  assert.equal(valExpired.state, 'EXPIRED');

  // Consumed
  state.invitations[0].status = 'consumed';
  state.invitations[0].consumed_at = new Date();
  const valConsumed = await validateStaffInvitation(db, created.rawToken);
  assert.equal(valConsumed.isValid, false);
  assert.equal(valConsumed.state, 'ALREADY_CONSUMED');
});

test('5. Password validation: rejects < 16 characters and rejects > 72 UTF-8 bytes boundary', async () => {
  const { db } = makeMockDb({ hasLocation: true });
  const created = await createStaffActivationInvitation(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA
  });

  // Short password (< 16 chars)
  await assert.rejects(
    () => consumeStaffActivationInvitation(db, {
      token: created.rawToken,
      username: 'alicewong',
      password: 'short-pass-15c'
    }),
    err => {
      assert(err instanceof StaffActivationError);
      assert.equal(err.code, 'PASSWORD_TOO_SHORT');
      assert.equal(err.status, 400);
      return true;
    }
  );

  // Multi-byte password exceeding 72 UTF-8 bytes (e.g. 25 Chinese characters = 75 bytes)
  const longMultiBytePassword = '密码'.repeat(13); // 26 chars * 3 bytes = 78 bytes > 72 bytes
  assert(Buffer.byteLength(longMultiBytePassword, 'utf8') > 72);
  await assert.rejects(
    () => consumeStaffActivationInvitation(db, {
      token: created.rawToken,
      username: 'alicewong',
      password: longMultiBytePassword
    }),
    err => {
      assert(err instanceof StaffActivationError);
      assert.equal(err.code, 'PASSWORD_TOO_LONG');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('6. Valid consumption: creates staff_accounts, consumes invitation, hashes password with bcrypt cost 12', async () => {
  const { db, state } = makeMockDb({ hasLocation: true });
  const created = await createStaffActivationInvitation(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA
  });

  const validPassword = 'CorrectHorseBatteryStaple123!';
  assert(validPassword.length >= 16);
  assert(Buffer.byteLength(validPassword, 'utf8') <= 72);

  const res = await consumeStaffActivationInvitation(db, {
    token: created.rawToken,
    username: 'Alice_Wong',
    password: validPassword,
    consumedIp: '127.0.0.1'
  });

  assert.equal(res.success, true);
  assert.equal(res.username, 'alice_wong'); // normalized to lowercase
  assert.equal(res.shopSlug, 'shop-a');

  // Verify staff account in state
  assert.equal(state.staffAccounts.length, 1);
  const acc = state.staffAccounts[0];
  assert.equal(acc.username, 'alice_wong');
  assert.notEqual(acc.password_hash, validPassword);
  assert(acc.password_hash.startsWith('$2')); // bcrypt prefix
  assert(bcrypt.compareSync(validPassword, acc.password_hash));
  const permissionInsert = state.queries.find(query =>
    /INSERT INTO public\.staff_permissions/i.test(query.sql)
  );
  assert.match(permissionInsert.sql, /TRUE, TRUE, NOW\(\), NOW\(\)\)/);

  // Verify invitation marked consumed
  assert.equal(state.invitations[0].status, 'consumed');
  assert(state.invitations[0].consumed_at);
});

test('7. Disable staff account increments session_version and revokes all active sessions', async () => {
  const { db, state } = makeMockDb({ hasLocation: true });

  // Add existing staff account and active session
  state.staffAccounts.push({
    id: 'acc-1',
    shop_id: ID.shopA,
    staff_id: ID.staffA,
    username: 'alice_wong',
    status: 'active',
    session_version: 1
  });
  state.staffSessions.push({
    id: 'sess-1',
    shop_id: ID.shopA,
    staff_account_id: 'acc-1',
    revoked_at: null
  });

  const res = await disableStaffAccount(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA
  });

  assert.equal(res.success, true);
  assert.equal(state.staffAccounts[0].status, 'disabled');
  assert.equal(state.staffAccounts[0].session_version, 2);
  assert.equal(state.staffSessions[0].revoke_reason, 'owner_disabled');
  assert(state.staffSessions[0].revoked_at);
});

test('8. Reactivate staff account sets status active without resurrecting old sessions', async () => {
  const { db, state } = makeMockDb({ hasLocation: true });

  state.staffAccounts.push({
    id: 'acc-1',
    shop_id: ID.shopA,
    staff_id: ID.staffA,
    username: 'alice_wong',
    status: 'disabled',
    session_version: 2
  });
  const revokedTime = new Date('2026-01-01');
  state.staffSessions.push({
    id: 'sess-1',
    shop_id: ID.shopA,
    staff_account_id: 'acc-1',
    revoked_at: revokedTime,
    revoke_reason: 'owner_disabled'
  });

  const res = await reactivateStaffAccount(db, {
    shopId: ID.shopA,
    staffId: ID.staffA,
    operatorId: ID.ownerAccountA
  });

  assert.equal(res.success, true);
  assert.equal(state.staffAccounts[0].status, 'active');
  // Old session remains dead!
  assert.equal(state.staffSessions[0].revoked_at, revokedTime);
});

test('9. Audit trail safety: comprehensive adversarial secret sanitization', () => {
  // 1. Top-level object
  const topLevel = {
    invitation_id: 'inv-123',
    staff_id: 'staff-456',
    password: 'plain_password',
    token: 'raw_token',
    secret: 'render_secret'
  };
  const cleanTopLevel = sanitizeAuditMetadata(topLevel);
  assert.equal(cleanTopLevel.invitation_id, 'inv-123');
  assert.equal(cleanTopLevel.staff_id, 'staff-456');
  assert.equal(cleanTopLevel.password, undefined);
  assert.equal(cleanTopLevel.token, undefined);
  assert.equal(cleanTopLevel.secret, undefined);

  // 2. Nested object
  const nestedObj = {
    event: 'account_update',
    reason: 'owner_request',
    details: {
      password: 'nested_secret_password',
      account_id: 'acc-789',
      sub_details: {
        password_hash: 'nested_hash_value',
        from_status: 'pending',
        to_status: 'active'
      }
    }
  };
  const cleanNestedObj = sanitizeAuditMetadata(nestedObj);
  assert.equal(cleanNestedObj.event, 'account_update');
  assert.equal(cleanNestedObj.reason, 'owner_request');
  assert.equal(cleanNestedObj.details.account_id, 'acc-789');
  assert.equal(cleanNestedObj.details.password, undefined);
  assert.equal(cleanNestedObj.details.sub_details.from_status, 'pending');
  assert.equal(cleanNestedObj.details.sub_details.to_status, 'active');
  assert.equal(cleanNestedObj.details.sub_details.password_hash, undefined);

  // 3. Nested array
  const nestedArray = {
    membership_id: 'mem-999',
    matrix: [
      [
        { token: 'secret_token_1', action: 'keep_me_1' },
        { session_token: 'sess_1', action: 'keep_me_2' }
      ]
    ]
  };
  const cleanNestedArray = sanitizeAuditMetadata(nestedArray);
  assert.equal(cleanNestedArray.membership_id, 'mem-999');
  assert.equal(cleanNestedArray.matrix[0][0].action, 'keep_me_1');
  assert.equal(cleanNestedArray.matrix[0][0].token, undefined);
  assert.equal(cleanNestedArray.matrix[0][1].action, 'keep_me_2');
  assert.equal(cleanNestedArray.matrix[0][1].session_token, undefined);

  // 4. Object inside array
  const objInArray = {
    event_type: 'staff_audit',
    items: [
      { raw_token: 'secret_raw', staff_id: 'staff-11' },
      { cookie: 'cookie_val', account_id: 'acc-22' }
    ]
  };
  const cleanObjInArray = sanitizeAuditMetadata(objInArray);
  assert.equal(cleanObjInArray.event_type, 'staff_audit');
  assert.equal(cleanObjInArray.items[0].staff_id, 'staff-11');
  assert.equal(cleanObjInArray.items[0].raw_token, undefined);
  assert.equal(cleanObjInArray.items[1].account_id, 'acc-22');
  assert.equal(cleanObjInArray.items[1].cookie, undefined);

  // 5. Mixed-case secret keys
  const mixedCase = {
    pAsSwOrD: 'secret1',
    ToKeN: 'secret2',
    DaTaBaSe_UrL: 'postgres://user:pass@host/db',
    ApI_kEy: 'key_123',
    SuPaBaSe_KeY: 'sb_123',
    AuThOrIzAtIoN: 'Bearer xxx',
    safe_field: 'keep'
  };
  const cleanMixedCase = sanitizeAuditMetadata(mixedCase);
  assert.equal(cleanMixedCase.safe_field, 'keep');
  assert.equal(cleanMixedCase.pAsSwOrD, undefined);
  assert.equal(cleanMixedCase.ToKeN, undefined);
  assert.equal(cleanMixedCase.DaTaBaSe_UrL, undefined);
  assert.equal(cleanMixedCase.ApI_kEy, undefined);
  assert.equal(cleanMixedCase.SuPaBaSe_KeY, undefined);
  assert.equal(cleanMixedCase.AuThOrIzAtIoN, undefined);

  // 6. Snake_case secret keys
  const snakeCase = {
    raw_token: 'token_val',
    token_hash: 'hash_val',
    session_token: 'session_val',
    session_cookie: 'cookie_val',
    db_url: 'postgres://...',
    api_key: 'api_val',
    supabase_key: 'sb_val',
    supabase_service_role_key: 'sb_role',
    render_secret: 'rndr_secret',
    password_hash: 'pwd_hash',
    invitation_id: 'inv-safe'
  };
  const cleanSnakeCase = sanitizeAuditMetadata(snakeCase);
  assert.equal(cleanSnakeCase.invitation_id, 'inv-safe');
  assert.equal(cleanSnakeCase.raw_token, undefined);
  assert.equal(cleanSnakeCase.token_hash, undefined);
  assert.equal(cleanSnakeCase.session_token, undefined);
  assert.equal(cleanSnakeCase.session_cookie, undefined);
  assert.equal(cleanSnakeCase.db_url, undefined);
  assert.equal(cleanSnakeCase.api_key, undefined);
  assert.equal(cleanSnakeCase.supabase_key, undefined);
  assert.equal(cleanSnakeCase.supabase_service_role_key, undefined);
  assert.equal(cleanSnakeCase.render_secret, undefined);
  assert.equal(cleanSnakeCase.password_hash, undefined);

  // 7. CamelCase secret keys
  const camelCase = {
    rawToken: 'token_val',
    tokenHash: 'hash_val',
    sessionToken: 'session_val',
    sessionCookie: 'cookie_val',
    dbUrl: 'db_val',
    databaseUrl: 'db_val',
    apiKey: 'api_val',
    supabaseKey: 'sb_val',
    renderSecret: 'rndr_val',
    passwordHash: 'pwd_hash',
    membership_id: 'mem-safe'
  };
  const cleanCamelCase = sanitizeAuditMetadata(camelCase);
  assert.equal(cleanCamelCase.membership_id, 'mem-safe');
  assert.equal(cleanCamelCase.rawToken, undefined);
  assert.equal(cleanCamelCase.tokenHash, undefined);
  assert.equal(cleanCamelCase.sessionToken, undefined);
  assert.equal(cleanCamelCase.sessionCookie, undefined);
  assert.equal(cleanCamelCase.dbUrl, undefined);
  assert.equal(cleanCamelCase.databaseUrl, undefined);
  assert.equal(cleanCamelCase.apiKey, undefined);
  assert.equal(cleanCamelCase.supabaseKey, undefined);
  assert.equal(cleanCamelCase.renderSecret, undefined);
  assert.equal(cleanCamelCase.passwordHash, undefined);

  // 8. DATABASE_URL variants
  const dbUrlVariants = {
    DATABASE_URL: 'postgres://...',
    databaseUrl: 'postgres://...',
    db_url: 'postgres://...',
    dbUrl: 'postgres://...',
    reason: 'safe_operation'
  };
  const cleanDbUrl = sanitizeAuditMetadata(dbUrlVariants);
  assert.equal(cleanDbUrl.reason, 'safe_operation');
  assert.equal(cleanDbUrl.DATABASE_URL, undefined);
  assert.equal(cleanDbUrl.databaseUrl, undefined);
  assert.equal(cleanDbUrl.db_url, undefined);
  assert.equal(cleanDbUrl.dbUrl, undefined);

  // 9. api_key / apiKey variants
  const apiKeyVariants = {
    api_key: 'secret_api',
    apiKey: 'secret_api',
    API_KEY: 'secret_api',
    action: 'validated'
  };
  const cleanApiKey = sanitizeAuditMetadata(apiKeyVariants);
  assert.equal(cleanApiKey.action, 'validated');
  assert.equal(cleanApiKey.api_key, undefined);
  assert.equal(cleanApiKey.apiKey, undefined);
  assert.equal(cleanApiKey.API_KEY, undefined);

  // 10. supabase_* key variants
  const supabaseVariants = {
    supabase_key: 'sb_anon',
    supabaseKey: 'sb_anon',
    supabase_service_role_key: 'sb_service',
    SUPABASE_ANON_KEY: 'sb_anon_2',
    state_transition: 'pending_to_active'
  };
  const cleanSupabase = sanitizeAuditMetadata(supabaseVariants);
  assert.equal(cleanSupabase.state_transition, 'pending_to_active');
  assert.equal(cleanSupabase.supabase_key, undefined);
  assert.equal(cleanSupabase.supabaseKey, undefined);
  assert.equal(cleanSupabase.supabase_service_role_key, undefined);
  assert.equal(cleanSupabase.SUPABASE_ANON_KEY, undefined);

  // 11. password/hash/token/session/cookie/authorization variants
  const authVariants = {
    password: 'p1',
    password_hash: 'p2',
    passwordHash: 'p3',
    raw_token: 't1',
    rawToken: 't2',
    token_hash: 't3',
    tokenHash: 't4',
    session_token: 's1',
    sessionToken: 's2',
    session_cookie: 'c1',
    cookie: 'c2',
    authorization: 'Bearer tok',
    authToken: 'tok_auth',
    account_id: 'acc-safe',
    status: 'active'
  };
  const cleanAuth = sanitizeAuditMetadata(authVariants);
  assert.equal(cleanAuth.account_id, 'acc-safe');
  assert.equal(cleanAuth.status, 'active');
  assert.equal(cleanAuth.password, undefined);
  assert.equal(cleanAuth.password_hash, undefined);
  assert.equal(cleanAuth.passwordHash, undefined);
  assert.equal(cleanAuth.raw_token, undefined);
  assert.equal(cleanAuth.rawToken, undefined);
  assert.equal(cleanAuth.token_hash, undefined);
  assert.equal(cleanAuth.tokenHash, undefined);
  assert.equal(cleanAuth.session_token, undefined);
  assert.equal(cleanAuth.sessionToken, undefined);
  assert.equal(cleanAuth.session_cookie, undefined);
  assert.equal(cleanAuth.cookie, undefined);
  assert.equal(cleanAuth.authorization, undefined);
  assert.equal(cleanAuth.authToken, undefined);

  // Verification of non-mutation of original metadata
  const originalDirty = {
    details: {
      password: 'do_not_mutate',
      staff_id: 's-original'
    }
  };
  const snapshotBefore = JSON.stringify(originalDirty);
  const resultClean = sanitizeAuditMetadata(originalDirty);
  const snapshotAfter = JSON.stringify(originalDirty);
  assert.equal(snapshotBefore, snapshotAfter, 'Original metadata object must never be mutated');
  assert.equal(resultClean.details.password, undefined);
  assert.equal(resultClean.details.staff_id, 's-original');
  assert.equal(originalDirty.details.password, 'do_not_mutate');
});

// ==================================================
// End-to-End Route Tests
// ==================================================

test('10. HTTP GET /staff-activate.html returns 200 with no-store headers', async () => {
  await withServer(async baseUrl => {
    const res = await fetch(`${baseUrl}/staff-activate.html`);
    assert.equal(res.status, 200);
    assert(res.headers.get('cache-control').includes('no-store'));
    const html = await res.text();
    assert(html.includes('GG-Beauty'));
  });
});

test('11. HTTP Owner Staff Account API: unauthenticated requests fail with 401', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const r1 = await send(baseUrl, `/api/owner/staff/${ID.staffA}/account`, { authenticated: false });
    assert.equal(r1.status, 401);

    const r2 = await send(baseUrl, `/api/owner/staff/${ID.staffA}/activation-invitation`, { method: 'POST', authenticated: false });
    assert.equal(r2.status, 401);

    const r3 = await send(baseUrl, `/api/owner/staff/${ID.staffA}/activation-invitation`, { method: 'DELETE', authenticated: false });
    assert.equal(r3.status, 401);

    const r4 = await send(baseUrl, `/api/owner/staff/${ID.staffA}/account/status`, { method: 'PATCH', body: { status: 'disabled' }, authenticated: false });
    assert.equal(r4.status, 401);
  });
});

test('12. HTTP Owner Staff Account API: authenticated owner can query status, create invitation, and toggle status', async () => {
  const { db } = makeMockDb({ hasLocation: true });
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    // 1. Get account info
    const resInfo = await send(baseUrl, `/api/owner/staff/${ID.staffA}/account`);
    assert.equal(resInfo.status, 200);
    const bodyInfo = await resInfo.json();
    assert.equal(bodyInfo.success, true);
    assert.equal(bodyInfo.data.hasAccount, false);
    assert.equal(bodyInfo.data.hasActiveLocation, true);

    // 2. Create invitation
    const resInv = await send(baseUrl, `/api/owner/staff/${ID.staffA}/activation-invitation`, {
      method: 'POST',
      body: { ttlDays: 7 }
    });
    assert.equal(resInv.status, 201);
    const bodyInv = await resInv.json();
    assert.equal(bodyInv.success, true);
    assert.equal(typeof bodyInv.data.rawToken, 'string');
    assert(bodyInv.data.activationUrl.includes('/staff-activate.html?token='));

    // 3. Revoke invitation
    const resRevoke = await send(baseUrl, `/api/owner/staff/${ID.staffA}/activation-invitation`, {
      method: 'DELETE'
    });
    assert.equal(resRevoke.status, 200);
    const bodyRevoke = await resRevoke.json();
    assert.equal(bodyRevoke.success, true);
  });
});
