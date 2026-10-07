BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  v_constraint_def TEXT;
  v_index_def TEXT;
  v_invalid_count BIGINT;
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
    RAISE EXCEPTION 'booking channel verification: nullable text column is missing';
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO v_constraint_def
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.appointments'::regclass
    AND constraint_row.conname = 'appointments_booking_channel_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_constraint_def IS NULL OR NOT (
    v_constraint_def LIKE '%booking_channel IS NULL%'
    AND v_constraint_def LIKE '%whatsapp%'
    AND v_constraint_def LIKE '%instagram%'
    AND v_constraint_def LIKE '%tiktok%'
    AND v_constraint_def LIKE '%xiaohongshu%'
    AND v_constraint_def LIKE '%douyin%'
    AND v_constraint_def LIKE '%google%'
    AND v_constraint_def LIKE '%website%'
  ) THEN
    RAISE EXCEPTION 'booking channel verification: allowlist constraint is missing or drifted: %', v_constraint_def;
  END IF;

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
    RAISE EXCEPTION 'booking channel verification: reporting index is missing or drifted: %', v_index_def;
  END IF;

  SELECT COUNT(*)
  INTO v_invalid_count
  FROM public.appointments
  WHERE booking_channel IS NOT NULL
    AND booking_channel NOT IN (
      'whatsapp', 'instagram', 'tiktok', 'xiaohongshu',
      'douyin', 'google', 'website'
    );

  IF v_invalid_count <> 0 THEN
    RAISE EXCEPTION 'booking channel verification: % invalid values found', v_invalid_count;
  END IF;
END $verify$;

COMMIT;
