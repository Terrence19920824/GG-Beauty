BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.assignment_collision_sync_parent_state()'::regprocedure AND pg_get_functiondef(oid) LIKE '%''arrived'',''in_service''%') THEN RAISE EXCEPTION 'arrival collision projection missing'; END IF;
  IF EXISTS (SELECT 1 FROM appointment_item_staff_assignments a JOIN appointment_items i ON i.id=a.appointment_item_id AND i.shop_id=a.shop_id AND i.location_id=a.location_id JOIN appointments p ON p.id=i.appointment_id AND p.shop_id=i.shop_id AND p.location_id=i.location_id WHERE a.blocks_time IS DISTINCT FROM (p.status IN ('pending','confirmed','arrived','in_service') AND p.override_conflict=FALSE)) THEN RAISE EXCEPTION 'projection mismatch'; END IF;
END $verify$;
ROLLBACK;
