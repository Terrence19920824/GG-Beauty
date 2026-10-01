-- Booking Notifications V1: read-only verification.
-- Verifies table structure, constraints, and indexes without modifying data.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.booking_notifications') IS NULL THEN
    RAISE EXCEPTION 'booking notifications verification: table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (shop_id, dedupe_key)'
  ) THEN
    RAISE EXCEPTION 'booking notifications verification: dedupe unique constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname = 'booking_notifications_recipient_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname = 'booking_notifications_appointment_idx'
  ) THEN
    RAISE EXCEPTION 'booking notifications verification: indexes missing';
  END IF;
END
$verify$;
COMMIT;
