BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'shops table is required';
  END IF;
  IF to_regclass('public.shop_customer_settings') IS NULL THEN
    RAISE EXCEPTION 'shop_customer_settings table is required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
      AND column_name IN (
        'public_display_name',
        'public_business_hours',
        'public_website_url',
        'public_instagram_url',
        'customer_announcement_text',
        'customer_announcement_enabled'
      )
  ) THEN
    RAISE EXCEPTION 'business profile columns already exist on shop_customer_settings';
  END IF;
END $preflight$;
COMMIT;
