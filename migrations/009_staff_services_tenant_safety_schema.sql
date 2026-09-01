-- GG-Beauty staff_services tenant-safety schema hardening
-- This migration adds an authoritative shop_id, replaces legacy CASCADE
-- foreign keys with tenant-safe RESTRICT foreign keys, and preserves all rows
-- and is_active values. It intentionally does not add updated_at.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Keep referenced tenant identities stable, then prevent all concurrent access
-- that could observe or write a partially hardened staff_services table.
LOCK TABLE public.staff, public.services IN SHARE MODE;
LOCK TABLE public.staff_services IN ACCESS EXCLUSIVE MODE;

-- Fail closed before any schema change if data or schema differs from the
-- reviewed legacy state.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.staff_services') IS NULL
     OR pg_catalog.to_regclass('public.staff') IS NULL
     OR pg_catalog.to_regclass('public.services') IS NULL THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: required table missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_services'
      AND column_name = 'shop_id'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: shop_id already exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_services'
      AND column_name = 'is_active'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: is_active schema mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND conname IN (
        'staff_services_shop_staff_fkey',
        'staff_services_shop_service_fkey',
        'staff_services_shop_staff_service_key'
      )
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: target constraint conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS object_class
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = object_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND object_class.relname IN (
        'staff_services_shop_staff_fkey',
        'staff_services_shop_service_fkey',
        'staff_services_shop_staff_service_key'
      )
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: target index-name conflict';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND contype = 'f'
      AND confdeltype = 'c'
      AND (
        (
          conname = 'staff_services_staff_id_fkey'
          AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
            'FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE'
        )
        OR
        (
          conname = 'staff_services_service_id_fkey'
          AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
            'FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE'
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: legacy CASCADE FK mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_meta
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_meta.indexrelid
    WHERE index_class.oid =
            pg_catalog.to_regclass('public.staff_shop_id_id_uidx')
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indpred IS NULL
      AND pg_catalog.pg_get_indexdef(index_meta.indexrelid) =
        'CREATE UNIQUE INDEX staff_shop_id_id_uidx ON public.staff USING btree (shop_id, id)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_meta
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_meta.indexrelid
    WHERE index_class.oid =
            pg_catalog.to_regclass('public.services_shop_id_id_uidx')
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indpred IS NULL
      AND pg_catalog.pg_get_indexdef(index_meta.indexrelid) =
        'CREATE UNIQUE INDEX services_shop_id_id_uidx ON public.services USING btree (shop_id, id)'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: referenced tenant key missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    LEFT JOIN public.staff AS staff_member
      ON staff_member.id = mapping.staff_id
    WHERE staff_member.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: orphan staff mapping';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    LEFT JOIN public.services AS service
      ON service.id = mapping.service_id
    WHERE service.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: orphan service mapping';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    JOIN public.staff AS staff_member
      ON staff_member.id = mapping.staff_id
    JOIN public.services AS service
      ON service.id = mapping.service_id
    WHERE staff_member.shop_id IS DISTINCT FROM service.shop_id
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: cross-shop mapping';
  END IF;

  IF EXISTS (
    SELECT 1
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
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: duplicate tenant mapping';
  END IF;
END
$$;

CREATE TEMPORARY TABLE staff_services_tenant_safety_migration_state
ON COMMIT DROP
AS
SELECT
  id,
  is_active
FROM public.staff_services;

ALTER TABLE public.staff_services
  ADD COLUMN shop_id UUID;

UPDATE public.staff_services AS mapping
SET shop_id = staff_member.shop_id
FROM public.staff AS staff_member
JOIN public.services AS service
  ON service.shop_id = staff_member.shop_id
WHERE mapping.staff_id = staff_member.id
  AND mapping.service_id = service.id
  AND mapping.shop_id IS NULL;

-- Validate the backfill and preserved business state before enforcing NOT NULL.
DO $$
DECLARE
  expected_rows BIGINT;
  expected_active BIGINT;
  expected_inactive BIGINT;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE is_active),
    COUNT(*) FILTER (WHERE NOT is_active)
  INTO
    expected_rows,
    expected_active,
    expected_inactive
  FROM staff_services_tenant_safety_migration_state;

  IF (SELECT COUNT(*) FROM public.staff_services) <> expected_rows THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: row count changed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.staff_services
    WHERE is_active
  ) <> expected_active OR (
    SELECT COUNT(*)
    FROM public.staff_services
    WHERE NOT is_active
  ) <> expected_inactive THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: is_active values changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM staff_services_tenant_safety_migration_state AS original
    FULL JOIN public.staff_services AS current
      ON current.id = original.id
    WHERE original.id IS NULL
       OR current.id IS NULL
       OR current.is_active IS DISTINCT FROM original.is_active
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: row identity or is_active changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services
    WHERE shop_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: NULL shop_id after backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    JOIN public.staff AS staff_member
      ON staff_member.id = mapping.staff_id
    JOIN public.services AS service
      ON service.id = mapping.service_id
    WHERE mapping.shop_id IS DISTINCT FROM staff_member.shop_id
       OR mapping.shop_id IS DISTINCT FROM service.shop_id
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: tenant mismatch after backfill';
  END IF;
END
$$;

ALTER TABLE public.staff_services
  ALTER COLUMN shop_id SET NOT NULL;

ALTER TABLE public.staff_services
  DROP CONSTRAINT staff_services_staff_id_fkey,
  DROP CONSTRAINT staff_services_service_id_fkey;

ALTER TABLE public.staff_services
  ADD CONSTRAINT staff_services_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT staff_services_shop_service_fkey
    FOREIGN KEY (shop_id, service_id)
    REFERENCES public.services (shop_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT staff_services_shop_staff_service_key
    UNIQUE (shop_id, staff_id, service_id);

-- Final transaction-local verification of data, constraints, and delete rules.
DO $$
DECLARE
  expected_rows BIGINT;
  expected_active BIGINT;
  expected_inactive BIGINT;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE is_active),
    COUNT(*) FILTER (WHERE NOT is_active)
  INTO
    expected_rows,
    expected_active,
    expected_inactive
  FROM staff_services_tenant_safety_migration_state;

  IF (SELECT COUNT(*) FROM public.staff_services) <> expected_rows THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: final row count mismatch';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.staff_services
    WHERE is_active
  ) <> expected_active OR (
    SELECT COUNT(*)
    FROM public.staff_services
    WHERE NOT is_active
  ) <> expected_inactive THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: final is_active mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM staff_services_tenant_safety_migration_state AS original
    FULL JOIN public.staff_services AS current
      ON current.id = original.id
    WHERE original.id IS NULL
       OR current.id IS NULL
       OR current.is_active IS DISTINCT FROM original.is_active
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: final row state mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    JOIN public.staff AS staff_member
      ON staff_member.shop_id = mapping.shop_id
     AND staff_member.id = mapping.staff_id
    JOIN public.services AS service
      ON service.shop_id = mapping.shop_id
     AND service.id = mapping.service_id
    WHERE mapping.shop_id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.staff_services AS mapping
    LEFT JOIN public.staff AS staff_member
      ON staff_member.shop_id = mapping.shop_id
     AND staff_member.id = mapping.staff_id
    LEFT JOIN public.services AS service
      ON service.shop_id = mapping.shop_id
     AND service.id = mapping.service_id
    WHERE staff_member.id IS NULL
       OR service.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: final tenant mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_services'
      AND column_name = 'shop_id'
      AND is_nullable <> 'NO'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_services'
      AND column_name = 'shop_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: shop_id is not UUID NOT NULL';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND conname IN (
        'staff_services_shop_staff_fkey',
        'staff_services_shop_service_fkey'
      )
      AND contype = 'f'
      AND confdeltype = 'r'
      AND (
        (
          conname = 'staff_services_shop_staff_fkey'
          AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
            'FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT'
        )
        OR
        (
          conname = 'staff_services_shop_service_fkey'
          AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
            'FOREIGN KEY (shop_id, service_id) REFERENCES services(shop_id, id) ON DELETE RESTRICT'
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: RESTRICT FK verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND conname IN (
        'staff_services_staff_id_fkey',
        'staff_services_service_id_fkey'
      )
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: legacy FK still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND conname = 'staff_services_shop_staff_service_key'
      AND contype = 'u'
      AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
        'UNIQUE (shop_id, staff_id, service_id)'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: tenant UNIQUE missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_services'::pg_catalog.regclass
      AND conname = 'staff_services_staff_id_service_id_key'
      AND contype = 'u'
      AND pg_catalog.pg_get_constraintdef(oid, TRUE) =
        'UNIQUE (staff_id, service_id)'
  ) THEN
    RAISE EXCEPTION
      'staff_services tenant-safety migration: legacy UNIQUE changed';
  END IF;
END
$$;

COMMIT;
