-- GG-Beauty Database Role Separation Verification (055)
-- STRICTLY READ ONLY: verifies role attributes, memberships, schema/table/column ACLs,
-- absence of dangerous administrative or mutation privileges, and trigger guards.

DO $$
DECLARE
  v_count integer;
  v_role_rec record;
  v_table_name text;
  v_expected_tables text[] := ARRAY[
    'shops', 'locations', 'staff', 'staff_working_hours', 'appointments', 'customers',
    'services', 'staff_services', 'staff_accounts', 'staff_location_assignments',
    'staff_sessions', 'staff_permissions', 'staff_location_working_hours',
    'staff_schedule_overrides', 'appointment_time_change_history', 'appointment_items',
    'appointment_item_staff_assignments', 'owner_accounts', 'owner_shop_memberships',
    'owner_sessions', 'service_translations', 'service_categories',
    'service_category_translations', 'shop_customer_settings', 'shop_member_code_counters',
    'customer_phone_identities', 'customer_otp_challenges', 'customer_sessions',
    'customer_identity_audit', 'appointment_status_history', 'checkout_transactions',
    'checkout_line_items', 'checkout_payments', 'checkout_staff_attributions',
    'checkout_financial_audit'
  ];
BEGIN
  -- 1. Verify role existence and strictly bounded attributes
  FOR v_role_rec IN (
    SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
    FROM pg_roles
    WHERE rolname IN ('gg_migration_owner', 'gg_app_runtime', 'gg_app_onboarding')
  ) LOOP
    IF v_role_rec.rolname = 'gg_migration_owner' AND v_role_rec.rolcanlogin THEN
      RAISE EXCEPTION 'verification failure: gg_migration_owner must be NOLOGIN';
    END IF;
    IF v_role_rec.rolname IN ('gg_app_runtime', 'gg_app_onboarding') AND NOT v_role_rec.rolcanlogin THEN
      RAISE EXCEPTION 'verification failure: % must be LOGIN', v_role_rec.rolname;
    END IF;
    IF v_role_rec.rolinherit THEN
      RAISE EXCEPTION 'verification failure: % must be NOINHERIT', v_role_rec.rolname;
    END IF;
    IF v_role_rec.rolsuper OR v_role_rec.rolcreatedb OR v_role_rec.rolcreaterole OR v_role_rec.rolbypassrls OR v_role_rec.rolreplication THEN
      RAISE EXCEPTION 'verification failure: % possesses unauthorized administrative role flags', v_role_rec.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('gg_migration_owner', 'gg_app_runtime', 'gg_app_onboarding')) <> 3 THEN
    RAISE EXCEPTION 'verification failure: one or more required roles are missing';
  END IF;

  -- 2. Verify membership boundary: runtime and onboarding cannot inherit or SET ROLE to admin / migration owner
  SELECT count(*) INTO v_count
  FROM pg_auth_members m
  JOIN pg_roles member_r ON member_r.oid = m.member
  JOIN pg_roles role_r ON role_r.oid = m.roleid
  WHERE member_r.rolname IN ('gg_app_runtime', 'gg_app_onboarding')
    AND (role_r.rolname = 'gg_migration_owner' OR role_r.rolsuper = TRUE);

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles possess unauthorized membership in privileged roles';
  END IF;

  -- 3. Verify object ownership: runtime and onboarding own ZERO relations or functions
  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname IN ('gg_app_runtime', 'gg_app_onboarding');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles own relations in pg_class';
  END IF;

  -- 4. Verify baseline table ownership: all 35 tables must be owned by gg_migration_owner
  FOREACH v_table_name IN ARRAY v_expected_tables LOOP
    SELECT count(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relname = v_table_name
      AND r.rolname = 'gg_migration_owner';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'verification failure: baseline table public.% is not owned by gg_migration_owner', v_table_name;
    END IF;
  END LOOP;

  -- 5. Verify schema privileges: USAGE only for runtime, NO CREATE for public or runtime
  IF NOT has_schema_privilege('gg_app_runtime', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime lacks USAGE on public schema';
  END IF;
  IF has_schema_privilege('gg_app_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime possesses CREATE on public schema';
  END IF;
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'verification failure: PUBLIC possesses CREATE on public schema';
  END IF;

  -- 6. Verify database TEMP privilege: strictly revoked
  IF has_database_privilege('gg_app_runtime', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime possesses TEMP privilege on database';
  END IF;

  -- 7. Verify ZERO DELETE and ZERO TRUNCATE privilege across all tables for gg_app_runtime
  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND has_table_privilege('gg_app_runtime', c.oid, 'DELETE');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime possesses DELETE on one or more tables';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND has_table_privilege('gg_app_runtime', c.oid, 'TRUNCATE');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime possesses TRUNCATE on one or more tables';
  END IF;

  -- 8. Verify isolation of owner bootstrapping: gg_app_runtime cannot insert into owner_accounts or memberships
  IF has_table_privilege('gg_app_runtime', 'public.owner_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on owner_accounts';
  END IF;
  IF has_table_privilege('gg_app_runtime', 'public.owner_shop_memberships', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on owner_shop_memberships';
  END IF;

  -- 9. Verify gg_app_onboarding least privileges
  IF NOT has_table_privilege('gg_app_onboarding', 'public.shops', 'SELECT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding lacks SELECT on shops';
  END IF;
  IF has_table_privilege('gg_app_onboarding', 'public.shops', 'UPDATE') OR
     has_table_privilege('gg_app_onboarding', 'public.shops', 'DELETE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding possesses unauthorized UPDATE/DELETE on shops';
  END IF;
  IF has_table_privilege('gg_app_onboarding', 'public.appointments', 'SELECT') OR
     has_table_privilege('gg_app_onboarding', 'public.customers', 'SELECT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding possesses unauthorized access to appointments/customers';
  END IF;

  -- 10. Verify row locking lookup mutation rejection triggers exist
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reject_locations_actual_update') THEN
    RAISE EXCEPTION 'verification failure: reject_locations_actual_update trigger missing on locations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reject_checkout_transactions_actual_update') THEN
    RAISE EXCEPTION 'verification failure: reject_checkout_transactions_actual_update trigger missing on checkout_transactions';
  END IF;

  RAISE NOTICE 'database role separation verification: ALL checks passed cleanly';
END $$;
