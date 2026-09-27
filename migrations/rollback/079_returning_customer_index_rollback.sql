BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP INDEX IF EXISTS public.appointments_returning_customer_lookup_idx;
COMMIT;
