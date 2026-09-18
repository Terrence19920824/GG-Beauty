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

-- 3. Reassign ownership of existing public tables and functions to gg_migration_owner
DO $$
DECLARE
  v_rec record;
BEGIN
  FOR v_rec IN (
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  ) LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO gg_migration_owner;', v_rec.relname);
  END LOOP;

  FOR v_rec IN (
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ) LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO gg_migration_owner;', v_rec.proname, v_rec.args);
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

-- 5. Revoke existing public and default function privileges
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, gg_app_runtime, gg_app_onboarding;

-- 6. Blanket revoke on all public tables before granting exact least privileges
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, gg_app_runtime, gg_app_onboarding;

-- 7. Granular Table Privileges for gg_app_runtime

-- (a) SELECT only: static lookup & tenant configuration
GRANT SELECT ON
  public.shops,
  public.locations,
  public.staff_permissions,
  public.staff_working_hours,
  public.owner_shop_memberships,
  public.shop_customer_settings
TO gg_app_runtime;

-- (b) SELECT, INSERT: read and create only
GRANT SELECT, INSERT ON
  public.appointment_item_staff_assignments,
  public.checkout_line_items,
  public.checkout_payments,
  public.checkout_staff_attributions,
  public.service_translations,
  public.service_category_translations,
  public.checkout_financial_audit
TO gg_app_runtime;

-- (c) SELECT, INSERT, UPDATE: core operational domain entities
GRANT SELECT, INSERT, UPDATE ON
  public.staff,
  public.staff_accounts,
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
  public.owner_sessions,
  public.shop_member_code_counters
TO gg_app_runtime;

-- (d) SELECT, UPDATE: owner account authentication and credential changes (no INSERT)
GRANT SELECT, UPDATE ON public.owner_accounts TO gg_app_runtime;

-- (e) INSERT only: immutable operational audit records
GRANT INSERT ON
  public.appointment_time_change_history,
  public.appointment_status_history,
  public.customer_identity_audit
TO gg_app_runtime;

-- (f) Row locking lookups: grant UPDATE(id) for FOR UPDATE queries + trigger defenses against actual mutation
GRANT SELECT, INSERT ON public.checkout_transactions TO gg_app_runtime;
GRANT UPDATE (id) ON public.checkout_transactions TO gg_app_runtime;

GRANT UPDATE (id) ON public.locations TO gg_app_runtime;

CREATE OR REPLACE FUNCTION public.reject_locked_lookup_actual_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'table % does not permit actual runtime UPDATE; row locking only', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.reject_locked_lookup_actual_update() OWNER TO gg_migration_owner;

DROP TRIGGER IF EXISTS reject_locations_actual_update ON public.locations;
CREATE TRIGGER reject_locations_actual_update
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

DROP TRIGGER IF EXISTS reject_checkout_transactions_actual_update ON public.checkout_transactions;
CREATE TRIGGER reject_checkout_transactions_actual_update
  BEFORE UPDATE ON public.checkout_transactions
  FOR EACH ROW EXECUTE FUNCTION public.reject_locked_lookup_actual_update();

-- 8. Granular Table Privileges for gg_app_onboarding (CLI bootstrap-owner.js only)
GRANT SELECT ON public.shops TO gg_app_onboarding;
GRANT SELECT, INSERT ON public.owner_accounts, public.owner_shop_memberships TO gg_app_onboarding;

-- 9. Default Privileges for future objects created by gg_migration_owner
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, gg_app_runtime, gg_app_onboarding;
ALTER DEFAULT PRIVILEGES FOR ROLE gg_migration_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, gg_app_runtime, gg_app_onboarding;

COMMIT;
