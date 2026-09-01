-- GG-Beauty Appointment Multi-Service preflight
-- READ ONLY: this file reports schema and data conditions only.

-- 01 PostgreSQL support required by the draft schema
SELECT
  version() AS postgresql_version,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = p.pronamespace
    WHERE p.proname = 'gen_random_uuid'
      AND pg_catalog.pg_get_function_result(p.oid) = 'uuid'
  ) AS gen_random_uuid_available;

-- 02 Existing appointment totals and required-column null counts
SELECT
  COUNT(*) AS appointment_count,
  COUNT(*) FILTER (WHERE shop_id IS NULL) AS null_shop_id_count,
  COUNT(*) FILTER (WHERE location_id IS NULL) AS null_location_id_count,
  COUNT(*) FILTER (WHERE customer_id IS NULL) AS null_customer_id_count,
  COUNT(*) FILTER (WHERE service_id IS NULL) AS null_service_id_count,
  COUNT(*) FILTER (WHERE staff_id IS NULL) AS null_staff_id_count,
  COUNT(*) FILTER (WHERE start_at IS NULL) AS null_start_at_count,
  COUNT(*) FILTER (WHERE end_at IS NULL) AS null_end_at_count,
  COUNT(*) FILTER (WHERE status IS NULL) AS null_status_count,
  COUNT(*) FILTER (WHERE booking_source IS NULL) AS null_booking_source_count,
  COUNT(*) FILTER (WHERE staff_selection_type IS NULL)
    AS null_staff_selection_type_count,
  COUNT(*) FILTER (WHERE override_conflict IS NULL)
    AS null_override_conflict_count,
  COUNT(*) FILTER (WHERE created_at IS NULL) AS null_created_at_count,
  COUNT(*) FILTER (WHERE updated_at IS NULL) AS null_updated_at_count,
  COUNT(*) FILTER (
    WHERE start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND end_at <= start_at
  ) AS invalid_time_range_count
FROM public.appointments;

-- 03 Exact core column definitions used by the draft
SELECT
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'appointments',
    'services',
    'locations',
    'staff'
  )
  AND column_name IN (
    'id',
    'shop_id',
    'location_id',
    'customer_id',
    'service_id',
    'staff_id',
    'start_at',
    'end_at',
    'status',
    'booking_source',
    'staff_selection_type',
    'override_conflict',
    'created_at',
    'updated_at',
    'name',
    'duration_minutes',
    'price'
  )
ORDER BY table_name, ordinal_position;

-- 04 Existing primary, unique, foreign-key, check, and exclusion constraints
SELECT
  c.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c
  ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'appointments',
    'services',
    'locations',
    'staff'
  )
ORDER BY c.relname, con.contype, con.conname;

-- 05 Unique indexes supporting current and future tenant-safe references
SELECT
  tablename AS table_name,
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'appointments',
    'services',
    'locations',
    'staff'
  )
  AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
ORDER BY tablename, indexname;

-- 06 Duplicate groups that would block services(shop_id, id)
SELECT
  COUNT(*) AS duplicate_services_shop_id_id_group_count
FROM (
  SELECT shop_id, id
  FROM public.services
  GROUP BY shop_id, id
  HAVING COUNT(*) > 1
) AS duplicate_groups;

-- 07 Future table-name conflicts
SELECT
  requested.object_name,
  to_regclass('public.' || requested.object_name) IS NOT NULL
    AS relation_already_exists
FROM (
  VALUES
    ('appointment_items'),
    ('appointment_item_staff_assignments')
) AS requested(object_name)
ORDER BY requested.object_name;

-- 08 Future index and constraint-name conflicts
SELECT
  requested.object_name,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = requested.object_name
  ) AS relation_name_exists,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    WHERE con.conname = requested.object_name
  ) AS constraint_name_exists
FROM (
  VALUES
    ('services_shop_id_id_uidx'),
    ('appointments_shop_location_id_uidx'),
    ('appointment_items_pkey'),
    ('appointment_items_sequence_check'),
    ('appointment_items_duration_check'),
    ('appointment_items_time_range_check'),
    ('appointment_items_price_check'),
    ('appointment_items_snapshot_source_check'),
    ('appointment_items_status_check'),
    ('appointment_items_shop_location_id_key'),
    ('appointment_items_appointment_sequence_key'),
    ('appointment_items_parent_fkey'),
    ('appointment_items_location_fkey'),
    ('appointment_items_service_fkey'),
    ('appointment_item_staff_assignments_pkey'),
    ('appointment_item_staff_role_check'),
    ('appointment_item_staff_time_range_check'),
    ('appointment_item_staff_assignment_staff_key'),
    ('appointment_item_staff_item_fkey'),
    ('appointment_item_staff_staff_fkey'),
    ('appointment_item_staff_primary_uidx'),
    ('appointment_items_service_idx'),
    ('appointment_item_staff_schedule_idx')
) AS requested(object_name)
ORDER BY requested.object_name;
