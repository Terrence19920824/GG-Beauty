'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MIN_TOKEN_BYTES,
  SHA256_HEX_LENGTH,
  generateToken,
  hashToken,
  validateTokenFormat,
  validateTokenHashFormat,
  timingSafeEqualHashes
} = require('../lib/invitation-token');

const {
  createMerchantInvitation,
  findInvitation,
  revokeInvitation,
  MerchantInvitationError,
  DEFAULT_INVITATION_TTL_DAYS
} = require('../lib/merchant-invitation');

const CLI_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'generate-merchant-invitation.js');

test('1. token entropy/generation - generates secure tokens with at least 256 bits entropy', () => {
  const token = generateToken();
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64, 'Default 32 bytes yields 64 hex characters (256 bits)');
  assert.match(token, /^[0-9a-f]{64}$/, 'Must be lowercase hex string');

  // Verify entropy uniqueness across multiple calls
  const set = new Set();
  for (let i = 0; i < 50; i++) {
    set.add(generateToken());
  }
  assert.equal(set.size, 50, 'All 50 generated tokens must be distinct');

  // Rejects insufficient byte length
  assert.throws(
    () => generateToken(16),
    /Token entropy must be at least 32 bytes/,
    'Must reject byte length < 32'
  );
  assert.throws(
    () => generateToken('32'),
    /Token entropy must be at least 32 bytes/,
    'Must reject non-number byte length'
  );

  // Hash generation
  const hash = hashToken(token);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, SHA256_HEX_LENGTH, 'SHA-256 hash must be 64 characters');
  assert.match(hash, /^[0-9a-f]{64}$/, 'Hash must be lowercase hex');

  // Hash validation helpers
  assert.equal(validateTokenFormat(token), true);
  assert.equal(validateTokenFormat('short'), false);
  assert.equal(validateTokenHashFormat(hash), true);
  assert.equal(validateTokenHashFormat('not-a-hash'), false);

  // Timing-safe comparison
  assert.equal(timingSafeEqualHashes(hash, hash), true);
  const otherHash = hashToken(generateToken());
  assert.equal(timingSafeEqualHashes(hash, otherHash), false);
  assert.equal(timingSafeEqualHashes(hash, 'invalid-length'), false);
});

test('2 & 3. only token hash persisted - raw plaintext token is never stored in DB', async () => {
  const capturedQueries = [];

  const mockDb = {
    query: async (sql, params) => {
      capturedQueries.push({ sql, params });
      return {
        rows: [{
          id: 'test-invitation-uuid-1',
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 86400000),
          created_at: new Date()
        }]
      };
    }
  };

  const result = await createMerchantInvitation(mockDb, {
    merchantNameHint: 'Test Salon',
    contactEmail: 'owner@testsalon.com',
    contactPhone: '+65 9123 4567',
    baseUrl: 'https://app.gg-beauty.com'
  });

  assert.equal(capturedQueries.length, 1, 'Exactly one query must be executed');
  const { sql, params } = capturedQueries[0];

  assert.match(sql, /INSERT INTO public\.merchant_onboarding_invitations/i);
  assert.equal(params[0], result.tokenHash, 'First parameter must be token_hash');
  assert.equal(result.tokenHash.length, 64);

  // CRITICAL SECURITY ASSERTION:
  // The raw token must NEVER appear in the SQL query string or parameters
  assert.doesNotMatch(sql, new RegExp(result.rawToken), 'Raw token must not appear in SQL text');
  for (const param of params) {
    if (typeof param === 'string') {
      assert.notEqual(param, result.rawToken, 'No parameter may equal the raw token');
      assert.ok(!param.includes(result.rawToken), 'No parameter may contain the raw token');
    }
  }

  // The returned raw token is present in the return object for deliberate display
  assert.equal(typeof result.rawToken, 'string');
  assert.notEqual(result.rawToken, result.tokenHash);
  assert.ok(result.onboardingUrl.includes(result.rawToken));
  assert.equal(result.merchantNameHint, 'Test Salon');
  assert.equal(result.contactEmail, 'owner@testsalon.com');
  assert.equal(result.contactPhone, '+65 9123 4567');
});

