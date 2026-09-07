BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $pre$
BEGIN
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
