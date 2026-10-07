BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.appointments IN SHARE ROW EXCLUSIVE MODE;

DO $rollback_guard$
DECLARE
  v_has_attribution BOOLEAN := FALSE;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'booking_channel'
  ) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.appointments WHERE booking_channel IS NOT NULL)'
      INTO v_has_attribution;
  END IF;

  IF v_has_attribution THEN
    RAISE EXCEPTION 'booking channel rollback refused: non-null attribution data exists; use forward repair';
  END IF;
END $rollback_guard$;

DROP INDEX IF EXISTS public.appointments_booking_channel_report_idx;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_booking_channel_check,
  DROP COLUMN IF EXISTS booking_channel;

COMMIT;
