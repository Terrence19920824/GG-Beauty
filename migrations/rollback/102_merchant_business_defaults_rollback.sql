-- Merchant business defaults rollback.
-- Fail closed once real merchant configuration exists or onboarding history exists so
-- configured business defaults are never destroyed.
-- Concurrency safe: acquires table lock before authoritative data check.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Step 1: Acquire SHARE lock on tables before validation.
-- SHARE conflicts with ROW EXCLUSIVE (INSERT/UPDATE/DELETE), preventing any concurrent
-- writer from modifying settings or invitations between the check and DROP COLUMN.
-- Executed in a separate statement from the guard so READ COMMITTED takes a fresh snapshot
-- after any writer that the lock waited for has committed.
DO $lock$
BEGIN
  IF to_regclass('public.merchant_onboarding_invitations') IS NOT NULL THEN
    LOCK TABLE public.merchant_onboarding_invitations IN SHARE MODE;
  END IF;
  IF to_regclass('public.shop_customer_settings') IS NOT NULL THEN
    LOCK TABLE public.shop_customer_settings IN SHARE MODE;
  END IF;
END $lock$;

-- Step 2: Authoritative fail-closed data safety guard.
DO $guard$
DECLARE
  has_onboarding_history boolean := false;
  has_populated_settings boolean := false;
BEGIN
  -- A. Check if any onboarding invitation was consumed or created a merchant
  IF to_regclass('public.merchant_onboarding_invitations') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1
        FROM public.merchant_onboarding_invitations
        WHERE status = 'consumed'
           OR resulting_shop_id IS NOT NULL
      )
    $sql$ INTO has_onboarding_history;
  END IF;

  IF has_onboarding_history THEN
    RAISE EXCEPTION 'Merchant business defaults rollback blocked: onboarding history exists; use forward repair instead.';
  END IF;

  -- B. Check if any real merchant configuration exists in shop_customer_settings
  IF to_regclass('public.shop_customer_settings') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1
        FROM public.shop_customer_settings
        WHERE country_code IS NOT NULL
           OR currency_code IS NOT NULL
           OR default_locale IS NOT NULL
      )
    $sql$ INTO has_populated_settings;
  END IF;

  IF has_populated_settings THEN
    RAISE EXCEPTION 'Merchant business defaults rollback blocked: shop_customer_settings contains populated business defaults; use forward repair instead.';
  END IF;
END $guard$;

-- Step 3: Safely drop columns and constraints only when no real merchant data exists
ALTER TABLE public.shop_customer_settings
  DROP CONSTRAINT IF EXISTS shop_customer_settings_default_locale_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_currency_code_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_country_code_check,
  DROP COLUMN IF EXISTS default_locale,
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS country_code;

COMMIT;
