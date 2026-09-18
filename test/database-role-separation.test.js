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
  assert.match(sql053, /v_expected_tables text\[\] := ARRAY\[/);
  assert.match(sql053, /'checkout_financial_audit'/);
  assert.doesNotMatch(sql053, /\b(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|CREATE TABLE)\b/i);

  // 3. 054 Defines exact roles with NOINHERIT and unprivileged bounds
  assert.match(sql054, /CREATE ROLE gg_migration_owner WITH NOLOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql054, /CREATE ROLE gg_app_runtime WITH LOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql054, /CREATE ROLE gg_app_onboarding WITH LOGIN NOINHERIT NOSUPERUSER/);

  // 4. Timeouts enforced
  assert.match(sql054, /SET LOCAL lock_timeout\s*=\s*'5s'/);
  assert.match(sql054, /SET LOCAL statement_timeout\s*=\s*'30s'/);

  // 5. Explicit revoke on PUBLIC
  assert.match(sql054, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
  assert.match(sql054, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(sql054, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC/);
  assert.match(sql054, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);

  // 6. USAGE only on schema public for runtime and onboarding
  assert.match(sql054, /GRANT USAGE ON SCHEMA public TO gg_app_runtime, gg_app_onboarding/);

  // 7. Locking lookups UPDATE(id) with reject update triggers
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.checkout_transactions TO gg_app_runtime;/);
  assert.match(sql054, /GRANT UPDATE \(id\) ON public\.locations TO gg_app_runtime;/);
  assert.match(sql054, /CREATE TRIGGER reject_locations_actual_update/);
  assert.match(sql054, /CREATE TRIGGER reject_checkout_transactions_actual_update/);

  // 8. Onboarding isolation (shops FOR SHARE is SELECT only, NO UPDATE)
  assert.match(sql054, /GRANT SELECT ON public\.shops TO gg_app_onboarding;/);
  assert.doesNotMatch(sql054, /GRANT UPDATE ON public\.shops TO gg_app_onboarding/);
  assert.match(sql054, /GRANT SELECT, INSERT ON public\.owner_accounts, public\.owner_shop_memberships TO gg_app_onboarding;/);

  // 9. Default privileges bound to gg_migration_owner
  assert.match(sql054, /ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public/);

  // 10. 055 Verification validates boundaries
  assert.match(sql055, /v_role_rec\.rolcanlogin/);
  assert.match(sql055, /has_table_privilege\('gg_app_runtime', c\.oid, 'DELETE'\)/);
  assert.match(sql055, /has_table_privilege\('gg_app_runtime', c\.oid, 'TRUNCATE'\)/);
});
