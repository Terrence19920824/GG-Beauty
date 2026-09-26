-- Expand appointments_status_check to include 'arrived' and 'in_service'.
-- Final allowed set: pending, confirmed, arrived, in_service, completed, cancelled, no_show.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.appointments
    WHERE status NOT IN ('pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show')
  ) THEN
    RAISE EXCEPTION 'Cannot update appointments_status_check: rows exist with unsupported statuses';
  END IF;
END $guard$;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check,
  ADD CONSTRAINT appointments_status_check
    CHECK (status IN ('pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show'));

COMMIT;
