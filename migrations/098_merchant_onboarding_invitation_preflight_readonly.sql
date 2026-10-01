-- Merchant onboarding invitation foundation: read-only schema preflight.
-- This file performs no schema or business-data mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'merchant onboarding invitation preflight: public.shops table missing';
  END IF;

  IF to_regclass('public.merchant_onboarding_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'merchant onboarding invitation preflight: public.merchant_onboarding_invitations table already exists';
  END IF;
END $preflight$;
COMMIT;
