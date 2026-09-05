-- SERVICE I18N FOUNDATION preflight (READ ONLY).
-- This file intentionally contains no DDL or DML.

SELECT
  to_regclass('public.services') AS services_table,
  to_regclass('public.appointment_items') AS appointment_items_table,
  to_regclass('public.service_translations') AS service_translations_table;

SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  numeric_precision,
  numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'services'
  AND column_name IN (
    'id',
    'shop_id',
    'name',
    'description',
    'price',
    'price_is_from'
  )
ORDER BY ordinal_position;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'appointment_items'
  AND column_name IN (
    'service_name_snapshot',
    'service_locale_snapshot',
    'snapshot_source'
  )
ORDER BY ordinal_position;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'services'
  AND indexdef ILIKE '%(shop_id, id)%'
ORDER BY indexname;

SELECT
  COUNT(*) AS service_count,
  COUNT(*) FILTER (
    WHERE name IS NULL OR BTRIM(name) = ''
  ) AS invalid_service_name_count
FROM public.services;
