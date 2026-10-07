BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  v_constraint_def TEXT;
  v_index_def TEXT;
  v_invalid_count BIGINT;
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'booking channel preflight: public.appointments is required';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name IN ('id', 'shop_id', 'start_at')
  ) <> 3 THEN
    RAISE EXCEPTION 'booking channel preflight: required appointment reporting columns are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'booking_channel'
      AND (data_type <> 'text' OR is_nullable <> 'YES')
  ) THEN
    RAISE EXCEPTION 'booking channel preflight: appointments.booking_channel has incompatible type or nullability';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'booking_channel'
  ) THEN
    EXECUTE $query$
      SELECT COUNT(*)
      FROM public.appointments
      WHERE booking_channel IS NOT NULL
        AND booking_channel NOT IN (
          'whatsapp', 'instagram', 'tiktok', 'xiaohongshu',
          'douyin', 'google', 'website'
        )
    $query$ INTO v_invalid_count;
    IF v_invalid_count <> 0 THEN
      RAISE EXCEPTION 'booking channel preflight: % invalid existing values found', v_invalid_count;
    END IF;
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO v_constraint_def
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.appointments'::regclass
    AND constraint_row.conname = 'appointments_booking_channel_check';

  IF v_constraint_def IS NOT NULL AND NOT (
    v_constraint_def LIKE '%booking_channel IS NULL%'
    AND v_constraint_def LIKE '%whatsapp%'
    AND v_constraint_def LIKE '%instagram%'
    AND v_constraint_def LIKE '%tiktok%'
    AND v_constraint_def LIKE '%xiaohongshu%'
    AND v_constraint_def LIKE '%douyin%'
    AND v_constraint_def LIKE '%google%'
    AND v_constraint_def LIKE '%website%'
  ) THEN
    RAISE EXCEPTION 'booking channel preflight: appointments_booking_channel_check conflicts: %', v_constraint_def;
  END IF;

  SELECT pg_get_indexdef(index_row.indexrelid)
  INTO v_index_def
  FROM pg_index index_row
  JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
  WHERE index_namespace.nspname = 'public'
    AND index_class.relname = 'appointments_booking_channel_report_idx';

  IF v_index_def IS NOT NULL
     AND v_index_def NOT LIKE '%(shop_id, booking_channel, start_at, id)%' THEN
    RAISE EXCEPTION 'booking channel preflight: reporting index conflicts: %', v_index_def;
  END IF;
END $preflight$;

COMMIT;
