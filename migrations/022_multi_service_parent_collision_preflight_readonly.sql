-- Multi-service parent collision compatibility: strict read-only preflight.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.appointments'::regclass
      AND contype='f' AND pg_get_constraintdef(oid) LIKE
      'FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_items'::regclass
      AND contype='f' AND pg_get_constraintdef(oid) LIKE
      'FOREIGN KEY (shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_item_staff_assignments'::regclass
      AND contype='f' AND pg_get_constraintdef(oid) LIKE
      'FOREIGN KEY (shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT%'
  ) THEN RAISE EXCEPTION 'Canonical tenant-safe FK drift'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='appointment_item_staff_assignments' AND column_name='blocks_time'
      AND udt_name='bool' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname='assignment_collision_project_trigger'
      AND tgrelid='public.appointment_item_staff_assignments'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname='assignment_collision_parent_state_trigger'
      AND tgrelid='public.appointments'::regclass
  ) THEN RAISE EXCEPTION 'Assignment projection foundation drift'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointments p LEFT JOIN appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    GROUP BY p.id HAVING count(i.id)=0
  ) THEN RAISE EXCEPTION 'Parent-only appointment detected'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointment_items i LEFT JOIN appointment_item_staff_assignments a
      ON a.shop_id=i.shop_id AND a.location_id=i.location_id
     AND a.appointment_item_id=i.id AND a.role='primary'
    GROUP BY i.id HAVING count(a.id)<>1
  ) THEN RAISE EXCEPTION 'Item primary count invalid'; END IF;

  IF EXISTS (
    SELECT 1
    FROM appointments p
    JOIN appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    JOIN appointment_item_staff_assignments a
      ON a.shop_id=i.shop_id AND a.location_id=i.location_id
     AND a.appointment_item_id=i.id AND a.role='primary'
    WHERE (SELECT count(*) FROM appointment_items x
           WHERE x.shop_id=p.shop_id AND x.location_id=p.location_id AND x.appointment_id=p.id)=1
      AND a.staff_id IS DISTINCT FROM p.staff_id
  ) THEN RAISE EXCEPTION 'Single-item parent primary compatibility mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a
    LEFT JOIN appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    LEFT JOIN appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    LEFT JOIN staff s ON s.shop_id=a.shop_id AND s.id=a.staff_id
    WHERE i.id IS NULL OR p.id IS NULL OR s.id IS NULL
       OR a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
       OR a.blocks_time IS DISTINCT FROM (p.status IN ('pending','confirmed') AND p.override_conflict=FALSE)
  ) THEN RAISE EXCEPTION 'Assignment orphan, tenant, time, or projection mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointments p JOIN appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    GROUP BY p.id,p.start_at,p.end_at
    HAVING min(i.start_at) IS DISTINCT FROM p.start_at OR max(i.end_at) IS DISTINCT FROM p.end_at
  ) THEN RAISE EXCEPTION 'Parent span mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT i.*,row_number() OVER(PARTITION BY shop_id,location_id,appointment_id ORDER BY sequence_no,id) expected
      FROM appointment_items i
    ) x WHERE sequence_no<>expected OR sequence_no<1
  ) OR EXISTS (
    SELECT 1 FROM appointment_items GROUP BY shop_id,location_id,appointment_id,sequence_no HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'Item sequence invalid or duplicated'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a1
    JOIN appointment_item_staff_assignments a2
      ON a2.shop_id=a1.shop_id AND a2.staff_id=a1.staff_id AND a2.id>a1.id
    WHERE a1.blocks_time AND a2.blocks_time
      AND tstzrange(a1.start_at,a1.end_at,'[)') && tstzrange(a2.start_at,a2.end_at,'[)')
  ) THEN RAISE EXCEPTION 'Blocking assignment overlap detected'; END IF;
END $preflight$;

SELECT 'PASS' AS multi_service_parent_collision_preflight;
ROLLBACK;
