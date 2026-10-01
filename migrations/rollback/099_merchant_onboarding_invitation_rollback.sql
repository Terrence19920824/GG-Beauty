-- ==============================================================================
-- SAFETY WARNING:
-- 099 merchant onboarding invitation rollback is permitted ONLY before
-- real Production merchant invitation records exist.
--
-- Once any real invitation has been issued/created/consumed in Production:
-- DO NOT DROP merchant_onboarding_invitations.
-- Use forward repair instead.
-- ==============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- SHARE is the least restrictive table lock that conflicts with the ROW EXCLUSIVE
-- lock used by INSERT, UPDATE, and DELETE. Keep it until transaction end so no
-- invitation write can race the following existence check and DROP TABLE.
-- Keep lock acquisition in a separate statement from the check so READ COMMITTED
-- takes a fresh snapshot after any writer that the lock waited for has committed.
DO $lock$
BEGIN
  IF to_regclass('public.merchant_onboarding_invitations') IS NOT NULL THEN
    LOCK TABLE public.merchant_onboarding_invitations IN SHARE MODE;
  END IF;
END $lock$;

-- Safe non-destructive guard: refuse to drop table if invitations already exist.
DO $rollback$
DECLARE
  has_invitations boolean := false;
BEGIN
  IF to_regclass('public.merchant_onboarding_invitations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.merchant_onboarding_invitations)' INTO has_invitations;
  END IF;

  IF has_invitations THEN
    RAISE EXCEPTION 'Merchant onboarding invitation rollback blocked: real merchant invitations exist; refuse to drop table. Use forward repair instead.';
  END IF;
END $rollback$;

DROP TABLE IF EXISTS public.merchant_onboarding_invitations CASCADE;

COMMIT;
