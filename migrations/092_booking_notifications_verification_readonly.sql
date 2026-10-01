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
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_appointment_scope_fkey'
      AND contype = 'f'
      AND confrelid = 'public.appointments'::regclass
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'FOREIGN KEY (shop_id, appointment_id) REFERENCES appointments(shop_id, id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION 'booking notifications verification: tenant-safe appointment FK missing or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_recipient_staff_scope_fkey'
      AND contype = 'f'
      AND confrelid = 'public.staff'::regclass
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'FOREIGN KEY (shop_id, recipient_staff_id) REFERENCES staff(shop_id, id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION 'booking notifications verification: tenant-safe staff FK missing or drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_meta
    WHERE constraint_meta.conrelid = 'public.booking_notifications'::regclass
      AND constraint_meta.contype = 'f'
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(constraint_meta.conkey) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_meta.conrelid
         AND attribute.attnum = key_column.attnum
      ) IN (
        ARRAY['appointment_id']::NAME[],
        ARRAY['recipient_staff_id']::NAME[]
      )
  ) THEN
    RAISE EXCEPTION 'booking notifications verification: unsafe single-column tenant FK present';
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
