'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const preflightSql = fs.readFileSync(
  path.join(root, 'migrations/098_merchant_onboarding_invitation_preflight_readonly.sql'),
  'utf8'
);
const schemaSql = fs.readFileSync(
  path.join(root, 'migrations/099_merchant_onboarding_invitation_schema.sql'),
  'utf8'
);
const verifySql = fs.readFileSync(
  path.join(root, 'migrations/100_merchant_onboarding_invitation_verification_readonly.sql'),
  'utf8'
);
const rollbackSql = fs.readFileSync(
  path.join(root, 'migrations/rollback/099_merchant_onboarding_invitation_rollback.sql'),
  'utf8'
);

test('12. migration files structure and syntax validation', () => {
  // Preflight 098 checks
  assert.match(preflightSql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(preflightSql, /public\.shops/);
  assert.match(preflightSql, /public\.merchant_onboarding_invitations/);
  assert.match(preflightSql, /COMMIT/i);

  // Schema 099 checks
  assert.match(schemaSql, /BEGIN;/i);
  assert.match(schemaSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(schemaSql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.merchant_onboarding_invitations/i);
  assert.match(schemaSql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(schemaSql, /token_hash TEXT NOT NULL/);
  assert.match(schemaSql, /status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(schemaSql, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(schemaSql, /consumed_at TIMESTAMPTZ/);
  assert.match(schemaSql, /revoked_at TIMESTAMPTZ/);
  assert.match(schemaSql, /resulting_shop_id UUID/);
  assert.match(schemaSql, /merchant_name_hint TEXT/);
  assert.match(schemaSql, /contact_email TEXT/);
  assert.match(schemaSql, /contact_phone TEXT/);
  assert.match(schemaSql, /created_by TEXT NOT NULL DEFAULT 'platform_cli'/);
  assert.match(schemaSql, /consumed_ip TEXT/);
  assert.match(schemaSql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(schemaSql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);

  // Check constraints and foreign keys
  assert.match(schemaSql, /CONSTRAINT merchant_onboarding_invitations_token_hash_key\s+UNIQUE \(token_hash\)/i);
  assert.match(schemaSql, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(schemaSql, /CHECK \(status IN \('pending', 'consumed', 'revoked', 'expired'\)\)/i);
  assert.match(schemaSql, /FOREIGN KEY \(resulting_shop_id\)\s+REFERENCES public\.shops \(id\)\s+ON DELETE SET NULL/i);

  // Indexes
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_status_expires_idx/i);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_resulting_shop_idx/i);
  assert.match(schemaSql, /COMMIT;/i);

  // Verification 100 checks
  assert.match(verifySql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(verifySql, /merchant_onboarding_invitations_status_check/);
  assert.match(verifySql, /merchant_onboarding_invitations_token_hash_key/);
  assert.match(verifySql, /merchant_onboarding_invitations_resulting_shop_fkey/);
  assert.match(verifySql, /COMMIT/i);

  // Rollback 099 checks
  assert.match(rollbackSql, /BEGIN;/i);
  assert.match(rollbackSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(rollbackSql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(rollbackSql, /DROP TABLE IF EXISTS public\.merchant_onboarding_invitations CASCADE/i);
  assert.doesNotMatch(rollbackSql, /DROP TABLE.*shops/i, 'Rollback must never drop shops table');
  assert.match(rollbackSql, /COMMIT;/i);
});

test('Migration numbering continuity verification', () => {
  const migrationsDir = path.join(root, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => /^\d{3}_/.test(f)).sort();

  const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
  const maxNumber = Math.max(...numbers);

  assert.equal(maxNumber, 100, 'Highest migration number must now be 100');
  assert.ok(files.includes('098_merchant_onboarding_invitation_preflight_readonly.sql'));
  assert.ok(files.includes('099_merchant_onboarding_invitation_schema.sql'));
  assert.ok(files.includes('100_merchant_onboarding_invitation_verification_readonly.sql'));

  const rollbackFiles = fs.readdirSync(path.join(migrationsDir, 'rollback'));
  assert.ok(rollbackFiles.includes('099_merchant_onboarding_invitation_rollback.sql'));
});
