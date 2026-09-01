-- GG-Beauty Appointment Multi-Service legacy backfill
--
-- Converts each legacy appointment into exactly one appointment item and one
-- primary staff assignment. This migration is intentionally data-only: it
-- does not alter parent appointments or any database schema.

BEGIN;

-- Do not wait indefinitely for production writes. SET LOCAL applies only to
-- this transaction and is released together with the table locks.
SET LOCAL lock_timeout = '5s';

-- Keep the validated legacy set stable for the entire backfill. Reads remain
-- available, while concurrent writes that could change the source or target
-- rows wait until this transaction finishes.
LOCK TABLE public.appointments IN SHARE MODE;
LOCK TABLE public.services IN SHARE MODE;
LOCK TABLE public.staff IN SHARE MODE;
LOCK TABLE public.locations IN SHARE MODE;
LOCK TABLE public.appointment_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.appointment_item_staff_assignments
  IN SHARE ROW EXCLUSIVE MODE;

-- Fail closed before inserting anything. Duration must be a positive, exact
-- whole number of minutes; it is never derived from services.duration_minutes.
DO $legacy_preconditions$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.appointments AS a
    LEFT JOIN public.services AS s
      ON s.shop_id = a.shop_id
     AND s.id = a.service_id
    LEFT JOIN public.staff AS st
      ON st.shop_id = a.shop_id
     AND st.id = a.staff_id
    LEFT JOIN public.locations AS l
      ON l.shop_id = a.shop_id
     AND l.id = a.location_id
    WHERE a.shop_id IS NULL
       OR a.location_id IS NULL
       OR a.service_id IS NULL
       OR a.staff_id IS NULL
       OR a.start_at IS NULL
       OR a.end_at IS NULL
       OR a.status IS NULL
       OR BTRIM(a.status) = ''
       OR a.created_at IS NULL
       OR a.updated_at IS NULL
       OR a.end_at <= a.start_at
       OR MOD(
            EXTRACT(EPOCH FROM (a.end_at - a.start_at))::NUMERIC,
            60
          ) <> 0
       OR (
            EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60
          ) > 2147483647
       OR s.id IS NULL
       OR s.name IS NULL
       OR st.id IS NULL
       OR l.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Legacy appointment preconditions failed';
  END IF;

  -- A previous successful execution is allowed. Any partial or conflicting
  -- representation must match the exact legacy projection before it can be
  -- completed; otherwise the migration aborts rather than guessing.
  IF EXISTS (
    SELECT 1
    FROM public.appointment_items AS ai
    LEFT JOIN public.appointments AS a
      ON a.shop_id = ai.shop_id
     AND a.location_id = ai.location_id
     AND a.id = ai.appointment_id
    LEFT JOIN public.services AS s
      ON s.shop_id = a.shop_id
     AND s.id = a.service_id
    WHERE ai.snapshot_source = 'legacy_backfill'
      AND (
        a.id IS NULL
        OR ai.sequence_no <> 1
        OR ai.service_id IS DISTINCT FROM a.service_id
        OR ai.service_name_snapshot IS DISTINCT FROM s.name
        OR ai.duration_minutes_snapshot IS DISTINCT FROM
          (
            EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60
          )::INTEGER
        OR ai.price_snapshot IS NOT NULL
        OR ai.start_at IS DISTINCT FROM a.start_at
        OR ai.end_at IS DISTINCT FROM a.end_at
        OR ai.status IS DISTINCT FROM a.status
        OR ai.created_at IS DISTINCT FROM a.created_at
        OR ai.updated_at IS DISTINCT FROM a.updated_at
      )
  ) THEN
    RAISE EXCEPTION
      'Existing legacy backfill item does not match its appointment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointment_items AS ai
    GROUP BY ai.shop_id, ai.location_id, ai.appointment_id
    HAVING COUNT(*) FILTER (
      WHERE ai.snapshot_source = 'legacy_backfill'
    ) > 1
  ) THEN
    RAISE EXCEPTION
      'More than one legacy backfill item exists for an appointment';
  END IF;

  -- Refuse to mix this one-time migration with an already-created non-legacy
  -- item model. On a valid rerun, every existing item is from this backfill.
  IF EXISTS (
    SELECT 1
    FROM public.appointment_items AS ai
    WHERE ai.snapshot_source <> 'legacy_backfill'
  ) THEN
    RAISE EXCEPTION
      'A non-legacy appointment item already exists';
  END IF;

  -- Any assignment already attached to a legacy item must be exactly the one
  -- expected primary assignment. Assistants and mismatched staff/times abort.
  IF EXISTS (
    SELECT 1
    FROM public.appointment_item_staff_assignments AS assignment
    JOIN public.appointment_items AS ai
      ON ai.shop_id = assignment.shop_id
     AND ai.location_id = assignment.location_id
     AND ai.id = assignment.appointment_item_id
    JOIN public.appointments AS a
      ON a.shop_id = ai.shop_id
     AND a.location_id = ai.location_id
     AND a.id = ai.appointment_id
    WHERE ai.snapshot_source = 'legacy_backfill'
      AND (
        assignment.role <> 'primary'
        OR assignment.staff_id IS DISTINCT FROM a.staff_id
        OR assignment.start_at IS DISTINCT FROM a.start_at
        OR assignment.end_at IS DISTINCT FROM a.end_at
        OR assignment.created_at IS DISTINCT FROM a.created_at
        OR assignment.updated_at IS DISTINCT FROM a.updated_at
      )
  ) THEN
    RAISE EXCEPTION
      'Existing legacy assignment does not match its appointment';
  END IF;
END
$legacy_preconditions$;