test('4. invitation expiry - correctly calculates and enforces expiration', async () => {
  // Safe bounds validation
  const mockDb = { query: async () => ({ rows: [{ id: 'u', status: 'pending', expires_at: new Date(), created_at: new Date() }] }) };

  await assert.rejects(
    () => createMerchantInvitation(mockDb, { ttlDays: 0 }),
    /ttlDays must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createMerchantInvitation(mockDb, { ttlDays: 31 }),
    /ttlDays must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createMerchantInvitation(mockDb, { ttlDays: 'invalid' }),
    /ttlDays must be an integer between 1 and 30/
  );

  // Custom TTL sets expiration date accordingly
  let recordedExpiresAt;
  const mockDbCapture = {
    query: async (sql, params) => {
      recordedExpiresAt = params[1];
      return { rows: [{ id: 'u2', status: 'pending', expires_at: recordedExpiresAt, created_at: new Date() }] };
    }
  };

  const beforeTime = Date.now() + 14 * 86400000;
  await createMerchantInvitation(mockDbCapture, { ttlDays: 14 });
  const afterTime = Date.now() + 14 * 86400000;

  assert.ok(recordedExpiresAt.getTime() >= beforeTime - 1000);
  assert.ok(recordedExpiresAt.getTime() <= afterTime + 1000);

  // findInvitation computes effective status = 'expired' when past expires_at
  const expiredPastDate = new Date(Date.now() - 3600000); // 1 hour ago
  const lookupDb = {
    query: async () => ({
      rows: [{
        id: 'expired-invite-uuid',
        token_hash: 'a'.repeat(64),
        status: 'pending',
        expires_at: expiredPastDate,
        consumed_at: null,
        revoked_at: null,
        resulting_shop_id: null,
        merchant_name_hint: null,
        contact_email: null,
        contact_phone: null,
        created_by: 'platform_cli',
        created_at: new Date(),
        updated_at: new Date()
      }]
    })
  };

  const found = await findInvitation(lookupDb, 'a'.repeat(64), { isHash: true });
  assert.ok(found);
  assert.equal(found.status, 'expired', 'Status must be computed as expired');
  assert.equal(found.rawStatus, 'pending');
  assert.equal(found.isValid, false, 'Expired invitation must not be valid');
});

test('5. invitation lifecycle constraints - status transitions and revocation', async () => {
  let updatedSql = '';
  let updatedParams = [];

  const mockDb = {
    query: async (sql, params) => {
      updatedSql = sql;
      updatedParams = params;
      return { rowCount: 1 };
    }
  };

  const revoked = await revokeInvitation(mockDb, 'some-invite-id');
  assert.equal(revoked, true);
  assert.match(updatedSql, /UPDATE public\.merchant_onboarding_invitations/i);
  assert.match(updatedSql, /SET status = 'revoked'/i);
  assert.match(updatedSql, /WHERE id = \$1 AND status = 'pending'/i);
  assert.deepEqual(updatedParams, ['some-invite-id']);

  // Revoke when row not pending returns false
  const mockDbNoop = { query: async () => ({ rowCount: 0 }) };
  const notRevoked = await revokeInvitation(mockDbNoop, 'already-consumed-id');
  assert.equal(notRevoked, false);
});

test('6 & 7. invitation generation does NOT create shop or Owner accounts', async () => {
  const executedTables = [];

  const auditDb = {
    query: async (sql) => {
      if (/FROM\s+([a-zA-Z0-9_.]+)|INSERT\s+INTO\s+([a-zA-Z0-9_.]+)/i.test(sql)) {
        const match = sql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_.]+)/i);
        if (match) executedTables.push(match[1]);
      }
      return {
        rows: [{
          id: 'invitation-id',
          status: 'pending',
          expires_at: new Date(),
          created_at: new Date()
        }]
      };
    }
  };

  await createMerchantInvitation(auditDb, { merchantNameHint: 'Solo Nails' });

  // Verify only merchant_onboarding_invitations was targeted
  assert.deepEqual(executedTables, ['public.merchant_onboarding_invitations']);

  // Strictly verify NO shop was inserted
  assert.ok(!executedTables.some(t => t.includes('shops')), 'No shops table insert allowed');

  // Strictly verify NO owner account was inserted
  assert.ok(!executedTables.some(t => t.includes('owner_accounts')), 'No owner_accounts insert allowed');
  assert.ok(!executedTables.some(t => t.includes('owner_shop_memberships')), 'No owner_shop_memberships insert allowed');
  assert.ok(!executedTables.some(t => t.includes('owner_sessions')), 'No owner_sessions insert allowed');
});

test('8. duplicate token hash protection - handles collision error gracefully', async () => {
  const collisionDb = {
    query: async () => {
      const err = new Error('duplicate key value violates unique constraint "merchant_onboarding_invitations_token_hash_key"');
      err.code = '23505';
      throw err;
    }
  };

  await assert.rejects(
    () => createMerchantInvitation(collisionDb),
    (err) => err.code === '23505'
  );
});

test('CLI generate-merchant-invitation.js behavior and help output', () => {
  // --help output
  const helpResult = spawnSync(process.execPath, [CLI_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(helpResult.status, 0);
  assert.ok(helpResult.stdout.includes('Usage: node scripts/generate-merchant-invitation.js'));
  assert.ok(helpResult.stdout.includes('--ttl-days'));
  assert.ok(helpResult.stdout.includes('The database stores ONLY the SHA-256 token hash'));

  // Missing DATABASE_URL fails with exit code 1
  const missingDb = spawnSync(process.execPath, [CLI_SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH } // explicitly omit DATABASE_URL
  });
  assert.equal(missingDb.status, 1);
  assert.ok(missingDb.stderr.includes('DATABASE_URL environment variable is required'));

  // Invalid ttl-days fails with exit code 1
  const invalidTtl = spawnSync(process.execPath, [CLI_SCRIPT, '--ttl-days', '99'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://localhost:5432/dummy' }
  });
  assert.equal(invalidTtl.status, 1);
  assert.ok(invalidTtl.stderr.includes('--ttl-days must be an integer between 1 and 30'));
});
