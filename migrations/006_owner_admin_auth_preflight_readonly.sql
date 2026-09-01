-- GG-Beauty owner/admin tenant authentication preflight
--
-- READ ONLY. This file contains catalog inspection and aggregate SELECT
-- queries only. It creates no objects and reads no password hashes, session
-- token hashes, customer data, or other secrets.

-- 01 PostgreSQL version and UUID generator availability
SELECT
  version() AS postgresql_version,
  current_setting('server_version') AS server_version;

SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = p.pronamespace
  WHERE p.proname = 'gen_random_uuid'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
    AND p.prorettype = 'uuid'::pg_catalog.regtype
) AS gen_random_uuid_available;


-- 02 Planned table existence (all must be false before migration 007)
WITH planned_tables(table_name) AS (
  VALUES
    ('owner_accounts'),
    ('owner_shop_memberships'),
    ('owner_sessions')
)
SELECT
  p.table_name,
  (t.table_name IS NOT NULL) AS already_exists
FROM planned_tables AS p
LEFT JOIN information_schema.tables AS t
  ON t.table_schema = 'public'
 AND t.table_name = p.table_name
ORDER BY p.table_name;


-- 03 Planned relation/index-name conflicts
-- Includes indexes created automatically for PK/UNIQUE constraints.
WITH planned_relations(relation_name) AS (
  VALUES
    ('owner_accounts'),
    ('owner_accounts_pkey'),
    ('owner_accounts_login_identifier_normalized_key'),
    ('owner_accounts_active_idx'),
    ('owner_shop_memberships'),
    ('owner_shop_memberships_pkey'),
    ('owner_shop_memberships_owner_shop_key'),
    ('owner_shop_memberships_identity_key'),
    ('owner_shop_memberships_account_active_idx'),
    ('owner_shop_memberships_shop_role_idx'),
    ('owner_sessions'),
    ('owner_sessions_pkey'),
    ('owner_sessions_token_hash_key'),
    ('owner_sessions_membership_active_idx'),
    ('owner_sessions_account_active_idx'),
    ('owner_sessions_expiry_idx')
)
SELECT
  p.relation_name,
  existing.table_schema AS existing_schema,
  existing.relkind AS existing_relkind
FROM planned_relations AS p
LEFT JOIN (
  SELECT
    c.relname,
    n.nspname AS table_schema,
    c.relkind
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
) AS existing
  ON existing.relname = p.relation_name
ORDER BY p.relation_name;


-- 04 Planned constraint-name conflicts in the public schema
WITH planned_constraints(constraint_name) AS (
  VALUES
    ('owner_accounts_pkey'),
    ('owner_accounts_login_identifier_normalized_key'),
    ('owner_accounts_identifier_check'),
    ('owner_accounts_display_name_check'),
    ('owner_accounts_password_hash_check'),
    ('owner_accounts_session_version_check'),
    ('owner_accounts_failed_attempts_check'),
    ('owner_shop_memberships_pkey'),
    ('owner_shop_memberships_account_fkey'),
    ('owner_shop_memberships_shop_fkey'),
    ('owner_shop_memberships_role_check'),
    ('owner_shop_memberships_owner_shop_key'),
    ('owner_shop_memberships_identity_key'),
    ('owner_sessions_pkey'),
    ('owner_sessions_token_hash_key'),
    ('owner_sessions_token_hash_check'),
    ('owner_sessions_membership_fkey'),
    ('owner_sessions_session_version_check'),
    ('owner_sessions_expiry_check'),
    ('owner_sessions_revoke_reason_check')
)
SELECT
  p.constraint_name,
  existing.table_schema AS existing_schema,
  existing.table_name AS existing_table,
  existing.contype AS existing_constraint_type
FROM planned_constraints AS p
LEFT JOIN (
  SELECT
    con.conname,
    n.nspname AS table_schema,
    c.relname AS table_name,
    con.contype
  FROM pg_catalog.pg_constraint AS con
  JOIN pg_catalog.pg_class AS c
    ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
) AS existing
  ON existing.conname = p.constraint_name
