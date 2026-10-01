-- Booking Notifications V1: safe rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF to_regclass('public.booking_notifications') IS NULL THEN
    RAISE EXCEPTION 'booking notifications rollback: target table missing';
  END IF;
END
$guard$;

-- Acquire the lock needed by DROP before checking emptiness. This prevents a
-- notification writer from crossing the guard before the destructive step.
LOCK TABLE public.booking_notifications
  IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.booking_notifications) THEN
    RAISE EXCEPTION 'booking notifications rollback refused: notification rows exist';
  END IF;
END
$guard$;

DROP TABLE public.booking_notifications;

COMMIT;
