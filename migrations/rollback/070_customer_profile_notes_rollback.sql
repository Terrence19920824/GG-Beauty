-- Rollback is intentionally data-safe: it refuses to discard existing customer profile notes data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $rollback$
DECLARE
  column_exists BOOLEAN;
  has_profile_notes BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'profile_notes'
  ) INTO column_exists;

  IF column_exists THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.customers WHERE profile_notes IS NOT NULL AND length(trim(profile_notes)) > 0)'
      INTO has_profile_notes;
  END IF;

  IF COALESCE(has_profile_notes, FALSE) THEN
    RAISE EXCEPTION 'Customer profile notes rollback blocked: customer profile notes exist; clear or archive profile notes before dropping column';
  END IF;
END $rollback$;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_profile_notes_length_check,
  DROP COLUMN IF EXISTS profile_notes;
COMMIT;
