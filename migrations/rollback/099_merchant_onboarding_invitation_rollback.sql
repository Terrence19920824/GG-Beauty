-- Merchant onboarding invitation foundation: safe rollback.
-- Drops merchant_onboarding_invitations table without touching shops or business data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TABLE IF EXISTS public.merchant_onboarding_invitations CASCADE;

COMMIT;
