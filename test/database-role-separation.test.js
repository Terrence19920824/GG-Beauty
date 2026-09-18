'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const migration = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');

test('053-055 database role separation migration chain is strictly bounded and follows least-privilege', () => {
  const sql053 = migration('053_database_role_preflight_readonly.sql');
  const sql054 = migration('054_database_role_acl_foundation.sql');
  const sql055 = migration('055_database_role_verification_readonly.sql');

  // 1. Static security check: NO passwords in migrations
  for (const [name, content] of [['053', sql053], ['054', sql054], ['055', sql055]]) {
    assert.doesNotMatch(content, /PASSWORD\s+['"][^'"]+['"]/i, `${name} contains hardcoded password`);
  }

  // 2. 053 Preflight is strictly read-only and checks all 35 baseline tables
  assert.match(sql053, /^BEGIN TRANSACTION READ ONLY;/m);
  assert.match(sql053, /^COMMIT;/m);
  assert.match(sql053, /v_expected_tables text\[\] := ARRAY\[/);
  assert.match(sql053, /'checkout_financial_audit'/);
  assert.doesNotMatch(sql053, /\b(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|CREATE TABLE)\b/i);

  // 3. 054 Defines exact roles with NOINHERIT and unprivileged bounds
  assert.match(sql054, /^BEGIN;/m);
  assert.match(sql054, /^COMMIT;/m);
  assert.match(sql054, /CREATE ROLE gg_migration_owner WITH NOLOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql054, /CREATE ROLE gg_app_runtime WITH LOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql054, /CREATE ROLE gg_app_onboarding WITH LOGIN NOINHERIT NOSUPERUSER/);

  // 4. Timeouts enforced across all migrations
  assert.match(sql053, /SET LOCAL lock_timeout\s*=\s*'5s'/);
  assert.match(sql053, /SET LOCAL statement_timeout\s*=\s*'30s'/);
  assert.match(sql054, /SET LOCAL lock_timeout\s*=\s*'5s'/);
  assert.match(sql054, /SET LOCAL statement_timeout\s*=\s*'30s'/);
  assert.match(sql055, /SET LOCAL lock_timeout\s*=\s*'5s'/);
  assert.match(sql055, /SET LOCAL statement_timeout\s*=\s*'30s'/);

  // 5. Explicit whitelist used: NO wildcards over pg_class or pg_proc in 054
  assert.doesNotMatch(sql054, /FROM pg_class/);
  assert.doesNotMatch(sql054, /FROM pg_proc/);
  assert.doesNotMatch(sql054, /REVOKE ALL ON ALL FUNCTIONS/);

  // 6. Schema and database boundaries
  assert.match(sql054, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
  assert.match(sql054, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(sql054, /GRANT USAGE ON SCHEMA public TO gg_app_runtime, gg_app_onboarding/);
  assert.match(sql054, /REVOKE TEMP ON DATABASE/);

  // 7. Refined least-privilege table and column permissions
  // (a) Translation column-level UPDATE
  assert.match(sql054, /GRANT UPDATE \(name, description, updated_at\) ON public\.service_translations TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(name, updated_at\) ON public\.service_category_translations TO gg_app_runtime;/);
  // (b) Assignment schedule sync column-level UPDATE
  assert.match(sql054, /GRANT UPDATE \(start_at, end_at, blocks_time, updated_at\) ON public\.appointment_item_staff_assignments TO gg_app_runtime;/);
  // (c) appointment_time_change_history SELECT for INSERT RETURNING
  assert.match(sql054, /GRANT SELECT, INSERT ON public\.appointment_time_change_history TO gg_app_runtime;/);
  // (d) Excess privileges removed
  assert.doesNotMatch(sql054, /GRANT[^;]*INSERT[^;]*ON public\.staff_accounts/);
  assert.doesNotMatch(sql054, /GRANT[^;]*INSERT[^;]*ON public\.shop_member_code_counters/);
  assert.doesNotMatch(sql054, /GRANT[^;]*ON public\.checkout_staff_attributions/);

  // 8. Row locking UPDATE(id) permissions and lock guard triggers
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.shops TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.owner_shop_memberships TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.locations TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.checkout_transactions TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.shops TO gg_app_onboarding;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.owner_accounts TO gg_app_onboarding;/);

  assert.match(sql054, /CREATE TRIGGER reject_shops_actual_update/);
  assert.match(sql054, /CREATE TRIGGER reject_locations_actual_update/);
  assert.match(sql054, /CREATE TRIGGER reject_checkout_transactions_actual_update/);
  assert.match(sql054, /CREATE TRIGGER reject_owner_shop_memberships_actual_update/);
  assert.match(sql054, /CREATE TRIGGER reject_owner_accounts_actual_update/);
  assert.match(sql054, /REVOKE ALL ON FUNCTION public\.reject_locked_lookup_actual_update\(\) FROM PUBLIC, gg_app_runtime, gg_app_onboarding;/);

  // 9. Default privileges under genuine gg_migration_owner role
  assert.match(sql054, /SET ROLE gg_migration_owner;/);
  assert.match(sql054, /ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;/);
  assert.match(sql054, /ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public/);

  // 10. 055 Verification validates boundaries
  assert.match(sql055, /^BEGIN TRANSACTION READ ONLY;/m);
  assert.match(sql055, /^COMMIT;/m);
  assert.match(sql055, /WITH RECURSIVE member_graph/);
  assert.match(sql055, /has_table_privilege\('gg_app_runtime', c\.oid, 'DELETE'\)/);
  assert.match(sql055, /has_table_privilege\('gg_app_runtime', c\.oid, 'TRUNCATE'\)/);
  assert.match(sql055, /has_column_privilege\('gg_app_runtime', 'public\.service_translations', 'name', 'UPDATE'\)/);
  assert.match(sql055, /tgenabled = 'O'/);
});
