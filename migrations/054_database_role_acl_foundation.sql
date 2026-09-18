-- GG-Beauty Database Role Separation Foundation (054)
-- Establishes least-privilege roles (gg_migration_owner, gg_app_runtime, gg_app_onboarding)
-- and granular table/column ACLs without setting passwords in source code.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Expand only: no existing ownership or PUBLIC/legacy ACL changes.
-- Contract requires separate authorization after Render switches successfully.
DO $$
DECLARE v_target record;
BEGIN
  FOR v_target IN SELECT * FROM pg_roles WHERE rolname IN
    ('gg_migration_owner','gg_app_runtime','gg_app_onboarding') LOOP
    IF v_target.rolsuper OR v_target.rolcreatedb OR v_target.rolcreaterole OR v_target.rolbypassrls
       OR v_target.rolreplication OR v_target.rolinherit THEN
      RAISE EXCEPTION 'contaminated target role %', v_target.rolname;
    END IF;
  END LOOP;
  -- Reject every outbound membership, including indirect SET ROLE chains.
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
      WHERE r.rolname IN ('gg_migration_owner','gg_app_runtime','gg_app_onboarding')) THEN
    RAISE EXCEPTION 'target role membership contamination';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE r.rolname IN ('gg_app_runtime','gg_app_onboarding'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE r.rolname IN ('gg_app_runtime','gg_app_onboarding')) THEN
    RAISE EXCEPTION 'application role ownership contamination';
  END IF;
  IF has_schema_privilege('public','public','CREATE') THEN
    RAISE EXCEPTION 'PUBLIC CREATE baseline unsafe; Contract authorization required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database d,
    LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY') THEN
    RAISE EXCEPTION 'PUBLIC TEMP baseline must be present for this Expand policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database d,
    LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE d.datname=current_database() AND a.privilege_type='TEMPORARY'
      AND r.rolname IN ('gg_app_runtime','gg_app_onboarding')) THEN
    RAISE EXCEPTION 'direct TEMP contamination';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gg_migration_owner') THEN
    CREATE ROLE gg_migration_owner WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gg_app_runtime') THEN
    CREATE ROLE gg_app_runtime WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gg_app_onboarding') THEN
    CREATE ROLE gg_app_onboarding WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- Transaction-local baseline copied into the newly introduced guard's comment.
SELECT set_config('gg.expand_baseline', jsonb_build_object(
  'public_temp',true,
  'tables',(SELECT jsonb_object_agg(c.relname,c.relowner) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'),
  'functions',(SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('owner',p.proowner,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname<>'reject_locked_lookup_actual_update')
)::text,true);

-- No ownership transfer. Grant membership before SET ROLE/default ACL operations.
DO $$ BEGIN
  EXECUTE format('GRANT gg_migration_owner TO %I',current_user);
END $$;
REVOKE ALL ON SCHEMA public FROM gg_app_runtime, gg_app_onboarding;
GRANT USAGE ON SCHEMA public TO gg_app_runtime, gg_app_onboarding;
-- New owner needs CREATE before creation of the new guard under SET ROLE.
GRANT USAGE, CREATE ON SCHEMA public TO gg_migration_owner;

-- 5. Revoke privileges on repository tables and functions whitelist
-- Strictly targets known objects without modifying extension ACLs
DO $$
DECLARE
  v_table_name text;
  v_func_sig text;
  v_columns text;
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
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM gg_app_runtime, gg_app_onboarding;', v_table_name);
      SELECT string_agg(quote_ident(attname), ',') INTO v_columns FROM pg_attribute
        WHERE attrelid=to_regclass('public.'||quote_ident(v_table_name)) AND attnum>0 AND NOT attisdropped;
      EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM gg_app_runtime, gg_app_onboarding', v_columns, v_table_name);
    END IF;
  END LOOP;

  FOREACH v_func_sig IN ARRAY v_expected_functions LOOP
    IF to_regprocedure('public.' || v_func_sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM gg_app_runtime, gg_app_onboarding;', v_func_sig);
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
GRANT SELECT, INSERT ON
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
GRANT SELECT ON
  public.staff_accounts,
  public.owner_accounts,
  public.shop_member_code_counters
TO gg_app_runtime;

GRANT UPDATE (name, phone, email, staff_code, bookable, is_active, updated_at) ON public.staff TO gg_app_runtime;
GRANT UPDATE (is_active, is_primary, updated_at) ON public.staff_location_assignments TO gg_app_runtime;
GRANT UPDATE (revoked_at, revoke_reason) ON public.staff_sessions TO gg_app_runtime;
GRANT UPDATE (start_time, end_time, is_active, effective_from, effective_to, updated_at) ON public.staff_location_working_hours TO gg_app_runtime;
GRANT UPDATE (schedule_date, override_type, start_time, end_time, reason, approval_status, is_active, updated_at) ON public.staff_schedule_overrides TO gg_app_runtime;
GRANT UPDATE (is_active) ON public.staff_services TO gg_app_runtime;
GRANT UPDATE (start_at, end_at, status, cancelled_at, service_completed_at, updated_at) ON public.appointments TO gg_app_runtime;
GRANT UPDATE (start_at, end_at, status, updated_at) ON public.appointment_items TO gg_app_runtime;
GRANT UPDATE (name, email, date_of_birth, gender, phone, phone_normalized, phone_verified_at, identity_status) ON public.customers TO gg_app_runtime;
GRANT UPDATE (is_primary, ended_at) ON public.customer_phone_identities TO gg_app_runtime;
GRANT UPDATE (provider_message_id, consumed_at, attempts) ON public.customer_otp_challenges TO gg_app_runtime;
GRANT UPDATE (revoked_at) ON public.customer_sessions TO gg_app_runtime;
GRANT UPDATE (category, category_id, name, description, price, price_is_from, duration_minutes, bookable, is_active, sort_order, updated_at) ON public.services TO gg_app_runtime;
GRANT UPDATE (canonical_name, icon_key, sort_order, is_active, updated_at) ON public.service_categories TO gg_app_runtime;
GRANT UPDATE (revoked_at, revoke_reason) ON public.owner_sessions TO gg_app_runtime;
GRANT UPDATE (last_login_at, failed_login_attempts, locked_until, updated_at) ON public.staff_accounts TO gg_app_runtime;
GRANT UPDATE (last_login_at, failed_login_attempts, locked_until, updated_at) ON public.owner_accounts TO gg_app_runtime;
GRANT UPDATE (next_value) ON public.shop_member_code_counters TO gg_app_runtime;

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
SET ROLE gg_migration_owner;
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

DO $$ BEGIN
  EXECUTE format('COMMENT ON FUNCTION public.reject_locked_lookup_actual_update() IS %L',current_setting('gg.expand_baseline'));
END $$;
RESET ROLE;
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
