BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL THEN RAISE EXCEPTION 'shops table is required'; END IF;
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'customers table is required'; END IF;
  IF to_regclass('public.shop_customer_settings') IS NULL THEN RAISE EXCEPTION 'shop_customer_settings table is required'; END IF;
  IF to_regclass('public.customer_sessions') IS NULL THEN RAISE EXCEPTION 'customer_sessions table is required'; END IF;

  IF to_regclass('public.membership_tiers') IS NOT NULL THEN RAISE EXCEPTION 'membership_tiers table already exists'; END IF;
  IF to_regclass('public.customer_accounts') IS NOT NULL THEN RAISE EXCEPTION 'customer_accounts table already exists'; END IF;
  IF to_regclass('public.customer_memberships') IS NOT NULL THEN RAISE EXCEPTION 'customer_memberships table already exists'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
      AND column_name IN ('membership_enabled', 'points_enabled', 'stored_value_enabled', 'packages_enabled', 'auto_free_membership')
  ) THEN
    RAISE EXCEPTION 'feature toggle columns already exist on shop_customer_settings';
  END IF;
END $preflight$;
COMMIT;
