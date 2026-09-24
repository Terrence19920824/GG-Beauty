BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.appointment_edit_history') IS NULL THEN
    RAISE EXCEPTION 'appointment_edit_history table missing';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointment_edit_history'
      AND column_name IN (
        'id', 'shop_id', 'location_id', 'appointment_id', 'actor_role',
        'actor_id', 'actor_name', 'old_start_at', 'new_start_at',
        'old_end_at', 'new_end_at', 'old_staff_id', 'new_staff_id',
        'items_snapshot', 'reassignment_reason', 'override_conflict',
        'conflict_reason', 'customer_notified', 'customer_agreed', 'created_at'
      )
  ) <> 20 THEN
    RAISE EXCEPTION 'appointment_edit_history column count mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointment_edit_history'::regclass
      AND conname = 'appointment_edit_history_actor_role_check'
  ) THEN
    RAISE EXCEPTION 'appointment_edit_history_actor_role_check missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointment_edit_history'::regclass
      AND conname = 'appointment_edit_history_duration_preserved_check'
  ) THEN
    RAISE EXCEPTION 'appointment_edit_history_duration_preserved_check missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointment_edit_history'::regclass
      AND conname = 'appointment_edit_history_conflict_reason_check'
  ) THEN
    RAISE EXCEPTION 'appointment_edit_history_conflict_reason_check missing';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'appointment_edit_history'
  ) < 4 THEN
    RAISE EXCEPTION 'appointment_edit_history indexes missing';
  END IF;
END $verify$;
COMMIT;
