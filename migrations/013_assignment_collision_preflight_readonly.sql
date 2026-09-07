-- Assignment-level collision foundation: strict read-only preflight.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  overlap_count BIGINT;
BEGIN
  IF current_setting('server_version_num')::INTEGER < 170000 THEN
    RAISE EXCEPTION 'PostgreSQL 17 or newer is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'btree_gist extension is required';
  END IF;
  IF to_regclass('public.appointments') IS NULL
     OR to_regclass('public.appointment_items') IS NULL
     OR to_regclass('public.appointment_item_staff_assignments') IS NULL THEN
    RAISE EXCEPTION 'Canonical appointment tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('appointments','id','uuid','NO'), ('appointments','shop_id','uuid','NO'),
      ('appointments','location_id','uuid','NO'), ('appointments','staff_id','uuid','NO'),
      ('appointments','start_at','timestamptz','NO'), ('appointments','end_at','timestamptz','NO'),
      ('appointments','status','text','NO'), ('appointments','override_conflict','bool','NO'),
      ('appointment_items','id','uuid','NO'), ('appointment_items','shop_id','uuid','NO'),
      ('appointment_items','location_id','uuid','NO'), ('appointment_items','appointment_id','uuid','NO'),
      ('appointment_items','start_at','timestamptz','NO'), ('appointment_items','end_at','timestamptz','NO'),
      ('appointment_item_staff_assignments','id','uuid','NO'),
      ('appointment_item_staff_assignments','shop_id','uuid','NO'),
      ('appointment_item_staff_assignments','location_id','uuid','NO'),
      ('appointment_item_staff_assignments','appointment_item_id','uuid','NO'),
      ('appointment_item_staff_assignments','staff_id','uuid','NO'),
      ('appointment_item_staff_assignments','role','text','NO'),
      ('appointment_item_staff_assignments','start_at','timestamptz','NO'),
      ('appointment_item_staff_assignments','end_at','timestamptz','NO')
    ) expected(table_name,column_name,udt_name,is_nullable)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema='public' AND actual.table_name=expected.table_name
     AND actual.column_name=expected.column_name AND actual.udt_name=expected.udt_name
     AND actual.is_nullable=expected.is_nullable
    WHERE actual.column_name IS NULL
  ) THEN RAISE EXCEPTION 'Canonical appointment column drift detected'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='appointment_item_staff_assignments'
      AND column_name='blocks_time' AND udt_name <> 'bool'
  ) THEN RAISE EXCEPTION 'blocks_time exists with the wrong type'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname='appointment_item_staff_assignments'
      AND c.contype='p' AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname='appointment_item_staff_assignments'
      AND c.contype='f' AND pg_get_constraintdef(c.oid) LIKE
        'FOREIGN KEY (shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname='appointment_item_staff_assignments'
      AND c.contype='f' AND pg_get_constraintdef(c.oid) LIKE
        'FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT%'
  ) THEN RAISE EXCEPTION 'Assignment PK or tenant-safe FK drift detected'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    WHERE r.oid='public.appointment_item_staff_assignments'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ~ 'role.*primary.*assistant'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    WHERE r.oid='public.appointment_item_staff_assignments'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ~ 'end_at > start_at'
  ) THEN RAISE EXCEPTION 'Assignment role/time constraint drift detected'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND tablename='appointment_item_staff_assignments'
      AND indexdef ~ 'UNIQUE.*\(shop_id, location_id, appointment_item_id\).*WHERE.*role = .primary'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND tablename='appointment_item_staff_assignments'
      AND indexdef ~ '\(shop_id, location_id, staff_id, start_at, end_at\)'
  ) THEN RAISE EXCEPTION 'Assignment primary/schedule index drift detected'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass AND c.contype='x'
      AND pg_get_constraintdef(c.oid) ~ 'staff_id WITH ='
      AND pg_get_constraintdef(c.oid) ~ 'pending.*confirmed'
      AND pg_get_constraintdef(c.oid) ~ 'override_conflict = false'
  ) THEN RAISE EXCEPTION 'Parent appointment exclusion drift detected'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname IN (
      'assignment_collision_project','assignment_collision_sync_item_time',
      'assignment_collision_sync_parent_state','assignment_collision_consistency_check',
      'assignment_collision_project_trigger','assignment_collision_item_time_trigger',
      'assignment_collision_parent_state_trigger','assignment_collision_consistency_trigger',
      'assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger',
      'prevent_assignment_staff_double_booking'
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'assignment_collision_project','assignment_collision_sync_item_time',
      'assignment_collision_sync_parent_state','assignment_collision_consistency_check'
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'assignment_collision_project_trigger','assignment_collision_item_time_trigger',
      'assignment_collision_parent_state_trigger','assignment_collision_consistency_trigger'
      ,'assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger'
    )
  ) THEN RAISE EXCEPTION 'Assignment collision object name conflict detected'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a
    LEFT JOIN appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    LEFT JOIN appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    LEFT JOIN staff s ON s.shop_id=a.shop_id AND s.id=a.staff_id
    WHERE i.id IS NULL OR p.id IS NULL OR s.id IS NULL
       OR a.start_at IS NULL OR a.end_at IS NULL OR a.end_at<=a.start_at
       OR a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
  ) THEN RAISE EXCEPTION 'Assignment integrity drift detected'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments
    GROUP BY shop_id,location_id,appointment_item_id,staff_id HAVING count(*)>1
  ) OR EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a JOIN appointment_items i
      ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    GROUP BY i.shop_id,i.appointment_id,a.staff_id HAVING count(*)>1
  ) OR EXISTS (
    SELECT 1 FROM appointment_items i LEFT JOIN appointment_item_staff_assignments a
      ON a.shop_id=i.shop_id AND a.location_id=i.location_id AND a.appointment_item_id=i.id AND a.role='primary'
    GROUP BY i.id HAVING count(a.id)<>1
  ) THEN RAISE EXCEPTION 'Assignment duplicate or primary-count drift detected'; END IF;

  SELECT count(*) INTO overlap_count
  FROM appointment_item_staff_assignments a1
  JOIN appointment_items i1 ON i1.shop_id=a1.shop_id AND i1.location_id=a1.location_id AND i1.id=a1.appointment_item_id
  JOIN appointments p1 ON p1.shop_id=i1.shop_id AND p1.location_id=i1.location_id AND p1.id=i1.appointment_id
  JOIN appointment_item_staff_assignments a2 ON a2.shop_id=a1.shop_id AND a2.staff_id=a1.staff_id AND a2.id>a1.id
  JOIN appointment_items i2 ON i2.shop_id=a2.shop_id AND i2.location_id=a2.location_id AND i2.id=a2.appointment_item_id
  JOIN appointments p2 ON p2.shop_id=i2.shop_id AND p2.location_id=i2.location_id AND p2.id=i2.appointment_id
  WHERE p1.status IN ('pending','confirmed') AND p1.override_conflict=FALSE
    AND p2.status IN ('pending','confirmed') AND p2.override_conflict=FALSE
    AND a1.start_at<a2.end_at AND a2.start_at<a1.end_at;
  IF overlap_count<>0 THEN RAISE EXCEPTION 'Blocking assignment overlaps detected: %',overlap_count; END IF;
END
$preflight$;

SELECT 'PASS' AS assignment_collision_preflight;
ROLLBACK;
