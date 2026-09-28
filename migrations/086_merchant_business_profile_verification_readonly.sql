BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
      AND column_name IN (
        'public_display_name',
        'public_business_hours',
        'public_website_url',
        'public_instagram_url',
        'customer_announcement_text',
        'customer_announcement_enabled'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'Merchant business profile columns missing from shop_customer_settings';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_display_name_check'
  ) THEN
    RAISE EXCEPTION 'Constraint shop_customer_settings_public_display_name_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_business_hours_check'
  ) THEN
    RAISE EXCEPTION 'Constraint shop_customer_settings_public_business_hours_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_website_url_check'
  ) THEN
    RAISE EXCEPTION 'Constraint shop_customer_settings_public_website_url_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_instagram_url_check'
  ) THEN
    RAISE EXCEPTION 'Constraint shop_customer_settings_public_instagram_url_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_customer_announcement_text_check'
  ) THEN
    RAISE EXCEPTION 'Constraint shop_customer_settings_customer_announcement_text_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
      AND column_name = 'customer_announcement_enabled'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'customer_announcement_enabled must default to false';
  END IF;
END $verify$;
COMMIT;
