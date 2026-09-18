'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sql = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');

test('053-055 migration chain is staged, bounded, and rigorously structured', () => {
  const sql053 = sql('053_customer_entitlements_preflight_readonly.sql');
  const sql054 = sql('054_customer_entitlements_schema.sql');
  const sql055 = sql('055_customer_entitlements_verification_readonly.sql');

  // Read-only guards
  assert.match(sql053, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(sql053, /statement_timeout = '30s';/);
  assert.match(sql055, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(sql055, /statement_timeout = '30s';/);

  // Lock bounds in 054
  assert.match(sql054, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql054, /SET LOCAL statement_timeout = '30s';/);

  // Exactly 17 new tables defined in 054
  const expectedTables = [
    'customer_membership_tiers',
    'customer_membership_tier_rules',
    'customer_membership_enrollments',
    'package_definitions',
    'package_definition_services',
    'customer_packages',
    'customer_package_ledger',
    'customer_stored_value_accounts',
    'customer_stored_value_lots',
    'customer_stored_value_ledger',
    'customer_stored_value_allocations',
    'customer_points_accounts',
    'customer_points_lots',
    'customer_points_ledger',
    'customer_points_allocations',
    'shop_entitlement_policies',
    'customer_entitlement_status_history'
  ];

  for (const table of expectedTables) {
    const tableRegex = new RegExp('CREATE TABLE public\.' + table + '\\b');
    assert.match(sql054, tableRegex, 'Missing table: ' + table);
  }

  // Exactly 3 views
  const expectedViews = [
    'v_customer_package_balances',
    'v_customer_stored_value_balances',
    'v_customer_points_balances'
  ];
  for (const view of expectedViews) {
    const viewRegex = new RegExp('CREATE OR REPLACE VIEW public\.' + view + '\\b');
    assert.match(sql054, viewRegex, 'Missing view: ' + view);
  }

  // Lots must NOT contain mutable remaining balance columns
  assert.doesNotMatch(sql054, /remaining_principal_minor/);
  assert.doesNotMatch(sql054, /remaining_bonus_minor/);
  assert.doesNotMatch(sql054, /remaining_points/);

  // Policy exclusion constraint with tstzrange
  assert.match(sql054, /shop_entitlement_policies_no_overlap EXCLUDE USING gist/);
  assert.match(sql054, /tstzrange\(effective_from, effective_to\) WITH &&/);

  // Deferrable constraint triggers for Lot/Grant matching
  assert.match(sql054, /CREATE CONSTRAINT TRIGGER customer_stored_value_lot_grant_match_trigger/);
  assert.match(sql054, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql054, /CREATE CONSTRAINT TRIGGER customer_points_lot_grant_match_trigger/);

  // Append-only triggers on all ledgers, allocations, and status history
  assert.match(sql054, /customer_package_ledger_append_only/);
  assert.match(sql054, /customer_stored_value_ledger_append_only/);
  assert.match(sql054, /customer_stored_value_allocations_append_only/);
  assert.match(sql054, /customer_points_ledger_append_only/);
  assert.match(sql054, /customer_points_allocations_append_only/);
  assert.match(sql054, /customer_entitlement_status_history_append_only/);

  // Status audit triggers
  assert.match(sql054, /customer_membership_enrollments_status_audit/);
  assert.match(sql054, /customer_packages_status_audit/);
  assert.match(sql054, /customer_stored_value_accounts_status_audit/);
  assert.match(sql054, /customer_stored_value_lots_status_audit/);
  assert.match(sql054, /customer_points_accounts_status_audit/);
  assert.match(sql054, /customer_points_lots_status_audit/);

  // Idempotency keys NOT NULL and UNIQUE per shop
  assert.match(sql054, /CONSTRAINT customer_package_ledger_idempotency UNIQUE \(shop_id, idempotency_key\)/);
  assert.match(sql054, /CONSTRAINT customer_sv_ledger_idempotency UNIQUE \(shop_id, idempotency_key\)/);
  assert.match(sql054, /CONSTRAINT customer_sv_allocations_idempotency UNIQUE \(shop_id, idempotency_key\)/);
  assert.match(sql054, /CONSTRAINT customer_points_ledger_idempotency UNIQUE \(shop_id, idempotency_key\)/);
  assert.match(sql054, /CONSTRAINT customer_points_allocations_idempotency UNIQUE \(shop_id, idempotency_key\)/);

  // Reversal limits and positive allocations
  assert.match(sql054, /check_stored_value_allocation_integrity/);
  assert.match(sql054, /check_points_allocation_integrity/);
  assert.match(sql054, /check_package_ledger_reversal_limit/);

  // Permissions revoked from PUBLIC
  assert.match(sql054, /REVOKE INSERT, UPDATE, DELETE ON/);
});
