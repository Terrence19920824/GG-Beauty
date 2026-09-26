-- Rollback is intentionally data-safe: it refuses to discard existing appointment internal notes data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $rollback$
DECLARE
  column_exists BOOLEAN;
  has_internal_notes BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'internal_notes'
  ) INTO column_exists;

  IF column_exists THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.appointments WHERE internal_notes IS NOT NULL)'
      INTO has_internal_notes;
  END IF;

  IF COALESCE(has_internal_notes, FALSE) THEN
    RAISE EXCEPTION 'Appointment internal notes rollback blocked: clear or archive configured internal notes before dropping column';
  END IF;
END $rollback$;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_internal_notes_length_check,
  DROP COLUMN IF EXISTS internal_notes;
COMMIT;
