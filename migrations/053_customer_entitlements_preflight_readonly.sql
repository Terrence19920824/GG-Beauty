-- Customer Entitlements Preflight Readonly Guard
-- Validates that baseline relations, tenant composite keys, and prerequisite
-- structures exist without drift, and ensures no collision with entitlement objects.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  -- 1. Ensure prerequisite tables exist
  IF to_regclass('public.shops') IS NULL
     OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.services') IS NULL
     OR to_regclass('public.shop_customer_settings') IS NULL
     OR to_regclass('public.checkout_transactions') IS NULL
     OR to_regclass('public.checkout_line_items') IS NULL
     OR to_regclass('public.staff') IS NULL
     OR to_regclass('public.owner_shop_memberships') IS NULL
  THEN
    RAISE EXCEPTION 'entitlements preflight: required baseline relation missing';
  END IF;

  -- 2. Verify prerequisite tenant unique composite keys
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.customers'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['shop_id','id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: customers(shop_id, id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.services'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['shop_id','id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: services(shop_id, id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.checkout_transactions'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['shop_id','id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: checkout_transactions(shop_id, id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.checkout_line_items'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['shop_id','id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: checkout_line_items(shop_id, id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.staff'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['shop_id','id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: staff(shop_id, id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.owner_shop_memberships'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = ARRAY['owner_account_id','shop_id']::name[]
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: owner_shop_memberships(owner_account_id, shop_id) unique prerequisite missing';
  END IF;

  -- 3. Detect name collisions with any of the 17 new tables or 3 views
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
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
        'customer_entitlement_status_history',
        'v_customer_package_balances',
        'v_customer_stored_value_balances',
        'v_customer_points_balances'
      )
  ) THEN
    RAISE EXCEPTION 'entitlements preflight: entitlement objects already exist; do not rerun 053/054';
  END IF;
END $$;

COMMIT;

