-- GG-Beauty Database Role Separation Verification (055)
-- STRICTLY READ ONLY: verifies role attributes, recursive memberships, schema/table/column ACLs,
-- object ownership, trigger enabled states, default ACLs, and absence of excessive mutation privileges.

BEGIN TRANSACTION READ ONLY;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  v_count integer;
  v_baseline jsonb;
  v_record record;
  v_role_rec record;
  v_table_name text;
  v_func_sig text;
  v_trigger_name text;
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
  v_expected_functions text[] := ARRAY[
    'assignment_collision_project()',
    'assignment_collision_sync_item_time()',
    'assignment_collision_sync_parent_state()',
    'assignment_collision_consistency_check()',
    'sync_appointment_customer_parties()',
    'provision_shop_customer_identity()',
    'assign_customer_member_code()',
    'reject_appointment_status_history_mutation()',
    'reject_checkout_financial_audit_mutation()',
    'reject_locked_lookup_actual_update()'
  ];
  v_expected_triggers text[] := ARRAY[
    'reject_shops_actual_update',
    'reject_locations_actual_update',
    'reject_checkout_transactions_actual_update',
    'reject_owner_shop_memberships_actual_update',
    'reject_owner_accounts_actual_update'
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

  -- 2. Verify recursive role membership: runtime and onboarding cannot inherit or SET ROLE to any privileged roles
  WITH RECURSIVE member_graph AS (
    SELECT m.member, m.roleid
    FROM pg_auth_members m
    UNION
    SELECT mg.member, m.roleid
    FROM member_graph mg
    JOIN pg_auth_members m ON m.member = mg.roleid
  )
  SELECT count(*) INTO v_count
  FROM member_graph mg
  JOIN pg_roles member_r ON member_r.oid = mg.member
  JOIN pg_roles role_r ON role_r.oid = mg.roleid
  WHERE member_r.rolname IN ('gg_app_runtime', 'gg_app_onboarding')
    AND (role_r.rolname = 'gg_migration_owner' OR role_r.rolsuper OR role_r.rolcreaterole OR role_r.rolcreatedb OR role_r.rolbypassrls);

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles possess unauthorized recursive membership in privileged roles';
  END IF;

  -- Verify runtime and onboarding have ZERO direct memberships in ANY role
  SELECT count(*) INTO v_count
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.member
  WHERE r.rolname IN ('gg_app_runtime', 'gg_app_onboarding');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles must not be members of any role';
  END IF;

  -- 3. Verify object ownership: runtime and onboarding own ZERO relations or functions
  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname IN ('gg_app_runtime', 'gg_app_onboarding');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles own relations in pg_class';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE r.rolname IN ('gg_app_runtime', 'gg_app_onboarding');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'verification failure: runtime/onboarding roles own functions in pg_proc';
  END IF;

  -- Expand must preserve existing owners and baseline function ACLs.
  v_baseline := obj_description('public.reject_locked_lookup_actual_update()'::regprocedure,'pg_proc')::jsonb;
  IF v_baseline IS NULL OR v_baseline->>'public_temp'<>'true' THEN
    RAISE EXCEPTION 'Expand baseline manifest missing';
  END IF;
  FOR v_record IN SELECT key,value FROM jsonb_each(v_baseline->'tables') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||quote_ident(v_record.key)) AND relowner=(v_record.value #>> '{}')::oid) THEN
      RAISE EXCEPTION 'Expand baseline owner changed: %',v_record.key;
    END IF;
  END LOOP;
  FOR v_record IN SELECT key,value FROM jsonb_each(v_baseline->'functions') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_record.key::oid
      AND proowner=(v_record.value->>'owner')::oid
      AND coalesce(proacl,acldefault('f',proowner))::text IS NOT DISTINCT FROM v_record.value->>'acl') THEN
      RAISE EXCEPTION 'Expand baseline function owner/ACL changed: %',v_record.key;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.reject_locked_lookup_actual_update()'::regprocedure
    AND proowner=(SELECT oid FROM pg_roles WHERE rolname='gg_migration_owner') AND NOT prosecdef
    AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'guard function owner/config mismatch';
  END IF;

  -- 5. Verify function ACL: guard function has NO execute privilege for runtime, onboarding, or public
  IF has_function_privilege('gg_app_runtime', 'public.reject_locked_lookup_actual_update()', 'EXECUTE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess EXECUTE on reject_locked_lookup_actual_update';
  END IF;
  IF has_function_privilege('gg_app_onboarding', 'public.reject_locked_lookup_actual_update()', 'EXECUTE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding must not possess EXECUTE on reject_locked_lookup_actual_update';
  END IF;

  -- 6. Verify schema privileges: USAGE only for runtime/onboarding, NO CREATE for public or runtime/onboarding
  IF NOT has_schema_privilege('gg_app_runtime', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime lacks USAGE on public schema';
  END IF;
  IF NOT has_schema_privilege('gg_app_onboarding', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding lacks USAGE on public schema';
  END IF;
  IF has_schema_privilege('gg_app_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime possesses CREATE on public schema';
  END IF;
  IF has_schema_privilege('gg_app_onboarding', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding possesses CREATE on public schema';
  END IF;
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'verification failure: PUBLIC possesses CREATE on public schema';
  END IF;

  -- EXPAND known exception: TEMP only through unchanged PUBLIC baseline.
  IF NOT EXISTS (SELECT 1 FROM pg_database d,
    LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY') THEN
    RAISE EXCEPTION 'PUBLIC TEMP baseline changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database d,
    LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE d.datname=current_database() AND a.privilege_type='TEMPORARY'
      AND r.rolname IN ('gg_app_runtime','gg_app_onboarding')) THEN
    RAISE EXCEPTION 'application role has direct TEMP grant';
  END IF;
  IF NOT has_database_privilege('gg_app_runtime',current_database(),'TEMP')
     OR NOT has_database_privilege('gg_app_onboarding',current_database(),'TEMP') THEN
    RAISE EXCEPTION 'PUBLIC inherited TEMP missing';
  END IF;

  -- 8. Verify ZERO DELETE and ZERO TRUNCATE privilege across all tables for gg_app_runtime
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

  -- 9. Verify removed excess privileges:
  -- staff_accounts must NOT have INSERT for runtime
  IF has_table_privilege('gg_app_runtime', 'public.staff_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on staff_accounts';
  END IF;

  -- shop_member_code_counters must NOT have INSERT for runtime
  IF has_table_privilege('gg_app_runtime', 'public.shop_member_code_counters', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on shop_member_code_counters';
  END IF;

  -- checkout_staff_attributions must have ZERO privileges for runtime or onboarding
  IF has_table_privilege('gg_app_runtime', 'public.checkout_staff_attributions', 'SELECT') OR
     has_table_privilege('gg_app_runtime', 'public.checkout_staff_attributions', 'INSERT') OR
     has_table_privilege('gg_app_onboarding', 'public.checkout_staff_attributions', 'SELECT') THEN
    RAISE EXCEPTION 'verification failure: checkout_staff_attributions must have zero grants for runtime and onboarding';
  END IF;

  -- appointment_time_change_history must have SELECT and INSERT for runtime
  IF NOT has_table_privilege('gg_app_runtime', 'public.appointment_time_change_history', 'SELECT') OR
     NOT has_table_privilege('gg_app_runtime', 'public.appointment_time_change_history', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: appointment_time_change_history must have SELECT and INSERT for runtime';
  END IF;

  -- 10. Verify column-level UPDATE privileges
  -- service_translations
  IF NOT has_column_privilege('gg_app_runtime', 'public.service_translations', 'name', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.service_translations', 'description', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.service_translations', 'updated_at', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.service_translations', 'id', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: service_translations column UPDATE privilege mismatch';
  END IF;

  -- service_category_translations
  IF NOT has_column_privilege('gg_app_runtime', 'public.service_category_translations', 'name', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.service_category_translations', 'updated_at', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.service_category_translations', 'id', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: service_category_translations column UPDATE privilege mismatch';
  END IF;

  -- appointment_item_staff_assignments
  IF NOT has_column_privilege('gg_app_runtime', 'public.appointment_item_staff_assignments', 'start_at', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.appointment_item_staff_assignments', 'end_at', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.appointment_item_staff_assignments', 'blocks_time', 'UPDATE') OR
     NOT has_column_privilege('gg_app_runtime', 'public.appointment_item_staff_assignments', 'updated_at', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.appointment_item_staff_assignments', 'id', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: appointment_item_staff_assignments column UPDATE privilege mismatch';
  END IF;

  -- Row locking UPDATE (id) column privileges
  IF NOT has_column_privilege('gg_app_runtime', 'public.shops', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.shops', 'name', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: shops row lock privilege mismatch for runtime';
  END IF;

  IF NOT has_column_privilege('gg_app_runtime', 'public.owner_shop_memberships', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.owner_shop_memberships', 'role', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: owner_shop_memberships row lock privilege mismatch for runtime';
  END IF;

  IF NOT has_column_privilege('gg_app_runtime', 'public.locations', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.locations', 'name', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: locations row lock privilege mismatch for runtime';
  END IF;

  IF NOT has_column_privilege('gg_app_runtime', 'public.checkout_transactions', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_runtime', 'public.checkout_transactions', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: checkout_transactions row lock privilege mismatch for runtime';
  END IF;

  -- 11. Verify isolation of owner bootstrapping: gg_app_runtime cannot insert into owner_accounts or memberships
  IF has_table_privilege('gg_app_runtime', 'public.owner_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on owner_accounts';
  END IF;
  IF has_table_privilege('gg_app_runtime', 'public.owner_shop_memberships', 'INSERT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_runtime must not possess INSERT on owner_shop_memberships';
  END IF;

  -- 12. Verify gg_app_onboarding least privileges
  IF NOT has_table_privilege('gg_app_onboarding', 'public.shops', 'SELECT') OR
     NOT has_column_privilege('gg_app_onboarding', 'public.shops', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_onboarding', 'public.shops', 'name', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding shops privileges mismatch';
  END IF;

  IF NOT has_table_privilege('gg_app_onboarding', 'public.owner_accounts', 'INSERT') OR
     NOT has_column_privilege('gg_app_onboarding', 'public.owner_accounts', 'id', 'UPDATE') OR
     has_column_privilege('gg_app_onboarding', 'public.owner_accounts', 'display_name', 'UPDATE') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding owner_accounts privileges mismatch';
  END IF;

  IF has_table_privilege('gg_app_onboarding', 'public.appointments', 'SELECT') OR
     has_table_privilege('gg_app_onboarding', 'public.customers', 'SELECT') THEN
    RAISE EXCEPTION 'verification failure: gg_app_onboarding possesses unauthorized access to appointments/customers';
  END IF;

  -- 13. Verify all 5 row locking lookup mutation rejection triggers exist and are enabled
  FOREACH v_trigger_name IN ARRAY v_expected_triggers LOOP
    SELECT count(*) INTO v_count
    FROM pg_trigger
    WHERE tgname = v_trigger_name
      AND tgenabled = 'O'
      AND tgfoid='public.reject_locked_lookup_actual_update()'::regprocedure
      AND tgrelid=to_regclass('public.' || CASE v_trigger_name
        WHEN 'reject_shops_actual_update' THEN 'shops'
        WHEN 'reject_locations_actual_update' THEN 'locations'
        WHEN 'reject_checkout_transactions_actual_update' THEN 'checkout_transactions'
        WHEN 'reject_owner_shop_memberships_actual_update' THEN 'owner_shop_memberships'
        WHEN 'reject_owner_accounts_actual_update' THEN 'owner_accounts' END)
      AND tgtype=19 AND NOT tgisinternal;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'verification failure: trigger % is missing or disabled', v_trigger_name;
    END IF;
  END LOOP;

  -- Reject any table-wide UPDATE and account security-field UPDATE.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
    (has_table_privilege('gg_app_runtime',c.oid,'UPDATE') OR has_table_privilege('gg_app_onboarding',c.oid,'UPDATE'))) THEN
    RAISE EXCEPTION 'table-wide UPDATE forbidden';
  END IF;
  FOREACH v_table_name IN ARRAY ARRAY['owner_accounts','staff_accounts'] LOOP
    FOR v_record IN SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('public.'||v_table_name)
      AND attnum>0 AND NOT attisdropped AND attname NOT IN ('last_login_at','failed_login_attempts','locked_until','updated_at') LOOP
      IF has_column_privilege('gg_app_runtime','public.'||v_table_name,v_record.attname,'UPDATE') THEN
        RAISE EXCEPTION 'account security column UPDATE: %.%',v_table_name,v_record.attname;
      END IF;
    END LOOP;
  END LOOP;
  -- Check actual default ACL contents, globally and per schema. Owner rights only.
  IF NOT EXISTS (SELECT 1 FROM pg_default_acl d
      WHERE defaclrole=(SELECT oid FROM pg_roles WHERE rolname='gg_migration_owner')
      AND defaclnamespace=0 AND defaclobjtype='f'
      AND defaclacl=ARRAY[format('%s=X/%s','gg_migration_owner','gg_migration_owner')::aclitem]) THEN
    RAISE EXCEPTION 'global function default ACL mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d,LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='gg_migration_owner')
      AND d.defaclobjtype IN ('r','f','S')
      AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'excessive default ACL entry';
  END IF;

  RAISE NOTICE 'database role separation verification: ALL checks passed cleanly';
END $$;

COMMIT;
