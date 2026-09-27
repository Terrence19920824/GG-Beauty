BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'appointments table is required before adding customer special request';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'customer_special_request'
      AND data_type <> 'text'
  ) THEN
    RAISE EXCEPTION 'appointments.customer_special_request already exists with an unexpected type';
  END IF;
END $preflight$;
COMMIT;
