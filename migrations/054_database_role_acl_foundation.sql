-- GG-Beauty Database Role Separation Foundation (054)
-- Establishes least-privilege roles (gg_migration_owner, gg_app_runtime, gg_app_onboarding)
-- and granular table/column ACLs without setting passwords in source code.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Create unprivileged roles without hardcoded passwords
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gg_migration_owner') THEN
    CREATE ROLE gg_migration_owner WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  ELSE
    ALTER ROLE gg_migration_owner WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gg_app_runtime') THEN
    CREATE ROLE gg_app_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  ELSE
    ALTER ROLE gg_app_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gg_app_onboarding') THEN
    CREATE ROLE gg_app_onboarding WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  ELSE
    ALTER ROLE gg_app_onboarding WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- 2. Allow administrative sessions to SET ROLE to gg_migration_owner
-- Runtime and onboarding roles are strictly excluded from role membership
DO $$
BEGIN
  EXECUTE format('GRANT gg_migration_owner TO %I;', current_user);
END $$;

-- 3. Reassign ownership of repository baseline tables and functions to gg_migration_owner
-- Strictly uses static whitelists: never loops over pg_class or pg_proc wildcards
DO $$
DECLARE
  v_table_name text;
  v_func_sig text;
  v_expected_tables text[] := ARRAY[
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services',
    'staff_services',
    'staff_accounts',
    'staff_location_assignments',
    'staff_sessions',
    'staff_permissions',
    'staff_location_working_hours',
    'staff_schedule_overrides',
    'appointment_time_change_history',
    'appointment_items',
    'appointment_item_staff_assignments',
    'owner_accounts',
    'owner_shop_memberships',
    'owner_sessions',
    'service_translations',
    'service_categories',
    'service_category_translations',
    'shop_customer_settings',
    'shop_member_code_counters',
    'customer_phone_identities',
    'customer_otp_challenges',
    'customer_sessions',
    'customer_identity_audit',
    'appointment_status_history',
    'checkout_transactions',
    'checkout_line_items',
    'checkout_payments',
    'checkout_staff_attributions',
    'checkout_financial_audit'
  ];
  v_expected_functions text[] := ARRAY[
    'assignment_collision_project()',
    'assignment_collision_sync_item_time()',
    'assignment_collision_sync_parent_state()',
    'assignment_collision_consistency_check()',
    'sync_appointment_customer_parties()',
    'provision_shop_customer_identity()',
    'assign_customer_member_code()',
    'reject_appointment_status_history_mutation()',
    'reject_checkout_financial_audit_mutation()'
  ];
