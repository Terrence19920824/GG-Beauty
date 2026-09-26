-- Rollback/recovery: after confirming no profile notes remain, run
-- migrations/rollback/070_customer_profile_notes_rollback.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS profile_notes TEXT NULL;
DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_profile_notes_length_check'
  ) THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_profile_notes_length_check CHECK (profile_notes IS NULL OR char_length(profile_notes) <= 4000);
  END IF;
END $constraints$;
COMMIT;
