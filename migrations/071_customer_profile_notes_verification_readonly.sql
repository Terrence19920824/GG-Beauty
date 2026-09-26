BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'profile_notes'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'customers.profile_notes is missing or has an unexpected type';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_profile_notes_length_check'
  ) THEN
    RAISE EXCEPTION 'customers_profile_notes_length_check is missing';
  END IF;
END $verify$;
COMMIT;
