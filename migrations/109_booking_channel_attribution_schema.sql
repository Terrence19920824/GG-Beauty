BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS booking_channel TEXT;

DO $schema$
DECLARE
  v_constraint_def TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'booking_channel'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'booking channel schema: appointments.booking_channel is incompatible';
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO v_constraint_def
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.appointments'::regclass
    AND constraint_row.conname = 'appointments_booking_channel_check';

  IF v_constraint_def IS NULL THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_booking_channel_check
      CHECK (
        booking_channel IS NULL
        OR booking_channel IN (
          'whatsapp', 'instagram', 'tiktok', 'xiaohongshu',
          'douyin', 'google', 'website'
        )
      );
  ELSIF NOT (
    v_constraint_def LIKE '%booking_channel IS NULL%'
    AND v_constraint_def LIKE '%whatsapp%'
    AND v_constraint_def LIKE '%instagram%'
    AND v_constraint_def LIKE '%tiktok%'
    AND v_constraint_def LIKE '%xiaohongshu%'
    AND v_constraint_def LIKE '%douyin%'
    AND v_constraint_def LIKE '%google%'
    AND v_constraint_def LIKE '%website%'
  ) THEN
    RAISE EXCEPTION 'booking channel schema: appointments_booking_channel_check conflicts: %', v_constraint_def;
  END IF;
END $schema$;

CREATE INDEX IF NOT EXISTS appointments_booking_channel_report_idx
  ON public.appointments (shop_id, booking_channel, start_at, id);

DO $index_verify$
DECLARE
  v_index_def TEXT;
BEGIN
  SELECT pg_get_indexdef(index_row.indexrelid)
  INTO v_index_def
  FROM pg_index index_row
  JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
  WHERE index_namespace.nspname = 'public'
    AND index_class.relname = 'appointments_booking_channel_report_idx'
    AND index_row.indisvalid
    AND index_row.indisready;

  IF v_index_def IS NULL
     OR v_index_def NOT LIKE '%(shop_id, booking_channel, start_at, id)%' THEN
    RAISE EXCEPTION 'booking channel schema: reporting index is missing or incompatible: %', v_index_def;
  END IF;
END $index_verify$;

COMMIT;
