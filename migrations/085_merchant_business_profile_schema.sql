BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.shop_customer_settings
  ADD COLUMN IF NOT EXISTS public_display_name text NULL,
  ADD COLUMN IF NOT EXISTS public_business_hours text NULL,
  ADD COLUMN IF NOT EXISTS public_website_url text NULL,
  ADD COLUMN IF NOT EXISTS public_instagram_url text NULL,
  ADD COLUMN IF NOT EXISTS customer_announcement_text text NULL,
  ADD COLUMN IF NOT EXISTS customer_announcement_enabled boolean NOT NULL DEFAULT false;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_display_name_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_public_display_name_check
      CHECK (public_display_name IS NULL OR length(public_display_name) <= 255);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_business_hours_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_public_business_hours_check
      CHECK (public_business_hours IS NULL OR length(public_business_hours) <= 1000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_website_url_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_public_website_url_check
      CHECK (public_website_url IS NULL OR (length(public_website_url) <= 500 AND public_website_url ~* '^https?://'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_public_instagram_url_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_public_instagram_url_check
      CHECK (public_instagram_url IS NULL OR (length(public_instagram_url) <= 500 AND public_instagram_url ~* '^https?://'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_customer_announcement_text_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_customer_announcement_text_check
      CHECK (customer_announcement_text IS NULL OR length(customer_announcement_text) <= 1000);
  END IF;
END $constraints$;

COMMIT;
