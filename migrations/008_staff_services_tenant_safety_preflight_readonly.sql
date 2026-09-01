-- GG-Beauty staff_services tenant-safety preflight
-- READ ONLY: catalog inspection and aggregate validation only.
-- This file does not create objects or modify business data.

-- 01 Required table existence
WITH required_tables(table_name) AS (
  VALUES
    ('staff_services'),
    ('staff'),
    ('services')
)
SELECT
  required.table_name,
  (tables.table_name IS NOT NULL) AS table_exists,
  CASE
    WHEN tables.table_name IS NOT NULL THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM required_tables AS required
LEFT JOIN information_schema.tables AS tables
  ON tables.table_schema = 'public'
 AND tables.table_name = required.table_name
 AND tables.table_type = 'BASE TABLE'
ORDER BY required.table_name;

-- 02 Current staff_services columns, nullability, and defaults
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'staff_services'
ORDER BY ordinal_position;

-- 03 Required tenant-safe referenced unique keys
WITH unique_index_columns AS (
  SELECT
    table_class.relname AS table_name,
    index_class.relname AS index_name,
    index_meta.indisunique AS is_unique,
    index_meta.indisvalid AS is_valid,
    index_meta.indpred IS NULL AS is_not_partial,
    ARRAY_AGG(
      attribute.attname
      ORDER BY index_key.ordinality
    ) AS indexed_columns
  FROM pg_catalog.pg_index AS index_meta
  JOIN pg_catalog.pg_class AS table_class
    ON table_class.oid = index_meta.indrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = table_class.relnamespace
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_meta.indexrelid
  JOIN LATERAL UNNEST(index_meta.indkey)
    WITH ORDINALITY AS index_key(attnum, ordinality)
    ON TRUE
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = table_class.oid
   AND attribute.attnum = index_key.attnum
  WHERE namespace.nspname = 'public'
    AND table_class.relname IN ('staff', 'services')
  GROUP BY
    table_class.relname,
    index_class.relname,
    index_meta.indisunique,
    index_meta.indisvalid,
    index_meta.indpred
),
required_keys(table_name) AS (
  VALUES ('staff'), ('services')
)
SELECT
  required.table_name,
  COALESCE(
    BOOL_OR(
      indexes.is_unique
      AND indexes.is_valid
      AND indexes.is_not_partial
      AND indexes.indexed_columns =
        ARRAY['shop_id', 'id']::NAME[]
    ),
    FALSE
  ) AS tenant_unique_key_exists,
  CASE
    WHEN COALESCE(
      BOOL_OR(
        indexes.is_unique
        AND indexes.is_valid
        AND indexes.is_not_partial
        AND indexes.indexed_columns =
          ARRAY['shop_id', 'id']::NAME[]
      ),
      FALSE
    ) THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM required_keys AS required
LEFT JOIN unique_index_columns AS indexes
  ON indexes.table_name = required.table_name
GROUP BY required.table_name
ORDER BY required.table_name;

-- 04 Dynamic row count; no production count is hard-coded
SELECT COUNT(*) AS staff_services_count
FROM public.staff_services;

-- 05 Orphan staff rows
WITH orphan_rows AS (
  SELECT mapping.id
  FROM public.staff_services AS mapping
  LEFT JOIN public.staff AS staff_member
    ON staff_member.id = mapping.staff_id
  WHERE staff_member.id IS NULL
)
SELECT
  COUNT(*) AS orphan_staff_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM orphan_rows;

-- 06 Orphan service rows
WITH orphan_rows AS (
  SELECT mapping.id
  FROM public.staff_services AS mapping
  LEFT JOIN public.services AS service
    ON service.id = mapping.service_id
  WHERE service.id IS NULL
)
SELECT
  COUNT(*) AS orphan_service_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM orphan_rows;

-- 07 Existing cross-shop capability mappings
WITH cross_shop_rows AS (
  SELECT mapping.id
  FROM public.staff_services AS mapping
  JOIN public.staff AS staff_member
    ON staff_member.id = mapping.staff_id
  JOIN public.services AS service
    ON service.id = mapping.service_id
  WHERE staff_member.shop_id IS DISTINCT FROM service.shop_id
)
SELECT
  COUNT(*) AS cross_shop_mapping_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM cross_shop_rows;

