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

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_meta
    WHERE index_meta.indrelid = 'public.appointments'::regclass
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indpred IS NULL
      AND index_meta.indexprs IS NULL
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(index_meta.indkey::SMALLINT[]) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['shop_id', 'id']::NAME[]
  ) THEN
    RAISE EXCEPTION 'booking notifications preflight: appointments(shop_id,id) unique prerequisite missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_meta
    WHERE index_meta.indrelid = 'public.staff'::regclass
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indpred IS NULL
      AND index_meta.indexprs IS NULL
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(index_meta.indkey::SMALLINT[]) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['shop_id', 'id']::NAME[]
  ) THEN
    RAISE EXCEPTION 'booking notifications preflight: staff(shop_id,id) unique prerequisite missing';
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
