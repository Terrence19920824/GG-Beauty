-- ==============================================================================
-- SAFETY WARNING:
-- 105 staff & front desk activation rollback is permitted ONLY before
-- real Production activation invitation or audit records exist.
--
-- Once any real invitation has been issued/created/consumed in Production:
-- DO NOT DROP staff_activation_invitations, front_desk_invitations, or merchant_auth_audit.
-- Use forward repair instead.
-- ==============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Guard 1: Verify tables exist before attempting locks
DO $guard_exists$
BEGIN
  IF to_regclass('public.staff_activation_invitations') IS NULL
     AND to_regclass('public.front_desk_invitations') IS NULL
     AND to_regclass('public.merchant_auth_audit') IS NULL THEN
    RAISE EXCEPTION 'activation rollback: target tables do not exist';
  END IF;
END $guard_exists$;

-- Guard 2: Take table locks BEFORE checking row counts to eliminate
-- concurrency races with in-flight transactions.
DO $lock$
BEGIN
  IF to_regclass('public.staff_activation_invitations') IS NOT NULL THEN
    LOCK TABLE public.staff_activation_invitations IN SHARE MODE;
  END IF;

  IF to_regclass('public.front_desk_invitations') IS NOT NULL THEN
    LOCK TABLE public.front_desk_invitations IN SHARE MODE;
  END IF;

  IF to_regclass('public.merchant_auth_audit') IS NOT NULL THEN
    LOCK TABLE public.merchant_auth_audit IN SHARE MODE;
  END IF;
END $lock$;

-- Guard 3: Safe non-destructive check. If ANY records exist in ANY of the tables,
-- FAIL CLOSED and refuse rollback. Contains NO DELETE or TRUNCATE statements.
DO $rollback_guard$
DECLARE
  has_staff_invitations boolean := false;
  has_front_desk_invitations boolean := false;
  has_audit_records boolean := false;
BEGIN
  IF to_regclass('public.staff_activation_invitations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.staff_activation_invitations)' INTO has_staff_invitations;
  END IF;

  IF to_regclass('public.front_desk_invitations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.front_desk_invitations)' INTO has_front_desk_invitations;
  END IF;

  IF to_regclass('public.merchant_auth_audit') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.merchant_auth_audit)' INTO has_audit_records;
  END IF;

  IF has_staff_invitations OR has_front_desk_invitations OR has_audit_records THEN
    RAISE EXCEPTION 'Activation rollback blocked: real operational records exist (staff: %, front_desk: %, audit: %); refuse to drop schema. Use forward repair instead.',
      has_staff_invitations, has_front_desk_invitations, has_audit_records;
  END IF;
END $rollback_guard$;

-- Remove triggers and functions
DROP TRIGGER IF EXISTS merchant_auth_audit_immutable ON public.merchant_auth_audit;
DROP FUNCTION IF EXISTS public.reject_merchant_auth_audit_mutation();

-- Drop additive tables (safe only when completely unpopulated)
DROP TABLE IF EXISTS public.merchant_auth_audit;
DROP TABLE IF EXISTS public.front_desk_invitations;
DROP TABLE IF EXISTS public.staff_activation_invitations;

COMMIT;
