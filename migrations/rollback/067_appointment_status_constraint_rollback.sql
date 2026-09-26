-- Rollback for appointments_status_check expansion.
-- Guarded: will NOT rollback if any rows currently have 'arrived' or 'in_service'.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.appointments
    WHERE status IN ('arrived', 'in_service')
  ) THEN
    RAISE EXCEPTION 'Rollback blocked: public.appointments contains rows with arrived or in_service status';
  END IF;
END $rollback_guard$;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check,
  ADD CONSTRAINT appointments_status_check
    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show'));

COMMIT;
