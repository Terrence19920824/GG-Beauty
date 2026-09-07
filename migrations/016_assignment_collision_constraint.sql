BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM appointment_item_staff_assignments WHERE blocks_time IS NULL OR start_at IS NULL OR end_at IS NULL OR end_at<=start_at) THEN
    RAISE EXCEPTION 'Assignment collision constraint preconditions failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a1 JOIN appointment_item_staff_assignments a2
      ON a2.shop_id=a1.shop_id AND a2.staff_id=a1.staff_id AND a2.id>a1.id
    WHERE a1.blocks_time AND a2.blocks_time AND a1.start_at<a2.end_at AND a2.start_at<a1.end_at
  ) THEN RAISE EXCEPTION 'Blocking overlap prevents exclusion constraint'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='prevent_assignment_staff_double_booking') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_item_staff_assignments'::regclass
        AND conname='prevent_assignment_staff_double_booking' AND contype='x'
        AND pg_get_constraintdef(oid) ~ 'shop_id WITH =.*staff_id WITH =.*tstzrange\(start_at, end_at.*WITH &&'
        AND pg_get_constraintdef(oid) ~ 'blocks_time = true'
    ) THEN RAISE EXCEPTION 'Assignment exclusion constraint drift'; END IF;
  END IF;
END $guard$;

ALTER TABLE public.appointment_item_staff_assignments ALTER COLUMN blocks_time SET NOT NULL;

DO $create$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_item_staff_assignments'::regclass AND conname='prevent_assignment_staff_double_booking') THEN
    ALTER TABLE public.appointment_item_staff_assignments
      ADD CONSTRAINT prevent_assignment_staff_double_booking
      EXCLUDE USING gist (
        shop_id WITH =,
        staff_id WITH =,
        tstzrange(start_at,end_at,'[)') WITH &&
      ) WHERE (blocks_time=TRUE);
  END IF;
END $create$;

COMMIT;