-- Insert only appointments without their tenant-scoped legacy item.
INSERT INTO public.appointment_items (
  shop_id,
  location_id,
  appointment_id,
  service_id,
  sequence_no,
  service_name_snapshot,
  duration_minutes_snapshot,
  price_snapshot,
  snapshot_source,
  start_at,
  end_at,
  status,
  created_at,
  updated_at
)
SELECT
  a.shop_id,
  a.location_id,
  a.id,
  a.service_id,
  1,
  s.name,
  (
    EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60
  )::INTEGER,
  NULL,
  'legacy_backfill',
  a.start_at,
  a.end_at,
  a.status,
  a.created_at,
  a.updated_at
FROM public.appointments AS a
JOIN public.services AS s
  ON s.shop_id = a.shop_id
 AND s.id = a.service_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.appointment_items AS existing
  WHERE existing.shop_id = a.shop_id
    AND existing.location_id = a.location_id
    AND existing.appointment_id = a.id
    AND existing.snapshot_source = 'legacy_backfill'
);

-- Insert exactly one primary assignment for every legacy item that does not
-- already have one. No assistant or performance allocation is created.
INSERT INTO public.appointment_item_staff_assignments (
  shop_id,
  location_id,
  appointment_item_id,
  staff_id,
  role,
  start_at,
  end_at,
  created_at,
  updated_at
)
SELECT
  ai.shop_id,
  ai.location_id,
  ai.id,
  a.staff_id,
  'primary',
  a.start_at,
  a.end_at,
  a.created_at,
  a.updated_at
FROM public.appointment_items AS ai
JOIN public.appointments AS a
  ON a.shop_id = ai.shop_id
 AND a.location_id = ai.location_id
 AND a.id = ai.appointment_id
WHERE ai.snapshot_source = 'legacy_backfill'
  AND NOT EXISTS (
    SELECT 1
    FROM public.appointment_item_staff_assignments AS existing
    WHERE existing.shop_id = ai.shop_id
      AND existing.location_id = ai.location_id
      AND existing.appointment_item_id = ai.id
  );

-- Verify the final one-to-one-to-one legacy projection. These checks also make
-- a second execution a safe no-op while rejecting any incomplete result.
DO $legacy_postconditions$
DECLARE
  expected_legacy_count BIGINT;
  total_item_count BIGINT;
  legacy_item_count BIGINT;
  total_assignment_count BIGINT;
  legacy_primary_count BIGINT;
BEGIN
  -- The appointments SHARE lock is still held, so this is the same stable
  -- legacy source set validated before the inserts.
  SELECT COUNT(*) INTO expected_legacy_count
  FROM public.appointments;

  SELECT COUNT(*) INTO legacy_item_count
  FROM public.appointment_items
  WHERE snapshot_source = 'legacy_backfill';

  SELECT COUNT(*) INTO total_item_count
  FROM public.appointment_items;

  SELECT COUNT(*) INTO legacy_primary_count
  FROM public.appointment_item_staff_assignments AS assignment
  JOIN public.appointment_items AS ai
    ON ai.shop_id = assignment.shop_id
   AND ai.location_id = assignment.location_id
   AND ai.id = assignment.appointment_item_id
  WHERE ai.snapshot_source = 'legacy_backfill'
    AND assignment.role = 'primary';

  SELECT COUNT(*) INTO total_assignment_count
  FROM public.appointment_item_staff_assignments;

  IF total_item_count <> expected_legacy_count
     OR legacy_item_count <> expected_legacy_count
     OR total_assignment_count <> expected_legacy_count
     OR legacy_primary_count <> expected_legacy_count THEN
    RAISE EXCEPTION
      'Legacy backfill count validation failed: eligible appointments %, total items %, legacy items %, total assignments %, primary assignments %',
      expected_legacy_count,
      total_item_count,
      legacy_item_count,
      total_assignment_count,
      legacy_primary_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointments AS a
    JOIN public.services AS s
      ON s.shop_id = a.shop_id
     AND s.id = a.service_id
    LEFT JOIN public.appointment_items AS ai
      ON ai.shop_id = a.shop_id
     AND ai.location_id = a.location_id
     AND ai.appointment_id = a.id
     AND ai.snapshot_source = 'legacy_backfill'
    LEFT JOIN public.appointment_item_staff_assignments AS assignment
      ON assignment.shop_id = ai.shop_id
     AND assignment.location_id = ai.location_id
     AND assignment.appointment_item_id = ai.id
     AND assignment.role = 'primary'
    WHERE ai.id IS NULL
       OR assignment.id IS NULL
       OR ai.sequence_no <> 1
       OR ai.service_id IS DISTINCT FROM a.service_id
       OR ai.service_name_snapshot IS DISTINCT FROM s.name
       OR ai.duration_minutes_snapshot IS DISTINCT FROM
          (
            EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60
          )::INTEGER
       OR ai.price_snapshot IS NOT NULL
       OR ai.start_at IS DISTINCT FROM a.start_at
       OR ai.end_at IS DISTINCT FROM a.end_at
       OR ai.status IS DISTINCT FROM a.status
       OR ai.created_at IS DISTINCT FROM a.created_at
       OR ai.updated_at IS DISTINCT FROM a.updated_at
       OR assignment.staff_id IS DISTINCT FROM a.staff_id
       OR assignment.start_at IS DISTINCT FROM a.start_at
       OR assignment.end_at IS DISTINCT FROM a.end_at
       OR assignment.created_at IS DISTINCT FROM a.created_at
       OR assignment.updated_at IS DISTINCT FROM a.updated_at
  ) THEN
    RAISE EXCEPTION
      'Legacy backfill row validation failed';
  END IF;
END
$legacy_postconditions$;

COMMIT;
