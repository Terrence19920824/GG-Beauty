'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app } = require('../server');
const {
  FrontDeskActivationError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES
} = require('../lib/front-desk-activation');
const {
  generateTemporaryPassword,
  validateNewPassword,
  resetFrontDeskPassword
} = require('../lib/front-desk-password-reset');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '22222222-2222-4222-8222-222222222222',
  ownerAccountA: '33333333-3333-4333-8333-333333333333',
  membershipA: '44444444-4444-4444-8444-444444444444',
  frontDeskAccount: '55555555-5555-4555-8555-555555555555',
  frontDeskMembership: '66666666-6666-4666-8666-666666666666',
  ownerAccountB: '77777777-7777-4777-8777-777777777777',
  membershipB: '88888888-8888-4888-8888-888888888888'
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
  shopActive = true,
  accountActive = true,
  membershipActive = true,
  role = 'front_desk',
  initialSessionVersion = 1,
  initialFailedAttempts = 3,
  initialLockedUntil = new Date(Date.now() + 300000),
  sessionRole = 'owner',
  failAfterAccountUpdate = false
} = {}) {
  let accountBackup = null;
  const state = {
    ownerAccounts: [
      {
        id: ID.frontDeskAccount,
        login_identifier: 'abc-frontdesk',
        login_identifier_normalized: 'abc-frontdesk',
        display_name: 'Front Desk Staff',
        password_hash: '$2a$12$oldhashvaluehere123456789012345678901234567890123456',
        session_version: initialSessionVersion,
        failed_login_attempts: initialFailedAttempts,
        locked_until: initialLockedUntil,
        is_active: accountActive
      }
    ],
    memberships: [
      {
        id: ID.frontDeskMembership,
        shop_id: ID.shopA,
        owner_account_id: ID.frontDeskAccount,
        role,
        is_active: membershipActive
      }
    ],
    ownerSessions: [
      {
        id: 'sess-1',
        membership_id: ID.frontDeskMembership,
        shop_id: ID.shopA,
        revoked_at: null,
        revoke_reason: null
      },
      {
        id: 'sess-2',
        membership_id: ID.membershipA,
        shop_id: ID.shopA,
        revoked_at: null,
        revoke_reason: null
      }
    ],
    auditLogs: [],
    queries: []
  };

  const db = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      // 1. Transaction controls
      if (normalized === 'BEGIN') {
        accountBackup = JSON.parse(JSON.stringify(state.ownerAccounts));
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        if (accountBackup) {
          state.ownerAccounts = accountBackup;
          accountBackup = null;
        }
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        accountBackup = null;
        return { rows: [] };
      }
      if (normalized.startsWith('SET LOCAL')) {
        return { rows: [] };
      }

      // 2. Lookup membership, account, and shop for reset
      if (/FROM public\.owner_shop_memberships osm[\s\S]+?JOIN public\.owner_accounts oa[\s\S]+?JOIN public\.shops sh/i.test(normalized)) {
        const [membershipId, shopId] = params;
        const mem = state.memberships.find(m => m.id === membershipId && m.shop_id === shopId);
        if (!mem) return { rows: [] };
        const acc = state.ownerAccounts.find(a => a.id === mem.owner_account_id);
        if (!acc) return { rows: [] };

        return {
          rows: [{
            membership_id: mem.id,
            shop_id: mem.shop_id,
            role: mem.role,
            membership_active: mem.is_active,
            account_id: acc.id,
            login_identifier: acc.login_identifier,
            display_name: acc.display_name,
            account_active: acc.is_active,
            shop_status: shopActive ? 'active' : 'inactive'
          }]
        };
      }

      // 3. Update account on password reset
      if (/UPDATE public\.owner_accounts[\s\S]+?SET password_hash = \$1/i.test(normalized)) {
        const [passwordHash, accountId] = params;
        const acc = state.ownerAccounts.find(a => a.id === accountId);
        if (acc) {
          acc.password_hash = passwordHash;
          acc.session_version += 1;
          acc.failed_login_attempts = 0;
          acc.locked_until = null;
          acc.password_changed_at = new Date();
          return { rows: [{ id: acc.id }] };
        }
        return { rows: [] };
      }

      // 4. Revoke active owner sessions for membership
      if (/UPDATE public\.owner_sessions[\s\S]+?SET revoked_at = NOW\(\)/i.test(normalized)) {
        if (failAfterAccountUpdate) {
          throw new Error('Simulated mid-transaction failure after account update');
        }
        const [membershipId, shopId] = params;
        let count = 0;
        state.ownerSessions.forEach(s => {
          if (s.membership_id === membershipId && s.shop_id === shopId && !s.revoked_at) {
            s.revoked_at = new Date();
            s.revoke_reason = 'password_reset';
            count++;
          }
        });
        return { rows: [{ count }] };
      }

      // 5. Insert audit log
      if (/INSERT INTO public\.merchant_auth_audit/i.test(normalized)) {
        const [shop_id, event_type, target_type, target_id, operator_type, operator_id, metadata] = params;
        const parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        const row = {
          id: 'audit-' + (state.auditLogs.length + 1),
          shop_id,
          event_type,
          target_type,
          target_id,
          operator_type,
          operator_id,
          metadata: parsedMetadata
        };
        state.auditLogs.push(row);
        return { rows: [row] };
      }

      // 6. Owner auth session check
      if (/FROM owner_sessions/i.test(normalized)) {
        return { rows: [sessionRow(sessionRole)] };
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
// Unit Tests: Password Generation & Validation
// ==================================================

test('1. generateTemporaryPassword produces compliant, readable password', () => {
  for (let i = 0; i < 50; i++) {
    const pwd = generateTemporaryPassword(16);
    assert.equal(pwd.length, 16);
    // Has uppercase
    assert.match(pwd, /[A-HJ-NP-Z]/);
    // Has lowercase
    assert.match(pwd, /[a-km-z]/);
    // Has digit
    assert.match(pwd, /[2-9]/);
    // Has symbol
    assert.match(pwd, /[!@#$%&*+=\-?]/);
    // Excludes ambiguous characters (0, O, o, 1, l, I)
    assert.doesNotMatch(pwd, /[0Oo1lI]/);
  }

  // Minimum length clamp
  const clamped = generateTemporaryPassword(8);
  assert.equal(clamped.length, 16);
});

test('2. validateNewPassword enforces security boundaries and rejects invalid inputs', () => {
  // Missing or non-string
  assert.throws(
    () => validateNewPassword(null, null),
    err => err instanceof FrontDeskActivationError && err.code === 'INVALID_PASSWORD'
  );

  // Too short (< 16 chars)
  assert.throws(
    () => validateNewPassword('ShortPass123!', 'ShortPass123!'),
    err => err instanceof FrontDeskActivationError && err.code === 'PASSWORD_TOO_SHORT'
  );

  // Mismatch
  assert.throws(
    () => validateNewPassword('ValidPassword123456!', 'ValidPassword123456?'),
    err => err instanceof FrontDeskActivationError && err.code === 'PASSWORD_CONFIRMATION_MISMATCH'
  );

  // Too long (> 72 UTF-8 bytes)
  const longPass = 'A'.repeat(73);
  assert.throws(
    () => validateNewPassword(longPass, longPass),
    err => err instanceof FrontDeskActivationError && err.code === 'PASSWORD_TOO_LONG'
  );

  // Multi-byte overflow (> 72 bytes even if fewer chars)
  const multibyte = '密码'.repeat(25); // 50 chars * 3 bytes = 150 bytes
  assert.throws(
    () => validateNewPassword(multibyte, multibyte),
    err => err instanceof FrontDeskActivationError && err.code === 'PASSWORD_TOO_LONG'
  );

  // Valid password passes without error
  assert.doesNotThrow(() => {
    validateNewPassword('VerySecurePassw0rd!2026', 'VerySecurePassw0rd!2026');
  });
});

// ==================================================
// Unit Tests: Front Desk Password Reset Domain Logic
// ==================================================

test('3. resetFrontDeskPassword in auto mode generates temp password, increments session_version, clears lockout, revokes sessions, and audits without leaking password', async () => {
  const { db, state } = makeMockDb({
    initialSessionVersion: 3,
    initialFailedAttempts: 5,
    initialLockedUntil: new Date(Date.now() + 60000)
  });

  const res = await resetFrontDeskPassword(db, {
    shopId: ID.shopA,
    membershipId: ID.frontDeskMembership,
    operatorId: ID.ownerAccountA,
    mode: 'auto',
    clientIp: '127.0.0.1',
    userAgent: 'Mozilla/5.0 Test'
  });

  assert.equal(res.success, true);
  assert.equal(res.membershipId, ID.frontDeskMembership);
  assert.equal(res.accountId, ID.frontDeskAccount);
  assert.equal(res.loginIdentifier, 'abc-frontdesk');
  assert.equal(typeof res.temporaryPassword, 'string');
  assert.equal(res.temporaryPassword.length, 16);
  assert.equal(res.mustChangePassword, true);

  // Verify DB account state
  const account = state.ownerAccounts[0];
  assert.equal(account.session_version, 4); // incremented from 3
  assert.equal(account.failed_login_attempts, 0);
  assert.equal(account.locked_until, null);
  // Verify bcrypt hash matches the returned temporary password
  const matches = await bcrypt.compare(res.temporaryPassword, account.password_hash);
  assert.equal(matches, true);

  // Verify session revocation
  const fdSession = state.ownerSessions.find(s => s.membership_id === ID.frontDeskMembership);
  assert.notEqual(fdSession.revoked_at, null);
  assert.equal(fdSession.revoke_reason, 'password_reset');
  // Unrelated session untouched
  const ownerSession = state.ownerSessions.find(s => s.membership_id === ID.membershipA);
  assert.equal(ownerSession.revoked_at, null);

  // Verify audit log
  assert.equal(state.auditLogs.length, 1);
  const audit = state.auditLogs[0];
  assert.equal(audit.shop_id, ID.shopA);
  assert.equal(audit.event_type, 'front_desk_password_reset');
  assert.equal(audit.target_type, 'front_desk');
  assert.equal(audit.target_id, ID.frontDeskMembership);
  assert.equal(audit.operator_type, 'owner');
  assert.equal(audit.operator_id, ID.ownerAccountA);
  assert.equal(audit.metadata.reset_mode, 'auto');
  assert.equal(audit.metadata.login_identifier, 'abc-frontdesk');
  assert.equal(audit.metadata.ip, '127.0.0.1');

  // CRITICAL: Plaintext password must NOT appear in audit log metadata
  const auditStr = JSON.stringify(audit);
  assert.equal(auditStr.includes(res.temporaryPassword), false, 'Temporary password must not appear in audit trail');
});

test('4. resetFrontDeskPassword in manual mode hashes new password, invalidates sessions, and does not return temp password', async () => {
  const { db, state } = makeMockDb({
    initialSessionVersion: 1
  });

  const manualPassword = 'MySecretManualPassword123!';
  const res = await resetFrontDeskPassword(db, {
    shopId: ID.shopA,
    membershipId: ID.frontDeskMembership,
    operatorId: ID.ownerAccountA,
    mode: 'manual',
    newPassword: manualPassword,
    confirmPassword: manualPassword,
    clientIp: '10.0.0.1'
  });

  assert.equal(res.success, true);
  assert.equal(res.temporaryPassword, null);
  assert.equal(res.mustChangePassword, false);

  // Verify DB account state
  const account = state.ownerAccounts[0];
  assert.equal(account.session_version, 2);
  const matches = await bcrypt.compare(manualPassword, account.password_hash);
  assert.equal(matches, true);

  // Verify audit log does NOT contain the password
  assert.equal(state.auditLogs.length, 1);
  const audit = state.auditLogs[0];
  assert.equal(audit.metadata.reset_mode, 'manual');
  const auditStr = JSON.stringify(audit);
  assert.equal(auditStr.includes(manualPassword), false, 'Manual password must not appear in audit trail');
});

test('5. RBAC & Anti-escalation: only front_desk role accounts can be reset', async () => {
  // Test target is 'owner' role
  const { db } = makeMockDb({ role: 'owner' });

  await assert.rejects(
    () => resetFrontDeskPassword(db, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA,
      mode: 'auto'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'INVALID_TARGET_ROLE');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('6. Disabled accounts cannot be reset (fail closed)', async () => {
  // Inactive membership
  const { db: db1 } = makeMockDb({ membershipActive: false });
  await assert.rejects(
    () => resetFrontDeskPassword(db1, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA,
      mode: 'auto'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'ACCOUNT_DISABLED');
      assert.equal(err.status, 400);
      return true;
    }
  );

  // Inactive account
  const { db: db2 } = makeMockDb({ accountActive: false });
  await assert.rejects(
    () => resetFrontDeskPassword(db2, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA,
      mode: 'auto'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'ACCOUNT_DISABLED');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('7. Cross-tenant isolation: cannot reset membership of a different shop', async () => {
  const { db } = makeMockDb();

  await assert.rejects(
    () => resetFrontDeskPassword(db, {
      shopId: ID.shopB, // Shop B tries to reset Shop A's membership
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountB,
      mode: 'auto'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'MEMBERSHIP_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('8. Inactive shop fails closed', async () => {
  const { db } = makeMockDb({ shopActive: false });

  await assert.rejects(
    () => resetFrontDeskPassword(db, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA,
      mode: 'auto'
    }),
    err => {
      assert(err instanceof FrontDeskActivationError);
      assert.equal(err.code, 'SHOP_INACTIVE');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

// ==================================================
// End-to-End Route Tests
// ==================================================

test('9. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: unauthenticated returns 401', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: { mode: 'auto' },
      authenticated: false
    });
    assert.equal(res.status, 401);
  });
});

test('10. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: rejects invalid membership UUID', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, '/api/owner/team/front-desk/not-a-valid-uuid/password-reset', {
      method: 'POST',
      body: { mode: 'auto' }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_MEMBERSHIP_ID');
  });
});

test('11. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: authenticated owner succeeds with auto mode', async () => {
  const { db, state } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: { mode: 'auto' }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.data.temporaryPassword, 'string');
    assert.equal(body.data.temporaryPassword.length, 16);
    assert.equal(body.data.loginIdentifier, 'abc-frontdesk');
  });
});

test('12. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: authenticated owner succeeds with manual mode', async () => {
  const { db } = makeMockDb();
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const manualPass = 'BrandNewPassword2026!';
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: {
        mode: 'manual',
        newPassword: manualPass,
        confirmPassword: manualPass
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.temporaryPassword, null);
  });
});

test('13. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: returns 400 on disabled account', async () => {
  const { db } = makeMockDb({ membershipActive: false });
  app.locals.ownerAuthPool = db;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: { mode: 'auto' }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'ACCOUNT_DISABLED');
  });
});

