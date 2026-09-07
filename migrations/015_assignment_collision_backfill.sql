-- Continuous maintenance-window phase 2 of 014 -> 015 -> 016. No intervening
-- appointment/assignment time or status mutations are permitted.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $pre$
DECLARE function_count INTEGER; trigger_count INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointment_item_staff_assignments'
    AND column_name='blocks_time' AND udt_name='bool' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'blocks_time backfill schema drift';
  END IF;
  SELECT count(*) INTO function_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('assignment_collision_project','assignment_collision_sync_item_time','assignment_collision_sync_parent_state','assignment_collision_consistency_check');
  SELECT count(*) INTO trigger_count FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
    ('assignment_collision_project_trigger','assignment_collision_item_time_trigger','assignment_collision_parent_state_trigger','assignment_collision_consistency_trigger','assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger');
  IF function_count<>4 OR trigger_count<>6
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.assignment_collision_project()'::regprocedure AND p.prorettype='trigger'::regtype
      AND pg_get_functiondef(p.oid) LIKE '%NEW.blocks_time:=projection.blocks_time%' AND pg_get_functiondef(p.oid) LIKE '%s.shop_id=i.shop_id%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.assignment_collision_sync_item_time()'::regprocedure
      AND pg_get_functiondef(p.oid) LIKE '%SET start_at=NEW.start_at,end_at=NEW.end_at%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.assignment_collision_sync_parent_state()'::regprocedure
      AND pg_get_functiondef(p.oid) LIKE '%NEW.override_conflict=FALSE%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.assignment_collision_consistency_check()'::regprocedure
      AND pg_get_functiondef(p.oid) LIKE '%appointment assignment projection inconsistent%')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgenabled='O' AND tgname='assignment_collision_project_trigger' AND tgrelid='public.appointment_item_staff_assignments'::regclass AND tgfoid='public.assignment_collision_project()'::regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgenabled='O' AND tgname='assignment_collision_item_time_trigger' AND tgrelid='public.appointment_items'::regclass AND tgfoid='public.assignment_collision_sync_item_time()'::regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgenabled='O' AND tgname='assignment_collision_parent_state_trigger' AND tgrelid='public.appointments'::regclass AND tgfoid='public.assignment_collision_sync_parent_state()'::regprocedure)
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN ('assignment_collision_consistency_trigger','assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger') AND tgfoid='public.assignment_collision_consistency_check()'::regprocedure AND tgdeferrable AND tginitdeferred)<>3
  THEN RAISE EXCEPTION 'Assignment collision projection dependency drift'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a
    LEFT JOIN appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    LEFT JOIN appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    LEFT JOIN staff s ON s.shop_id=a.shop_id AND s.id=a.staff_id
    WHERE i.id IS NULL OR p.id IS NULL OR s.id IS NULL OR a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
  ) THEN RAISE EXCEPTION 'Assignment backfill preconditions failed'; END IF;
END $pre$;

DO $backfill$
DECLARE expected BIGINT; affected BIGINT;
BEGIN
  SELECT count(*) INTO expected FROM appointment_item_staff_assignments;
  UPDATE appointment_item_staff_assignments a
  SET blocks_time=(p.status IN ('pending','confirmed') AND p.override_conflict=FALSE)
  FROM appointment_items i JOIN appointments p
    ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
  WHERE a.shop_id=i.shop_id AND a.location_id=i.location_id AND a.appointment_item_id=i.id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>expected THEN RAISE EXCEPTION 'Assignment backfill rowcount mismatch: expected %, affected %',expected,affected; END IF;
END $backfill$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM appointment_item_staff_assignments WHERE blocks_time IS NULL) THEN RAISE EXCEPTION 'NULL blocks_time remains'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointment_item_staff_assignments a1 JOIN appointment_item_staff_assignments a2
      ON a2.shop_id=a1.shop_id AND a2.staff_id=a1.staff_id AND a2.id>a1.id
    WHERE a1.blocks_time AND a2.blocks_time AND a1.start_at<a2.end_at AND a2.start_at<a1.end_at
  ) THEN RAISE EXCEPTION 'Blocking overlap remains'; END IF;
END $post$;
COMMIT;
