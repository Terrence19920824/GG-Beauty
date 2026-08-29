-- GG-Beauty Staff Phase 1 preflight audit
-- Read-only review script for manual use in Supabase SQL Editor.
-- This script returns schema metadata and aggregate counts only.
-- It does not select customer names, phone numbers, email addresses, or notes.

-- 01 PostgreSQL version and UUID function availability
SELECT
  version() AS postgresql_version,
  current_setting('server_version') AS server_version;

SELECT
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = p.pronamespace
    WHERE p.proname = 'gen_random_uuid'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
      AND p.prorettype = 'uuid'::pg_catalog.regtype
  ) AS gen_random_uuid_available;


-- 02 Required table existence
WITH required_tables(table_name) AS (
  VALUES
    ('shops'),
    ('locations'),
    ('staff'),
    ('staff_working_hours'),
    ('appointments'),
    ('customers'),
    ('services')
)
SELECT
  r.table_name,
  (t.table_name IS NOT NULL) AS table_exists
FROM required_tables AS r
LEFT JOIN information_schema.tables AS t
  ON t.table_schema = 'public'
 AND t.table_name = r.table_name
 AND t.table_type = 'BASE TABLE'
ORDER BY r.table_name;


-- 03 Column names, types, nullability, and defaults
SELECT
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND c.table_name IN (
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services'
  )
ORDER BY c.table_name, c.ordinal_position;


-- 04 Migration-critical field types
WITH required_columns(table_name, column_name) AS (
  VALUES
    ('shops', 'id'),
    ('staff', 'id'),
    ('staff', 'shop_id'),
    ('locations', 'id'),
    ('locations', 'shop_id'),
    ('appointments', 'id'),
    ('appointments', 'shop_id'),
    ('appointments', 'location_id'),
    ('appointments', 'staff_id'),
    ('appointments', 'customer_id'),
    ('appointments', 'start_at'),
    ('appointments', 'end_at')
)
SELECT
  r.table_name,
  r.column_name,
  (c.column_name IS NOT NULL) AS column_exists,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM required_columns AS r
LEFT JOIN information_schema.columns AS c
  ON c.table_schema = 'public'
 AND c.table_name = r.table_name
 AND c.column_name = r.column_name
ORDER BY r.table_name, r.column_name;


-- 05 Primary keys, unique constraints, foreign keys, and other constraints
SELECT
  n.nspname AS table_schema,
  cls.relname AS table_name,
  con.conname AS constraint_name,
  CASE con.contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'c' THEN 'CHECK'
    WHEN 'x' THEN 'EXCLUSION'
    ELSE con.contype::TEXT
  END AS constraint_type,
  con.convalidated AS is_validated,
  pg_catalog.pg_get_constraintdef(con.oid, TRUE) AS constraint_definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS cls
  ON cls.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = cls.relnamespace
WHERE n.nspname = 'public'
  AND cls.relname IN (
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services'
  )
ORDER BY cls.relname, constraint_type, con.conname;


-- 06 Current index definitions
SELECT
  schemaname AS table_schema,
  tablename AS table_name,
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services'
  )
ORDER BY tablename, indexname;


-- 07 Existing UNIQUE(shop_id, id) or equivalent unique index
WITH unique_index_columns AS (
  SELECT
    tbl.relname AS table_name,
    idx.relname AS index_name,
    i.indisprimary AS is_primary,
    i.indisunique AS is_unique,
    i.indisvalid AS is_valid,
    i.indpred IS NULL AS is_not_partial,
    ARRAY_AGG(att.attname ORDER BY keys.ordinality) AS indexed_columns
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS tbl
    ON tbl.oid = i.indrelid
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = tbl.relnamespace
  JOIN pg_catalog.pg_class AS idx
    ON idx.oid = i.indexrelid
  JOIN LATERAL UNNEST(i.indkey)
    WITH ORDINALITY AS keys(attnum, ordinality)
    ON TRUE
  JOIN pg_catalog.pg_attribute AS att
    ON att.attrelid = tbl.oid
   AND att.attnum = keys.attnum
  WHERE n.nspname = 'public'
    AND tbl.relname IN (
      'staff',
      'locations',
      'customers',
      'services',
      'appointments'
    )
  GROUP BY
    tbl.relname,
    idx.relname,
    i.indisprimary,
    i.indisunique,
    i.indisvalid,
    i.indpred
)
SELECT
  table_name,
  index_name,
  is_primary,
  is_unique,
  is_valid,
  is_not_partial,
  indexed_columns,
  (
    is_unique
    AND is_valid
    AND is_not_partial
    AND indexed_columns = ARRAY['shop_id', 'id']::NAME[]
  ) AS is_exact_shop_id_id_unique