-- 08 Duplicate future tenant mappings
WITH duplicate_groups AS (
  SELECT
    staff_member.shop_id,
    mapping.staff_id,
    mapping.service_id,
    COUNT(*) AS row_count
  FROM public.staff_services AS mapping
  JOIN public.staff AS staff_member
    ON staff_member.id = mapping.staff_id
  JOIN public.services AS service
    ON service.id = mapping.service_id
   AND service.shop_id = staff_member.shop_id
  GROUP BY
    staff_member.shop_id,
    mapping.staff_id,
    mapping.service_id
  HAVING COUNT(*) > 1
)
SELECT
  COUNT(*) AS duplicate_tenant_mapping_group_count,
  COALESCE(SUM(row_count - 1), 0) AS duplicate_tenant_mapping_row_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM duplicate_groups;

-- 09 is_active must exist and remain NOT NULL
SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_services'
      AND column_name = 'is_active'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) AS is_active_not_null_boolean,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'staff_services'
        AND column_name = 'is_active'
        AND data_type = 'boolean'
        AND is_nullable = 'NO'
    ) THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status;

-- 10 Existing staff_services foreign keys and delete behavior
SELECT
  constraint_meta.conname AS constraint_name,
  referenced_table.relname AS referenced_table,
  CASE constraint_meta.confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
    ELSE constraint_meta.confdeltype::TEXT
  END AS on_delete_behavior,
  pg_catalog.pg_get_constraintdef(
    constraint_meta.oid,
    TRUE
  ) AS constraint_definition
FROM pg_catalog.pg_constraint AS constraint_meta
JOIN pg_catalog.pg_class AS table_class
  ON table_class.oid = constraint_meta.conrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = table_class.relnamespace
JOIN pg_catalog.pg_class AS referenced_table
  ON referenced_table.oid = constraint_meta.confrelid
WHERE namespace.nspname = 'public'
  AND table_class.relname = 'staff_services'
  AND constraint_meta.contype = 'f'
ORDER BY constraint_meta.conname;

-- 11 Current staff_services indexes
SELECT
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'staff_services'
ORDER BY indexname;

-- 12 The two legacy CASCADE foreign keys must be present exactly as reviewed
WITH required_legacy_fk(constraint_name, referenced_table) AS (
  VALUES
    ('staff_services_staff_id_fkey', 'staff'),
    ('staff_services_service_id_fkey', 'services')
)
SELECT
  required.constraint_name,
  required.referenced_table,
  (
    constraint_meta.oid IS NOT NULL
    AND referenced_table.oid IS NOT NULL
    AND constraint_meta.confdeltype = 'c'
  ) AS reviewed_cascade_fk_exists,
  CASE
    WHEN constraint_meta.oid IS NOT NULL
      AND referenced_table.oid IS NOT NULL
      AND constraint_meta.confdeltype = 'c'
    THEN 'PASS'
    ELSE 'BLOCKER / FAIL'
  END AS preflight_status
FROM required_legacy_fk AS required
LEFT JOIN pg_catalog.pg_constraint AS constraint_meta
  ON constraint_meta.conrelid =
       'public.staff_services'::pg_catalog.regclass
 AND constraint_meta.conname = required.constraint_name
 AND constraint_meta.contype = 'f'
LEFT JOIN pg_catalog.pg_class AS referenced_table
  ON referenced_table.oid = constraint_meta.confrelid
 AND referenced_table.relname = required.referenced_table
ORDER BY required.constraint_name;

-- 13 shop_id and target object-name conflicts
WITH planned_objects(object_type, object_name) AS (
  VALUES
    ('column', 'shop_id'),
    ('constraint', 'staff_services_shop_staff_fkey'),
    ('constraint', 'staff_services_shop_service_fkey'),
    ('constraint', 'staff_services_shop_staff_service_key')
)
SELECT
  planned.object_type,
  planned.object_name,
  CASE
    WHEN planned.object_type = 'column' THEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'staff_services'
        AND column_name = planned.object_name
    )
    ELSE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_meta
      WHERE constraint_meta.conrelid =
              'public.staff_services'::pg_catalog.regclass
        AND constraint_meta.conname = planned.object_name
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS object_class
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = object_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND object_class.relname = planned.object_name
    )
  END AS name_already_exists,
  CASE
    WHEN (
      planned.object_type = 'column'
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'staff_services'
          AND column_name = planned.object_name
      )
    ) OR (
      planned.object_type = 'constraint'
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_meta
        WHERE constraint_meta.conrelid =
                'public.staff_services'::pg_catalog.regclass
          AND constraint_meta.conname = planned.object_name
      )
    ) OR (
      planned.object_type = 'constraint'
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS object_class
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = object_class.relnamespace
        WHERE namespace.nspname = 'public'
          AND object_class.relname = planned.object_name
      )
    ) THEN 'BLOCKER / FAIL'
    ELSE 'PASS'
  END AS preflight_status
FROM planned_objects AS planned
ORDER BY planned.object_type, planned.object_name;
