'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const preflightSql = fs.readFileSync(
  path.join(root, 'migrations/104_staff_front_desk_activation_preflight_readonly.sql'),
  'utf8'
);
const schemaSql = fs.readFileSync(
  path.join(root, 'migrations/105_staff_front_desk_activation_schema.sql'),
  'utf8'
);
const verifySql = fs.readFileSync(
  path.join(root, 'migrations/106_staff_front_desk_activation_verification_readonly.sql'),
  'utf8'
);
const rollbackSql = fs.readFileSync(
  path.join(root, 'migrations/rollback/105_staff_front_desk_activation_rollback.sql'),
  'utf8'
);

test('migration 104 preflight readonly script syntax and prerequisites', () => {
  assert.match(preflightSql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(preflightSql, /public\.shops/);
  assert.match(preflightSql, /public\.staff/);
  assert.match(preflightSql, /public\.staff_accounts/);
  assert.match(preflightSql, /public\.staff_location_assignments/);
  assert.match(preflightSql, /public\.owner_accounts/);
  assert.match(preflightSql, /public\.owner_shop_memberships/);
  assert.match(preflightSql, /staff_shop_id_id_uidx/);
  assert.match(preflightSql, /public\.staff_activation_invitations/);
  assert.match(preflightSql, /public\.front_desk_invitations/);
  assert.match(preflightSql, /public\.merchant_auth_audit/);
  assert.match(preflightSql, /COMMIT/i);
});

test('migration 105 additive schema syntax, constraints, and indexes', () => {
  assert.match(schemaSql, /BEGIN;/i);
  assert.match(schemaSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(schemaSql, /SET LOCAL statement_timeout = '30s'/);

  // 1. Staff activation invitations
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.staff_activation_invitations/i);
  assert.match(schemaSql, /CONSTRAINT staff_activation_invitations_shop_staff_fkey/i);
  assert.match(schemaSql, /FOREIGN KEY \(shop_id, staff_id\)\s+REFERENCES public\.staff \(shop_id, id\)\s+ON DELETE RESTRICT/i);
  assert.match(schemaSql, /CONSTRAINT staff_activation_invitations_token_hash_key\s+UNIQUE \(token_hash\)/i);
  assert.match(schemaSql, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(schemaSql, /CHECK \(status IN \('pending', 'consumed', 'revoked', 'expired'\)\)/i);
  assert.match(schemaSql, /CREATE UNIQUE INDEX IF NOT EXISTS staff_activation_invitations_pending_uidx/i);

  // 2. Front desk invitations
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.front_desk_invitations/i);
  assert.match(schemaSql, /CONSTRAINT front_desk_invitations_role_check\s+CHECK \(role = 'front_desk'\)/i);
  assert.match(schemaSql, /CONSTRAINT front_desk_invitations_token_hash_key\s+UNIQUE \(token_hash\)/i);
  assert.match(schemaSql, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(schemaSql, /CHECK \(status IN \('pending', 'consumed', 'revoked', 'expired'\)\)/i);

  // 3. Merchant auth audit
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.merchant_auth_audit/i);
  assert.match(schemaSql, /CONSTRAINT merchant_auth_audit_event_check/i);
  assert.match(schemaSql, /reject_merchant_auth_audit_mutation/i);
  assert.match(schemaSql, /CREATE TRIGGER merchant_auth_audit_immutable/i);
  assert.match(schemaSql, /BEFORE UPDATE OR DELETE ON public\.merchant_auth_audit/i);

  assert.match(schemaSql, /COMMIT;/i);
});

test('migration 106 strict read-only verification checks', () => {
  assert.match(verifySql, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(verifySql, /public\.staff_activation_invitations/);
  assert.match(verifySql, /public\.front_desk_invitations/);
  assert.match(verifySql, /public\.merchant_auth_audit/);

  // Strict constraint def checks
  assert.match(verifySql, /staff_activation_invitations_shop_staff_fkey/);
  assert.match(verifySql, /staff_activation_invitations_pending_uidx/);
  assert.match(verifySql, /front_desk_invitations_role_check/);
  assert.match(verifySql, /merchant_auth_audit_immutable/);
  assert.match(verifySql, /reject_merchant_auth_audit_mutation/);
  assert.match(verifySql, /COMMIT/i);
});

test('migration rollback 105 fail-closed safety and lock ordering', () => {
  assert.match(rollbackSql, /BEGIN;/i);
  assert.match(rollbackSql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(rollbackSql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(rollbackSql, /LOCK TABLE public\.staff_activation_invitations IN SHARE MODE/i);
  assert.match(rollbackSql, /LOCK TABLE public\.front_desk_invitations IN SHARE MODE/i);
  assert.match(rollbackSql, /LOCK TABLE public\.merchant_auth_audit IN SHARE MODE/i);

  // Lock must be before row existence checks
  const lockIndex = rollbackSql.search(/LOCK TABLE public\.staff_activation_invitations/i);
  const guardIndex = rollbackSql.search(/SELECT EXISTS \(SELECT 1 FROM public\.staff_activation_invitations\)/i);
  const raiseIndex = rollbackSql.search(/RAISE EXCEPTION 'Activation rollback blocked/i);
  const dropIndex = rollbackSql.search(/DROP TABLE IF EXISTS public\.staff_activation_invitations/i);

  assert.ok(lockIndex < guardIndex, 'Lock acquisition must precede row existence check');
  assert.ok(guardIndex < raiseIndex, 'Row existence check must precede fail-closed exception');
  assert.ok(raiseIndex < dropIndex, 'Fail-closed exception must precede table drop');

  assert.doesNotMatch(rollbackSql, /\bDELETE\s+FROM\s+(?:ONLY\s+)?public\./i, 'Rollback must never contain DELETE FROM public.*');
  assert.doesNotMatch(rollbackSql, /\bTRUNCATE(?:\s+TABLE)?\s+(?:ONLY\s+)?public\./i, 'Rollback must never contain TRUNCATE TABLE public.*');
});
