-- Merchant self-service onboarding: additive merchant business defaults (country, currency, locale).
-- Existing merchants remain NULL and retain their current application behavior.
-- New self-service merchants must provide all values through the application.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.shop_customer_settings
  ADD COLUMN IF NOT EXISTS country_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS currency_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS default_locale TEXT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_country_code_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_country_code_check
      CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_currency_code_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_currency_code_check
      CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shop_customer_settings'::regclass
      AND conname = 'shop_customer_settings_default_locale_check'
  ) THEN
    ALTER TABLE public.shop_customer_settings
      ADD CONSTRAINT shop_customer_settings_default_locale_check
      CHECK (
        default_locale IS NULL
        OR default_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
      );
  END IF;
END $constraints$;

COMMIT;
