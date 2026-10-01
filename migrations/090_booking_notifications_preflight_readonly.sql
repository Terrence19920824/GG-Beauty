-- Booking Notifications V1: read-only schema preflight.
-- This file performs no business-data or schema mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL
     OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.staff') IS NULL THEN
    RAISE EXCEPTION 'booking notifications preflight: required relation missing';
  END IF;

  IF to_regclass('public.booking_notifications') IS NOT NULL THEN
    RAISE EXCEPTION 'booking notifications preflight: target table already exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN (
        'booking_notifications_shop_dedupe_uidx',
        'booking_notifications_recipient_idx',
        'booking_notifications_appointment_idx'
      )
  ) THEN
    RAISE EXCEPTION 'booking notifications preflight: target index name already exists';
  END IF;
END
$preflight$;
COMMIT;