test('14. HTTP POST /api/owner/team/front-desk/:membershipId/password-reset: unauthorized actor role (front_desk, staff) returns 403', async () => {
  // 1. Actor has front_desk role
  const { db: dbFd } = makeMockDb({ sessionRole: 'front_desk' });
  app.locals.ownerAuthPool = dbFd;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: { mode: 'auto' }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'PERMISSION_DENIED');
  });

  // 2. Actor has staff role
  const { db: dbStaff } = makeMockDb({ sessionRole: 'staff' });
  app.locals.ownerAuthPool = dbStaff;

  await withServer(async baseUrl => {
    const res = await send(baseUrl, `/api/owner/team/front-desk/${ID.frontDeskMembership}/password-reset`, {
      method: 'POST',
      body: { mode: 'auto' }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'PERMISSION_DENIED');
  });
});

test('15. Mid-transaction failure triggers ROLLBACK and leaves zero partial state', async () => {
  const { db, state } = makeMockDb({
    initialSessionVersion: 1,
    failAfterAccountUpdate: true
  });

  await assert.rejects(
    () => resetFrontDeskPassword(db, {
      shopId: ID.shopA,
      membershipId: ID.frontDeskMembership,
      operatorId: ID.ownerAccountA,
      mode: 'auto'
    }),
    err => {
      assert.equal(err.message, 'Simulated mid-transaction failure after account update');
      return true;
    }
  );

  // Verify ROLLBACK was executed
  const hasRollback = state.queries.some(q => q.sql === 'ROLLBACK');
  assert.equal(hasRollback, true, 'ROLLBACK must be executed upon mid-transaction error');

  // Verify COMMIT was never executed
  const hasCommit = state.queries.some(q => q.sql === 'COMMIT');
  assert.equal(hasCommit, false, 'COMMIT must NOT be executed upon mid-transaction error');

  // Verify no audit log was committed
  assert.equal(state.auditLogs.length, 0, 'No audit record must be recorded on rollback');

  // Verify account state was not permanently mutated (rolled back)
  assert.equal(state.ownerAccounts[0].session_version, 1, 'session_version must remain untouched');
});