BEGIN
  FOREACH v_table_name IN ARRAY v_expected_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO gg_migration_owner;', v_table_name);
    END IF;
  END LOOP;

  FOREACH v_func_sig IN ARRAY v_expected_functions LOOP
    IF to_regprocedure('public.' || v_func_sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s OWNER TO gg_migration_owner;', v_func_sig);
    END IF;
  END LOOP;
END $$;

-- 4. Schema and Database permission boundaries
REVOKE ALL ON SCHEMA public FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
GRANT USAGE ON SCHEMA public TO gg_app_runtime, gg_app_onboarding;
GRANT ALL ON SCHEMA public TO gg_migration_owner;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC, gg_app_runtime, gg_app_onboarding;', current_database());
END $$;

-- 5. Revoke privileges on repository tables and functions whitelist
-- Strictly targets known objects without modifying extension ACLs
DO $$
DECLARE
  v_table_name text;
  v_func_sig text;
  v_expected_tables text[] := ARRAY[
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services',
    'staff_services',
    'staff_accounts',
    'staff_location_assignments',
    'staff_sessions',
    'staff_permissions',
    'staff_location_working_hours',
    'staff_schedule_overrides',
    'appointment_time_change_history',
    'appointment_items',
    'appointment_item_staff_assignments',
    'owner_accounts',
    'owner_shop_memberships',
    'owner_sessions',
    'service_translations',
    'service_categories',
    'service_category_translations',
    'shop_customer_settings',
    'shop_member_code_counters',
    'customer_phone_identities',
    'customer_otp_challenges',
    'customer_sessions',
    'customer_identity_audit',
    'appointment_status_history',
    'checkout_transactions',
    'checkout_line_items',
    'checkout_payments',
    'checkout_staff_attributions',
    'checkout_financial_audit'
  ];
  v_expected_functions text[] := ARRAY[
    'assignment_collision_project()',
    'assignment_collision_sync_item_time()',
    'assignment_collision_sync_parent_state()',
    'assignment_collision_consistency_check()',
    'sync_appointment_customer_parties()',
    'provision_shop_customer_identity()',
    'assign_customer_member_code()',
    'reject_appointment_status_history_mutation()',
    'reject_checkout_financial_audit_mutation()'
  ];
BEGIN
  FOREACH v_table_name IN ARRAY v_expected_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, gg_app_runtime, gg_app_onboarding;', v_table_name);
    END IF;
  END LOOP;

  FOREACH v_func_sig IN ARRAY v_expected_functions LOOP
    IF to_regprocedure('public.' || v_func_sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, gg_app_runtime, gg_app_onboarding;', v_func_sig);
    END IF;
  END LOOP;
END $$;

-- 6. Granular Table Privileges for gg_app_runtime

-- (a) SELECT only: static lookup & tenant configuration
GRANT SELECT ON
  public.staff_permissions,
  public.staff_working_hours,
  public.shop_customer_settings
TO gg_app_runtime;

-- (b) SELECT, INSERT: operational child lines and financial audit
-- (Note: checkout_staff_attributions is excluded with zero privileges)
GRANT SELECT, INSERT ON
  public.checkout_line_items,
  public.checkout_payments,
  public.checkout_financial_audit
TO gg_app_runtime;

-- (c) SELECT, INSERT, UPDATE: operational core domain entities
GRANT SELECT, INSERT, UPDATE ON
  public.staff,
  public.staff_location_assignments,
  public.staff_sessions,
  public.staff_location_working_hours,
  public.staff_schedule_overrides,
  public.staff_services,
  public.appointments,
  public.appointment_items,
  public.customers,
  public.customer_phone_identities,
  public.customer_otp_challenges,
  public.customer_sessions,
  public.services,
  public.service_categories,
  public.owner_sessions
TO gg_app_runtime;

-- (d) SELECT, UPDATE only: accounts and counters (NO INSERT)
GRANT SELECT, UPDATE ON
  public.staff_accounts,
  public.owner_accounts,
  public.shop_member_code_counters
TO gg_app_runtime;

-- (e) Immutable operational audit logs (appointment_time_change_history needs SELECT for INSERT RETURNING)
GRANT SELECT, INSERT ON public.appointment_time_change_history TO gg_app_runtime;
GRANT INSERT ON public.appointment_status_history, public.customer_identity_audit TO gg_app_runtime;

-- (f) Column-level UPDATE privileges
-- service_translations: UPSERT modifies name, description, updated_at
GRANT SELECT, INSERT ON public.service_translations TO gg_app_runtime;
GRANT UPDATE (name, description, updated_at) ON public.service_translations TO gg_app_runtime;

-- service_category_translations: UPSERT modifies name, updated_at
GRANT SELECT, INSERT ON public.service_category_translations TO gg_app_runtime;
GRANT UPDATE (name, updated_at) ON public.service_category_translations TO gg_app_runtime;

-- appointment_item_staff_assignments: trigger assignment_collision_sync_item_time updates item schedule
GRANT SELECT, INSERT ON public.appointment_item_staff_assignments TO gg_app_runtime;
GRANT UPDATE (start_at, end_at, blocks_time, updated_at) ON public.appointment_item_staff_assignments TO gg_app_runtime;

-- (g) Row locking lookups: grant UPDATE(id) for FOR UPDATE / FOR SHARE queries + lock guard triggers
GRANT SELECT ON public.shops TO gg_app_runtime;
GRANT UPDATE (id) ON public.shops TO gg_app_runtime;

GRANT SELECT ON public.owner_shop_memberships TO gg_app_runtime;
GRANT UPDATE (id) ON public.owner_shop_memberships TO gg_app_runtime;

GRANT SELECT ON public.locations TO gg_app_runtime;
GRANT UPDATE (id) ON public.locations TO gg_app_runtime;

GRANT SELECT, INSERT ON public.checkout_transactions TO gg_app_runtime;
GRANT UPDATE (id) ON public.checkout_transactions TO gg_app_runtime;

-- 7. Lock Guard Trigger: blocks actual mutation from runtime and onboarding roles
CREATE OR REPLACE FUNCTION public.reject_locked_lookup_actual_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'gg_app_runtime' AND TG_TABLE_NAME IN ('shops', 'locations', 'checkout_transactions', 'owner_shop_memberships') THEN
    RAISE EXCEPTION 'table % does not permit runtime UPDATE; row locking only', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF current_user = 'gg_app_onboarding' AND TG_TABLE_NAME IN ('shops', 'owner_accounts') THEN
    RAISE EXCEPTION 'table % does not permit onboarding UPDATE; row locking only', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reject_locked_lookup_actual_update() OWNER TO gg_migration_owner;
REVOKE ALL ON FUNCTION public.reject_locked_lookup_actual_update() FROM PUBLIC, gg_app_runtime, gg_app_onboarding;

DROP TRIGGER IF EXISTS reject_shops_actual_update ON public.shops;
CREATE TRIGGER reject_shops_actual_update
  BEFORE UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

DROP TRIGGER IF EXISTS reject_locations_actual_update ON public.locations;
CREATE TRIGGER reject_locations_actual_update
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

DROP TRIGGER IF EXISTS reject_checkout_transactions_actual_update ON public.checkout_transactions;
CREATE TRIGGER reject_checkout_transactions_actual_update
  BEFORE UPDATE ON public.checkout_transactions
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

DROP TRIGGER IF EXISTS reject_owner_shop_memberships_actual_update ON public.owner_shop_memberships;
CREATE TRIGGER reject_owner_shop_memberships_actual_update
  BEFORE UPDATE ON public.owner_shop_memberships
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

DROP TRIGGER IF EXISTS reject_owner_accounts_actual_update ON public.owner_accounts;
CREATE TRIGGER reject_owner_accounts_actual_update
  BEFORE UPDATE ON public.owner_accounts
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

-- 8. Granular Table Privileges for gg_app_onboarding (CLI bootstrap-owner.js)
GRANT SELECT ON public.shops TO gg_app_onboarding;
GRANT UPDATE (id) ON public.shops TO gg_app_onboarding;

GRANT SELECT, INSERT ON public.owner_accounts, public.owner_shop_memberships TO gg_app_onboarding;
GRANT UPDATE (id) ON public.owner_accounts TO gg_app_onboarding;

-- 9. Default Privileges for future objects created by gg_migration_owner
-- Executed under genuine gg_migration_owner role
SET ROLE gg_migration_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, gg_app_runtime, gg_app_onboarding;

RESET ROLE;

COMMIT;
