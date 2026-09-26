BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'internal_notes' AND data_type = 'text') THEN
    RAISE EXCEPTION 'appointments.internal_notes is missing or has an unexpected type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_internal_notes_length_check') THEN
    RAISE EXCEPTION 'appointments_internal_notes_length_check is missing';
  END IF;
END $verify$;
COMMIT;
