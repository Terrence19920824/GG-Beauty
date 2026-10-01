-- Merchant self-service onboarding: read-only business defaults preflight.
-- This file performs no schema or business-data mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shop_customer_settings') IS NULL THEN
    RAISE EXCEPTION 'merchant business defaults preflight: public.shop_customer_settings table missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shop_customer_settings'
      AND column_name IN ('country_code', 'currency_code', 'default_locale')
  ) THEN
    RAISE EXCEPTION 'merchant business defaults preflight: country_code, currency_code, or default_locale already exists';
  END IF;
END $preflight$;
COMMIT;
