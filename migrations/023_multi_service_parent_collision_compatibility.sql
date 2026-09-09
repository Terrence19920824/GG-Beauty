-- Remove only the redundant legacy parent-span exclusion. Canonical assignment
-- collision protection must already be complete and verified by 022.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.appointments'::regclass
      AND conname='prevent_staff_double_booking' AND contype='x'
      AND pg_get_constraintdef(oid) ~ 'staff_id WITH =.*tstzrange\(start_at, end_at.*WITH &&'
      AND pg_get_constraintdef(oid) ~ 'status.*pending.*confirmed'
      AND pg_get_constraintdef(oid) ~ 'override_conflict = false'
      AND pg_get_constraintdef(oid) !~ 'shop_id WITH|location_id WITH|role WITH'
  ) THEN RAISE EXCEPTION 'Parent collision constraint missing or drifted'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.appointment_item_staff_assignments'::regclass
      AND conname='prevent_assignment_staff_double_booking' AND contype='x'
      AND pg_get_constraintdef(oid) ~ 'shop_id WITH =.*staff_id WITH =.*tstzrange\(start_at, end_at.*WITH &&'
      AND pg_get_constraintdef(oid) ~ 'blocks_time = true'
      AND pg_get_constraintdef(oid) !~ 'location_id WITH|role WITH'
  ) THEN RAISE EXCEPTION 'Assignment collision constraint missing or drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointments p LEFT JOIN appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    GROUP BY p.id HAVING count(i.id)=0
  ) THEN RAISE EXCEPTION 'Parent-only appointment detected'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_items i LEFT JOIN appointment_item_staff_assignments a
      ON a.shop_id=i.shop_id AND a.location_id=i.location_id AND a.appointment_item_id=i.id AND a.role='primary'
    GROUP BY i.id HAVING count(a.id)<>1
  ) THEN RAISE EXCEPTION 'Item primary count invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a
    LEFT JOIN appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    LEFT JOIN appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    LEFT JOIN staff s ON s.shop_id=a.shop_id AND s.id=a.staff_id
    WHERE i.id IS NULL OR p.id IS NULL OR s.id IS NULL
       OR a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
       OR a.blocks_time IS DISTINCT FROM (p.status IN ('pending','confirmed') AND p.override_conflict=FALSE)
  ) THEN RAISE EXCEPTION 'Assignment canonical projection mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointments p JOIN appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    GROUP BY p.id,p.start_at,p.end_at HAVING min(i.start_at) IS DISTINCT FROM p.start_at OR max(i.end_at) IS DISTINCT FROM p.end_at
  ) THEN RAISE EXCEPTION 'Parent span mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a1 JOIN appointment_item_staff_assignments a2
      ON a2.shop_id=a1.shop_id AND a2.staff_id=a1.staff_id AND a2.id>a1.id
    WHERE a1.blocks_time AND a2.blocks_time AND tstzrange(a1.start_at,a1.end_at,'[)') && tstzrange(a2.start_at,a2.end_at,'[)')
  ) THEN RAISE EXCEPTION 'Blocking assignment overlap detected'; END IF;
END $guard$;

ALTER TABLE public.appointments DROP CONSTRAINT prevent_staff_double_booking;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointments'::regclass AND conname='prevent_staff_double_booking')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='staff_id' AND udt_name='uuid' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointments'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_item_staff_assignments'::regclass AND conname='prevent_assignment_staff_double_booking' AND contype='x')
  THEN RAISE EXCEPTION 'Parent compatibility migration postcondition failed'; END IF;
END $post$;

COMMIT;
