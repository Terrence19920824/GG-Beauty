-- Rollback/recovery: after confirming no required notes remain, run
-- ALTER TABLE public.appointments DROP COLUMN internal_notes;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS internal_notes TEXT NULL;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_internal_notes_length_check') THEN
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_internal_notes_length_check CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 4000);
  END IF;
END $constraints$;
COMMIT;
