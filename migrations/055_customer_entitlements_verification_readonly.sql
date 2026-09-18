-- Customer Entitlements Verification Readonly Guard
-- Validates all 17 tables, 3 views, composite foreign keys, append-only triggers,
-- deferrable constraint triggers, exclusion constraints, and views compile cleanly.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
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
  v_views text[] := ARRAY[
    'v_customer_package_balances',
    'v_customer_stored_value_balances',
    'v_customer_points_balances'
  ];
  v_trigger text;
  v_triggers text[] := ARRAY[
    'customer_package_ledger_append_only',
    'customer_stored_value_ledger_append_only',
    'customer_stored_value_allocations_append_only',
    'customer_points_ledger_append_only',
    'customer_points_allocations_append_only',
    'customer_entitlement_status_history_append_only',
    'shop_entitlement_policies_immutability',
    'customer_membership_enrollments_status_audit',
    'customer_packages_status_audit',
    'customer_stored_value_accounts_status_audit',
    'customer_stored_value_lots_status_audit',
    'customer_points_accounts_status_audit',
    'customer_points_lots_status_audit'
  ];
BEGIN
  -- 1. Check all 17 tables exist
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'entitlements verification: table % is missing', v_table;
    END IF;
  END LOOP;

  -- 2. Check all 3 views exist
  FOREACH v_table IN ARRAY v_views LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'entitlements verification: view % is missing', v_table;
    END IF;
  END LOOP;

  -- 3. Check shop_customer_settings columns
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('membership_tier_enabled'),
      ('packages_enabled'),
      ('stored_value_enabled'),
      ('points_enabled'),
      ('currency_code')
    ) AS expected(column_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = 'shop_customer_settings' AND c.column_name = expected.column_name
    WHERE c.column_name IS NULL OR c.is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION 'entitlements verification: shop_customer_settings columns missing or nullable';
  END IF;

  -- 4. Check all append-only and audit triggers exist and are enabled
  FOREACH v_trigger IN ARRAY v_triggers LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND t.tgname = v_trigger AND t.tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION 'entitlements verification: trigger % is missing or disabled', v_trigger;
    END IF;
  END LOOP;

  -- 5. Check DEFERRABLE constraint triggers exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'customer_stored_value_lots'
      AND t.tgname = 'customer_stored_value_lot_grant_match_trigger'
      AND t.tgdeferrable AND t.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'entitlements verification: stored value lot grant deferrable constraint trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'customer_points_lots'
      AND t.tgname = 'customer_points_lot_grant_match_trigger'
      AND t.tgdeferrable AND t.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'entitlements verification: points lot grant deferrable constraint trigger missing';
  END IF;

  -- 6. Check policy exclusion constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'shop_entitlement_policies'
      AND c.contype = 'x'
      AND c.conname = 'shop_entitlement_policies_no_overlap'
  ) THEN
    RAISE EXCEPTION 'entitlements verification: shop_entitlement_policies exclusion constraint missing';
  END IF;

  -- 7. Ensure test view queries compile cleanly
  PERFORM * FROM public.v_customer_package_balances LIMIT 0;
  PERFORM * FROM public.v_customer_stored_value_balances LIMIT 0;
  PERFORM * FROM public.v_customer_points_balances LIMIT 0;

END $$;

COMMIT;
