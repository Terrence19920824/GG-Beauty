-- Rollback/recovery: after confirming no customer special requests remain, run
-- migrations/rollback/073_customer_special_request_rollback.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS customer_special_request TEXT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_customer_special_request_length_check'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_customer_special_request_length_check
      CHECK (
        customer_special_request IS NULL
        OR char_length(customer_special_request) <= 1000
      );
  END IF;
END $constraints$;

COMMIT;