ORDER BY p.constraint_name;


-- 05 Authentication and tenant table columns
SELECT
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND c.table_name IN (
    'shops',
    'locations',
    'staff_accounts',
    'staff_sessions',
    'staff_permissions',
    'staff_location_assignments'
  )
ORDER BY c.table_name, c.ordinal_position;


-- 06 Existing PK, UNIQUE, FK, and CHECK support
SELECT
  cls.relname AS table_name,
  con.conname AS constraint_name,
  CASE con.contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'c' THEN 'CHECK'
    ELSE con.contype::TEXT
  END AS constraint_type,
  con.convalidated AS is_validated,
  pg_catalog.pg_get_constraintdef(con.oid, TRUE)
    AS constraint_definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS cls
  ON cls.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = cls.relnamespace
WHERE n.nspname = 'public'
  AND cls.relname IN (
    'shops',
    'locations',
    'staff_accounts',
    'staff_sessions',
    'staff_permissions',
    'staff_location_assignments'
  )
ORDER BY cls.relname, constraint_type, con.conname;


-- 07 Existing indexes used as tenant/auth design references
SELECT
  tablename AS table_name,
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'shops',
    'locations',
    'staff_accounts',
    'staff_sessions',
    'staff_permissions',
    'staff_location_assignments'
  )
ORDER BY tablename, indexname;


-- 08 Aggregate counts only; no credentials or personal fields are selected
SELECT
  (SELECT COUNT(*) FROM public.shops) AS shop_count,
  (SELECT COUNT(*) FROM public.locations) AS location_count,
  (SELECT COUNT(*) FROM public.staff_accounts) AS staff_account_count,
  (SELECT COUNT(*) FROM public.staff_sessions) AS staff_session_count,
  (SELECT COUNT(*) FROM public.staff_permissions) AS staff_permission_count,
  (
    SELECT COUNT(*)
    FROM public.staff_location_assignments
  ) AS staff_location_assignment_count;


-- 09 shops.id must remain a non-null UUID primary key for membership FK use
WITH shop_id_metadata AS (
  SELECT
    c.data_type,
    c.udt_name,
    c.is_nullable
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'shops'
    AND c.column_name = 'id'
), duplicate_shop_ids AS (
  SELECT id
  FROM public.shops
  GROUP BY id
  HAVING COUNT(*) > 1
)
SELECT
  m.data_type,
  m.udt_name,
  m.is_nullable,
  (
    SELECT COUNT(*)
    FROM duplicate_shop_ids
  ) AS duplicate_shop_id_group_count,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS cls
      ON cls.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = cls.relnamespace
    WHERE n.nspname = 'public'
      AND cls.relname = 'shops'
      AND con.contype = 'p'
      AND pg_catalog.pg_get_constraintdef(con.oid, TRUE)
        = 'PRIMARY KEY (id)'
  ) AS shops_id_is_primary_key
FROM shop_id_metadata AS m;


-- 10 Location ownership integrity for future location-scoped extensions
SELECT
  COUNT(*) FILTER (WHERE l.shop_id IS NULL) AS null_shop_id_count,
  COUNT(*) FILTER (
    WHERE l.shop_id IS NOT NULL AND s.id IS NULL
  ) AS orphan_shop_id_count
FROM public.locations AS l
LEFT JOIN public.shops AS s
  ON s.id = l.shop_id;


-- 11 Staff identifier normalization is inspected only as a reference pattern
SELECT
  COUNT(*) FILTER (
    WHERE login_identifier_normalized IS NULL
       OR BTRIM(login_identifier_normalized) = ''
  ) AS invalid_normalized_identifier_count,
  COUNT(*) - COUNT(DISTINCT (
    shop_id,
    login_identifier_normalized
  )) AS duplicate_shop_identifier_excess_count
FROM public.staff_accounts;
