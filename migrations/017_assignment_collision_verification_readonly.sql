BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='appointment_item_staff_assignments' AND column_name='blocks_time'
      AND udt_name='bool' AND is_nullable='NO'
  ) THEN RAISE EXCEPTION 'blocks_time final schema invalid'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.appointment_item_staff_assignments'::regclass
      AND conname='prevent_assignment_staff_double_booking' AND contype='x'
      AND pg_get_constraintdef(oid) ~ 'shop_id WITH =.*staff_id WITH =.*tstzrange\(start_at, end_at.*WITH &&'
      AND pg_get_constraintdef(oid) ~ 'blocks_time = true'
  ) THEN RAISE EXCEPTION 'Assignment exclusion constraint missing or drifted'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('assignment_collision_project','assignment_collision_sync_item_time','assignment_collision_sync_parent_state','assignment_collision_consistency_check'))<>4
  OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('assignment_collision_project_trigger','assignment_collision_item_time_trigger','assignment_collision_parent_state_trigger','assignment_collision_consistency_trigger','assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger'))<>6 THEN
    RAISE EXCEPTION 'Projection function or trigger drift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.assignment_collision_project()'::regprocedure AND pg_get_functiondef(oid) LIKE '%NEW.blocks_time%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.assignment_collision_sync_item_time()'::regprocedure AND pg_get_functiondef(oid) LIKE '%UPDATE public.appointment_item_staff_assignments%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.assignment_collision_sync_parent_state()'::regprocedure AND pg_get_functiondef(oid) LIKE '%NEW.override_conflict=FALSE%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.assignment_collision_consistency_check()'::regprocedure AND pg_get_functiondef(oid) LIKE '%appointment assignment projection inconsistent%') THEN
    RAISE EXCEPTION 'Projection function definition drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_project_trigger'
      AND tgrelid='public.appointment_item_staff_assignments'::regclass
      AND tgfoid='public.assignment_collision_project()'::regprocedure
      AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_item_time_trigger'
      AND tgrelid='public.appointment_items'::regclass
      AND tgfoid='public.assignment_collision_sync_item_time()'::regprocedure
      AND pg_get_triggerdef(oid) LIKE '%AFTER UPDATE OF start_at, end_at%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_parent_state_trigger'
      AND tgrelid='public.appointments'::regclass
      AND tgfoid='public.assignment_collision_sync_parent_state()'::regprocedure
      AND pg_get_triggerdef(oid) LIKE '%AFTER UPDATE OF status, override_conflict%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_consistency_trigger'
      AND tgrelid='public.appointment_item_staff_assignments'::regclass
      AND tgfoid='public.assignment_collision_consistency_check()'::regprocedure
      AND tgdeferrable AND tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_item_consistency_trigger'
      AND tgrelid='public.appointment_items'::regclass
      AND tgfoid='public.assignment_collision_consistency_check()'::regprocedure
      AND tgdeferrable AND tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname='assignment_collision_parent_consistency_trigger'
      AND tgrelid='public.appointments'::regclass
      AND tgfoid='public.assignment_collision_consistency_check()'::regprocedure
      AND tgdeferrable AND tginitdeferred
  ) THEN RAISE EXCEPTION 'Projection trigger definition drift'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a
    JOIN appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    JOIN appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    WHERE a.blocks_time IS NULL OR a.end_at<=a.start_at OR a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
       OR a.blocks_time IS DISTINCT FROM (p.status IN ('pending','confirmed') AND p.override_conflict=FALSE)
  ) THEN RAISE EXCEPTION 'Assignment projection data drift'; END IF;
END $verify$;
SELECT 'PASS' AS assignment_collision_verification;
ROLLBACK;
