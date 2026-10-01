-- Merchant self-service onboarding: read-only business defaults verification.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.shop_customer_settings') IS NULL THEN
    RAISE EXCEPTION 'merchant business defaults verification: public.shop_customer_settings table missing';
  END IF;

  -- 1. Exact intended column existence, data types, nullability, and absence of unintended defaults
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shop_customer_settings'
      AND column_name = 'country_code'
      AND data_type = 'text'
      AND is_nullable = 'YES'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: country_code column missing, wrong type, wrong nullability, or unintended default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shop_customer_settings'
      AND column_name = 'currency_code'
      AND data_type = 'text'
      AND is_nullable = 'YES'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: currency_code column missing, wrong type, wrong nullability, or unintended default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shop_customer_settings'
      AND column_name = 'default_locale'
      AND data_type = 'text'
      AND is_nullable = 'YES'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: default_locale column missing, wrong type, wrong nullability, or unintended default';
  END IF;

  -- 2. Exact CHECK constraints validation: name, type, validated status, and semantics
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.shop_customer_settings'::regclass
      AND c.conname = 'shop_customer_settings_country_code_check'
      AND c.contype = 'c'
      AND c.convalidated = TRUE
      AND pg_get_constraintdef(c.oid) IN (
        'CHECK (((country_code IS NULL) OR (country_code ~ ''^[A-Z]{2}$''::text)))',
        'CHECK (((country_code ~ ''^[A-Z]{2}$''::text) OR (country_code IS NULL)))'
      )
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: country constraint missing, not validated, or definition drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.shop_customer_settings'::regclass
      AND c.conname = 'shop_customer_settings_currency_code_check'
      AND c.contype = 'c'
      AND c.convalidated = TRUE
      AND pg_get_constraintdef(c.oid) IN (
        'CHECK (((currency_code IS NULL) OR (currency_code ~ ''^[A-Z]{3}$''::text)))',
        'CHECK (((currency_code ~ ''^[A-Z]{3}$''::text) OR (currency_code IS NULL)))'
      )
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: currency constraint missing, not validated, or definition drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.shop_customer_settings'::regclass
      AND c.conname = 'shop_customer_settings_default_locale_check'
      AND c.contype = 'c'
      AND c.convalidated = TRUE
      AND pg_get_constraintdef(c.oid) IN (
        'CHECK (((default_locale IS NULL) OR (default_locale ~ ''^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$''::text)))',
        'CHECK (((default_locale ~ ''^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$''::text) OR (default_locale IS NULL)))'
      )
  ) THEN
    RAISE EXCEPTION 'merchant business defaults verification: locale constraint missing, not validated, or definition drifted';
  END IF;
END $verify$;
COMMIT;
