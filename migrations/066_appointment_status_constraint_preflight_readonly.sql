-- Preflight: read-only check for appointment status constraint update.
-- Verifies prerequisite table, column, existing constraint, and data sanity.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'appointments table is required before updating status constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'appointments.status column is missing or not text';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_status_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'appointments_status_check constraint is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointments
    WHERE status NOT IN ('pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show')
  ) THEN
    RAISE EXCEPTION 'appointments contains rows with unapproved statuses violating target status set';
  END IF;
END $preflight$;
COMMIT;
