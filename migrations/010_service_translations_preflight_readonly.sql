-- SERVICE I18N FOUNDATION preflight (STRICTLY READ ONLY).
-- Any incompatible existing object raises an exception. An absent optional
-- object is expected because 011_service_translations_schema.sql creates it.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  column_shape JSONB;
  column_count INTEGER;
  check_expression TEXT;
BEGIN
  IF to_regclass('public.services') IS NULL THEN
    RAISE EXCEPTION 'service i18n preflight: public.services is missing';
  END IF;
  IF to_regclass('public.appointment_items') IS NULL THEN
    RAISE EXCEPTION 'service i18n preflight: public.appointment_items is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
    WHERE i.indrelid = 'public.services'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND i.indnkeyatts = 2
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.n <= i.indnkeyatts) = ARRAY['shop_id', 'id']::name[]
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: services requires UNIQUE (shop_id, id)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.services'::regclass
               AND attname = 'price_is_from' AND NOT attisdropped)
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute AS a
       JOIN pg_catalog.pg_attrdef AS d
         ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.services'::regclass
         AND a.attname = 'price_is_from'
         AND a.atttypid = 'boolean'::regtype AND a.attnotnull
         AND pg_catalog.pg_get_expr(d.adbin, d.adrelid)
             IN ('false', 'false::boolean')
     ) THEN
    RAISE EXCEPTION 'service i18n preflight: services.price_is_from schema drift';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.appointment_items'::regclass
               AND attname = 'service_locale_snapshot' AND NOT attisdropped) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                   WHERE attrelid = 'public.appointment_items'::regclass
                     AND attname = 'service_locale_snapshot'
                     AND atttypid = 'text'::regtype
                     AND NOT attnotnull AND NOT attisdropped) THEN
      RAISE EXCEPTION 'service i18n preflight: service_locale_snapshot column drift';
    END IF;
    SELECT regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
      INTO check_expression
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.appointment_items'::regclass
       AND c.contype = 'c'
       AND pg_catalog.pg_get_expr(c.conbin, c.conrelid) LIKE '%service_locale_snapshot%'
     LIMIT 1;
    IF check_expression IS NULL OR check_expression NOT IN (
      '((service_locale_snapshotISNULL)OR(service_locale_snapshot=ANY(ARRAY[''zh-CN''::text,''en''::text])))',
      '((service_locale_snapshotISNULL)OR((service_locale_snapshot=''zh-CN''::text)OR(service_locale_snapshot=''en''::text)))'
    ) THEN
      RAISE EXCEPTION 'service i18n preflight: service_locale_snapshot CHECK drift';
    END IF;
  END IF;

  IF to_regclass('public.service_translations') IS NULL THEN
    RAISE NOTICE 'service_translations: EXPECTED ABSENT';
    RETURN;
  END IF;

  SELECT jsonb_object_agg(a.attname, jsonb_build_object(
           'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
           'not_null', a.attnotnull)), COUNT(*)
    INTO column_shape, column_count
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.service_translations'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;

  IF column_count <> 8
     OR column_shape -> 'id' IS DISTINCT FROM '{"type":"uuid","not_null":true}'::jsonb
     OR column_shape -> 'shop_id' IS DISTINCT FROM '{"type":"uuid","not_null":true}'::jsonb
     OR column_shape -> 'service_id' IS DISTINCT FROM '{"type":"uuid","not_null":true}'::jsonb
     OR column_shape -> 'locale' IS DISTINCT FROM '{"type":"text","not_null":true}'::jsonb
     OR column_shape -> 'name' IS DISTINCT FROM '{"type":"text","not_null":true}'::jsonb
     OR column_shape -> 'description' IS DISTINCT FROM '{"type":"text","not_null":false}'::jsonb
     OR column_shape -> 'created_at' IS DISTINCT FROM '{"type":"timestamp with time zone","not_null":true}'::jsonb
     OR column_shape -> 'updated_at' IS DISTINCT FROM '{"type":"timestamp with time zone","not_null":true}'::jsonb THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations column drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.service_translations'::regclass AND a.attname='id'
      AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='gen_random_uuid()'
  ) OR (SELECT COUNT(*) FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.service_translations'::regclass
          AND a.attname IN ('created_at','updated_at')
          AND lower(pg_catalog.pg_get_expr(d.adbin,d.adrelid)) IN ('now()','current_timestamp')) <> 2 THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations default drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'p'
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['id']::name[]
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations PK drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'u'
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['shop_id', 'service_id', 'locale']::name[]
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations UNIQUE drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass
      AND c.contype = 'f' AND c.confrelid = 'public.services'::regclass
      AND c.confdeltype = 'r'
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['shop_id', 'service_id']::name[]
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
          = ARRAY['shop_id', 'id']::name[]
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations tenant FK drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
          IN ('(locale=ANY(ARRAY[''zh-CN''::text,''en''::text]))',
              '((locale=''zh-CN''::text)OR(locale=''en''::text))')
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations locale CHECK drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
          IN ('(btrim(name)<>''''::text)', '(btrim(name)<>'''')')
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations name CHECK drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
    WHERE i.indrelid = 'public.service_translations'::regclass
      AND i.indisvalid AND i.indpred IS NULL AND i.indnkeyatts = 3
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.n <= i.indnkeyatts)
          = ARRAY['shop_id', 'locale', 'service_id']::name[]
  ) THEN
    RAISE EXCEPTION 'service i18n preflight: service_translations lookup index drift';
  END IF;
END
$$ LANGUAGE plpgsql;

COMMIT;
