BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.membership_tiers') IS NULL THEN RAISE EXCEPTION 'membership_tiers table is missing'; END IF;
  IF to_regclass('public.customer_accounts') IS NULL THEN RAISE EXCEPTION 'customer_accounts table is missing'; END IF;
  IF to_regclass('public.customer_memberships') IS NULL THEN RAISE EXCEPTION 'customer_memberships table is missing'; END IF;

  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
      AND column_name IN ('membership_enabled', 'points_enabled', 'stored_value_enabled', 'packages_enabled', 'auto_free_membership')
  ) <> 5 THEN
    RAISE EXCEPTION 'feature toggle columns missing from shop_customer_settings';
  END IF;

  IF EXISTS (
    SELECT s.id FROM public.shops s
    LEFT JOIN public.membership_tiers t ON t.shop_id = s.id AND t.tier_code = 'ordinary'
    WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'ordinary tier not provisioned for all shops';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customer_accounts'::regclass AND conname = 'customer_accounts_shop_customer_key'
  ) THEN
    RAISE EXCEPTION 'customer_accounts_shop_customer_key constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customer_memberships'::regclass AND conname = 'customer_memberships_shop_id_key'
  ) THEN
    RAISE EXCEPTION 'customer_memberships_shop_id_key constraint is missing';
  END IF;
END $verify$;
COMMIT;
