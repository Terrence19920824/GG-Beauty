-- GG-Beauty Database Role Separation Preflight (053)
-- STRICTLY READ ONLY: verifies existing 000-052 baseline tables, current user role capabilities,
-- and ensures clean environment for role and ACL provisioning.

BEGIN TRANSACTION READ ONLY;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  v_missing_tables text[];
  v_table_name text;
  v_can_create_roles boolean;
  v_role_rec record;
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
BEGIN
  -- 1. Check required baseline relations (000-052)
  FOREACH v_table_name IN ARRAY v_expected_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table_name)) IS NULL THEN
      v_missing_tables := array_append(v_missing_tables, v_table_name);
    END IF;
  END LOOP;

  IF v_missing_tables IS NOT NULL AND array_length(v_missing_tables, 1) > 0 THEN
    RAISE EXCEPTION 'database role separation preflight: missing required baseline tables: %',
      array_to_string(v_missing_tables, ', ');
  END IF;

  -- 2. Verify current user has authority to manage roles
  SELECT (r.rolsuper OR r.rolcreaterole) INTO v_can_create_roles
  FROM pg_roles r
  WHERE r.rolname = current_user;

  IF NOT COALESCE(v_can_create_roles, false) THEN
    RAISE EXCEPTION 'database role separation preflight: current user % lacks CREATEROLE or SUPERUSER authority',
      current_user;
  END IF;

  -- 3. Check target roles if they already exist; ensure they are not contaminated with unwanted privileges or inheritance
  FOR v_role_rec IN (
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolreplication
    FROM pg_roles
    WHERE rolname IN ('gg_migration_owner', 'gg_app_runtime', 'gg_app_onboarding')
  ) LOOP
    IF v_role_rec.rolsuper OR v_role_rec.rolcreatedb OR v_role_rec.rolcreaterole OR v_role_rec.rolbypassrls OR v_role_rec.rolinherit OR v_role_rec.rolreplication THEN
      RAISE EXCEPTION 'database role separation preflight: target role % already exists with excessive administrative privileges or inherit flag',
        v_role_rec.rolname;
    END IF;
  END LOOP;

  RAISE NOTICE 'database role separation preflight: baseline verified (35 tables present, role admin authority confirmed)';
END $$;

COMMIT;