FROM unique_index_columns
ORDER BY table_name, index_name;


-- 08 Staff aggregate integrity checks; no staff private data is selected
SELECT
  COUNT(*) FILTER (WHERE s.shop_id IS NULL) AS null_shop_id_count,
  COUNT(*) FILTER (
    WHERE s.shop_id IS NOT NULL
      AND sh.id IS NULL
  ) AS orphan_shop_id_count
FROM public.staff AS s
LEFT JOIN public.shops AS sh
  ON sh.id = s.shop_id;

WITH duplicate_groups AS (
  SELECT
    shop_id,
    staff_code,
    COUNT(*) AS row_count
  FROM public.staff
  WHERE staff_code IS NOT NULL
  GROUP BY shop_id, staff_code
  HAVING COUNT(*) > 1
)
SELECT
  COUNT(*) AS duplicate_staff_code_group_count,
  COALESCE(SUM(row_count - 1), 0) AS duplicate_staff_code_excess_row_count
FROM duplicate_groups;


-- 09 Location aggregate integrity checks
SELECT
  COUNT(*) FILTER (WHERE l.shop_id IS NULL) AS null_shop_id_count,
  COUNT(*) FILTER (
    WHERE l.shop_id IS NOT NULL
      AND sh.id IS NULL
  ) AS orphan_shop_id_count
FROM public.locations AS l
LEFT JOIN public.shops AS sh
  ON sh.id = l.shop_id;


-- 10 Appointment aggregate integrity checks; no customer content is selected
SELECT
  COUNT(*) AS total_appointment_count,
  COUNT(*) FILTER (WHERE a.shop_id IS NULL) AS null_shop_id_count,
  COUNT(*) FILTER (WHERE a.staff_id IS NULL) AS null_staff_id_count,
  COUNT(*) FILTER (WHERE a.location_id IS NULL) AS null_location_id_count,
  COUNT(*) FILTER (WHERE a.customer_id IS NULL) AS null_customer_id_count,
  COUNT(*) FILTER (
    WHERE a.staff_id IS NOT NULL
      AND s.id IS NULL
  ) AS orphan_staff_id_count,
  COUNT(*) FILTER (
    WHERE a.location_id IS NOT NULL
      AND l.id IS NULL
  ) AS orphan_location_id_count,
  COUNT(*) FILTER (
    WHERE a.customer_id IS NOT NULL
      AND c.id IS NULL
  ) AS orphan_customer_id_count,
  COUNT(*) FILTER (
    WHERE a.shop_id IS NOT NULL
      AND s.id IS NOT NULL
      AND a.shop_id IS DISTINCT FROM s.shop_id
  ) AS staff_cross_shop_mismatch_count,
  COUNT(*) FILTER (
    WHERE a.shop_id IS NOT NULL
      AND l.id IS NOT NULL
      AND a.shop_id IS DISTINCT FROM l.shop_id
  ) AS location_cross_shop_mismatch_count
FROM public.appointments AS a
LEFT JOIN public.staff AS s
  ON s.id = a.staff_id
LEFT JOIN public.locations AS l
  ON l.id = a.location_id
LEFT JOIN public.customers AS c
  ON c.id = a.customer_id;


-- 11 staff_working_hours existence and required tenant columns
WITH required_columns(column_name) AS (
  VALUES ('shop_id'), ('location_id'), ('staff_id')
)
SELECT
  (tbl.table_name IS NOT NULL) AS table_exists,
  r.column_name,
  (c.column_name IS NOT NULL) AS column_exists,
  c.data_type,
  c.udt_name,
  c.is_nullable
FROM required_columns AS r
LEFT JOIN information_schema.tables AS tbl
  ON tbl.table_schema = 'public'
 AND tbl.table_name = 'staff_working_hours'
 AND tbl.table_type = 'BASE TABLE'
LEFT JOIN information_schema.columns AS c
  ON c.table_schema = 'public'
 AND c.table_name = 'staff_working_hours'
 AND c.column_name = r.column_name
ORDER BY r.column_name;

