-- Assignment collision projection functions and triggers. No backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
DECLARE function_count INTEGER; trigger_count INTEGER;
BEGIN
  IF to_regclass('public.appointment_item_staff_assignments') IS NULL THEN
    RAISE EXCEPTION 'Assignment table is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointment_item_staff_assignments' AND column_name='blocks_time' AND udt_name<>'bool') THEN
    RAISE EXCEPTION 'blocks_time schema drift';
  END IF;
  SELECT count(*) INTO function_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('assignment_collision_project','assignment_collision_sync_item_time','assignment_collision_sync_parent_state','assignment_collision_consistency_check');
  IF function_count NOT IN (0,4) THEN RAISE EXCEPTION 'Partial assignment collision function set'; END IF;
  IF function_count=4 AND (
    NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.assignment_collision_project()') AND pg_get_functiondef(oid) LIKE '%NEW.blocks_time%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.assignment_collision_sync_item_time()') AND pg_get_functiondef(oid) LIKE '%UPDATE public.appointment_item_staff_assignments%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.assignment_collision_sync_parent_state()') AND pg_get_functiondef(oid) LIKE '%NEW.override_conflict=FALSE%')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.assignment_collision_consistency_check()') AND pg_get_functiondef(oid) LIKE '%appointment assignment projection inconsistent%')
  ) THEN RAISE EXCEPTION 'Assignment collision function drift'; END IF;
  SELECT count(*) INTO trigger_count FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'assignment_collision_project_trigger','assignment_collision_item_time_trigger','assignment_collision_parent_state_trigger',
    'assignment_collision_consistency_trigger','assignment_collision_item_consistency_trigger','assignment_collision_parent_consistency_trigger');
  IF trigger_count NOT IN (0,6) THEN RAISE EXCEPTION 'Partial assignment collision trigger set'; END IF;
END $guard$;

ALTER TABLE public.appointment_item_staff_assignments
  ADD COLUMN IF NOT EXISTS blocks_time BOOLEAN NULL;

CREATE OR REPLACE FUNCTION public.assignment_collision_project()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE projection RECORD;
BEGIN
  SELECT i.location_id,i.start_at,i.end_at,
         (p.status IN ('pending','confirmed') AND p.override_conflict=FALSE) AS blocks_time
  INTO STRICT projection
  FROM public.appointment_items i
  JOIN public.appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
  JOIN public.staff s ON s.shop_id=i.shop_id AND s.id=NEW.staff_id
  WHERE i.id=NEW.appointment_item_id AND i.shop_id=NEW.shop_id AND i.location_id=NEW.location_id;
  NEW.start_at:=projection.start_at; NEW.end_at:=projection.end_at; NEW.blocks_time:=projection.blocks_time;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='assignment collision projection scope invalid';
END $fn$;

CREATE OR REPLACE FUNCTION public.assignment_collision_sync_item_time()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  UPDATE public.appointment_item_staff_assignments
  SET start_at=NEW.start_at,end_at=NEW.end_at,updated_at=NOW()
  WHERE shop_id=NEW.shop_id AND location_id=NEW.location_id AND appointment_item_id=NEW.id;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.assignment_collision_sync_parent_state()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  UPDATE public.appointment_item_staff_assignments a
  SET blocks_time=(NEW.status IN ('pending','confirmed') AND NEW.override_conflict=FALSE),updated_at=NOW()
  FROM public.appointment_items i
  WHERE i.shop_id=NEW.shop_id AND i.location_id=NEW.location_id AND i.appointment_id=NEW.id
    AND a.shop_id=i.shop_id AND a.location_id=i.location_id AND a.appointment_item_id=i.id;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.assignment_collision_consistency_check()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.appointment_item_staff_assignments a
    JOIN public.appointment_items i ON i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.id=a.appointment_item_id
    JOIN public.appointments p ON p.shop_id=i.shop_id AND p.location_id=i.location_id AND p.id=i.appointment_id
    WHERE a.start_at IS DISTINCT FROM i.start_at OR a.end_at IS DISTINCT FROM i.end_at
       OR a.blocks_time IS DISTINCT FROM (p.status IN ('pending','confirmed') AND p.override_conflict=FALSE)
  ) OR EXISTS (
    SELECT 1 FROM public.appointments p
    JOIN public.appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    GROUP BY p.id,p.start_at,p.end_at
    HAVING min(i.start_at) IS DISTINCT FROM p.start_at
        OR max(i.end_at) IS DISTINCT FROM p.end_at
  ) OR EXISTS (
    SELECT 1 FROM public.appointments p JOIN public.appointment_items i
      ON i.shop_id=p.shop_id AND i.location_id=p.location_id AND i.appointment_id=p.id
    LEFT JOIN public.appointment_item_staff_assignments a
      ON a.shop_id=i.shop_id AND a.location_id=i.location_id AND a.appointment_item_id=i.id AND a.role='primary'
    WHERE (SELECT count(*) FROM public.appointment_items x WHERE x.shop_id=p.shop_id AND x.appointment_id=p.id)=1
    GROUP BY p.id,p.staff_id
    HAVING count(a.id)<>1 OR bool_or(a.staff_id IS DISTINCT FROM p.staff_id)
  ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='appointment assignment projection inconsistent'; END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS assignment_collision_project_trigger ON public.appointment_item_staff_assignments;
CREATE TRIGGER assignment_collision_project_trigger
BEFORE INSERT OR UPDATE OF shop_id,location_id,appointment_item_id,staff_id,start_at,end_at,blocks_time
ON public.appointment_item_staff_assignments FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_project();

DROP TRIGGER IF EXISTS assignment_collision_item_time_trigger ON public.appointment_items;
CREATE TRIGGER assignment_collision_item_time_trigger AFTER UPDATE OF start_at,end_at ON public.appointment_items
FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_sync_item_time();

DROP TRIGGER IF EXISTS assignment_collision_parent_state_trigger ON public.appointments;
CREATE TRIGGER assignment_collision_parent_state_trigger AFTER UPDATE OF status,override_conflict ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_sync_parent_state();

DROP TRIGGER IF EXISTS assignment_collision_consistency_trigger ON public.appointment_item_staff_assignments;
CREATE CONSTRAINT TRIGGER assignment_collision_consistency_trigger
AFTER INSERT OR UPDATE ON public.appointment_item_staff_assignments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_consistency_check();

DROP TRIGGER IF EXISTS assignment_collision_item_consistency_trigger ON public.appointment_items;
CREATE CONSTRAINT TRIGGER assignment_collision_item_consistency_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.appointment_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_consistency_check();

DROP TRIGGER IF EXISTS assignment_collision_parent_consistency_trigger ON public.appointments;
CREATE CONSTRAINT TRIGGER assignment_collision_parent_consistency_trigger
AFTER UPDATE OF start_at,end_at,staff_id ON public.appointments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_consistency_check();

COMMIT;
