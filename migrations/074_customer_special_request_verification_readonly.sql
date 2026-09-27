BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'customer_special_request'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'appointments.customer_special_request is missing or has an unexpected type';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_customer_special_request_length_check'
  ) THEN
    RAISE EXCEPTION 'appointments_customer_special_request_length_check is missing';
  END IF;
END $verify$;
COMMIT;