-- Optional-table exact counts. query_to_xml is used only to run the enclosed
-- aggregate SELECT when the table and all required columns exist. The enclosed
-- query returns counts only and does not return staff or customer content.
WITH readiness AS (
  SELECT
    pg_catalog.to_regclass('public.staff_working_hours') IS NOT NULL
      AS table_exists,
    COUNT(*) FILTER (
      WHERE column_name IN ('shop_id', 'location_id', 'staff_id')
    ) = 3 AS tenant_columns_exist
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'staff_working_hours'
), optional_audit AS (
  SELECT
    table_exists,
    tenant_columns_exist,
    CASE
      WHEN table_exists AND tenant_columns_exist THEN
        pg_catalog.query_to_xml(
          'SELECT
             COUNT(*) AS row_count,
             COUNT(*) FILTER (
               WHERE wh.staff_id IS NOT NULL AND s.id IS NULL
             ) AS orphan_staff_count,
             COUNT(*) FILTER (
               WHERE wh.location_id IS NOT NULL AND l.id IS NULL
             ) AS orphan_location_count,
             COUNT(*) FILTER (
               WHERE wh.shop_id IS NOT NULL
                 AND s.id IS NOT NULL
                 AND wh.shop_id IS DISTINCT FROM s.shop_id
             ) AS staff_cross_shop_mismatch_count,
             COUNT(*) FILTER (
               WHERE wh.shop_id IS NOT NULL
                 AND l.id IS NOT NULL
                 AND wh.shop_id IS DISTINCT FROM l.shop_id
             ) AS location_cross_shop_mismatch_count
           FROM public.staff_working_hours AS wh
           LEFT JOIN public.staff AS s ON s.id = wh.staff_id
           LEFT JOIN public.locations AS l ON l.id = wh.location_id',
          FALSE,
          TRUE,
          ''
        )
      ELSE NULL
    END AS audit_xml
  FROM readiness
)
SELECT
  table_exists,
  tenant_columns_exist,
  CASE
    WHEN audit_xml IS NULL THEN NULL
    ELSE ((pg_catalog.xpath('//row_count/text()', audit_xml))[1]::TEXT)::BIGINT
  END AS row_count,
  CASE
    WHEN audit_xml IS NULL THEN NULL
    ELSE ((pg_catalog.xpath('//orphan_staff_count/text()', audit_xml))[1]::TEXT)::BIGINT
  END AS orphan_staff_count,
  CASE
    WHEN audit_xml IS NULL THEN NULL
    ELSE ((pg_catalog.xpath('//orphan_location_count/text()', audit_xml))[1]::TEXT)::BIGINT
  END AS orphan_location_count,
  CASE
    WHEN audit_xml IS NULL THEN NULL
    ELSE ((pg_catalog.xpath('//staff_cross_shop_mismatch_count/text()', audit_xml))[1]::TEXT)::BIGINT
  END AS staff_cross_shop_mismatch_count,
  CASE
    WHEN audit_xml IS NULL THEN NULL
    ELSE ((pg_catalog.xpath('//location_cross_shop_mismatch_count/text()', audit_xml))[1]::TEXT)::BIGINT
  END AS location_cross_shop_mismatch_count
FROM optional_audit;


-- 12 Appointment row count, table size, ownership, and recent write timing
SELECT
  COUNT(*) AS total_appointment_count,
  MAX(created_at) AS most_recent_created_at,
  MAX(updated_at) AS most_recent_updated_at
FROM public.appointments;

SELECT
  c.relname AS table_name,
  pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.oid)) AS table_only_size,
  pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size(c.oid)) AS indexes_size,
  pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS total_size,
  pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
  pg_catalog.pg_get_userbyid(c.relowner) = current_user AS current_user_is_owner
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'appointments'
  AND c.relkind IN ('r', 'p');

SELECT
  schemaname AS table_schema,
  tablename AS table_name,
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'appointments'
ORDER BY indexname;


-- 13 Current database role and table ownership
SELECT
  current_user AS current_database_user,
  r.rolsuper AS is_superuser,
  r.rolbypassrls AS bypasses_row_level_security
FROM pg_catalog.pg_roles AS r
WHERE r.rolname = current_user;

SELECT
  c.relname AS table_name,
  pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
  pg_catalog.pg_get_userbyid(c.relowner) = current_user AS current_user_is_owner
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'shops',
    'locations',
    'staff',
    'staff_working_hours',
    'appointments',
    'customers',
    'services'
  )
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
