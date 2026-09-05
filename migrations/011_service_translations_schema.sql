-- SERVICE I18N FOUNDATION schema.
-- Apply only after reviewing 010_service_translations_preflight_readonly.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Fail closed before DDL when an optional object already exists with drift.
DO $$
DECLARE
  column_shape JSONB;
  column_count INTEGER;
  check_expression TEXT;
BEGIN
  IF to_regclass('public.services') IS NULL
     OR to_regclass('public.appointment_items') IS NULL THEN
    RAISE EXCEPTION 'service i18n schema: required base table missing';
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
    RAISE EXCEPTION 'service i18n schema: services tenant unique key missing';
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
    RAISE EXCEPTION 'service i18n schema: services.price_is_from schema drift';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.appointment_items'::regclass
               AND attname = 'service_locale_snapshot' AND NOT attisdropped) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                   WHERE attrelid = 'public.appointment_items'::regclass
                     AND attname = 'service_locale_snapshot'
                     AND atttypid = 'text'::regtype
                     AND NOT attnotnull AND NOT attisdropped) THEN
      RAISE EXCEPTION 'service i18n schema: service_locale_snapshot column drift';
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
      RAISE EXCEPTION 'service i18n schema: service_locale_snapshot CHECK drift';
    END IF;
  END IF;

  IF to_regclass('public.service_translations') IS NULL THEN
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
    RAISE EXCEPTION 'service i18n schema: service_translations column drift';
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
    RAISE EXCEPTION 'service i18n schema: service_translations default drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'p'
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['id']::name[]
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations PK drift'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'u'
      AND (SELECT array_agg(a.attname ORDER BY k.n)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
           JOIN pg_catalog.pg_attribute AS a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['shop_id', 'service_id', 'locale']::name[]
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations UNIQUE drift'; END IF;

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
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations tenant FK drift'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
          IN ('(locale=ANY(ARRAY[''zh-CN''::text,''en''::text]))',
              '((locale=''zh-CN''::text)OR(locale=''en''::text))')
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations locale CHECK drift'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '\s+', '', 'g')
          IN ('(btrim(name)<>''''::text)', '(btrim(name)<>'''')')
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations name CHECK drift'; END IF;

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
  ) THEN RAISE EXCEPTION 'service i18n schema: service_translations lookup index drift'; END IF;
END
$$ LANGUAGE plpgsql;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS price_is_from BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.appointment_items
  ADD COLUMN IF NOT EXISTS service_locale_snapshot TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.appointment_items'::regclass
      AND contype = 'c'
      AND pg_catalog.pg_get_expr(conbin, conrelid) LIKE '%service_locale_snapshot%'
  ) THEN
    ALTER TABLE public.appointment_items
      ADD CONSTRAINT appointment_items_service_locale_snapshot_check
      CHECK (service_locale_snapshot IS NULL OR service_locale_snapshot IN ('zh-CN', 'en'));
  END IF;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.service_translations') IS NULL THEN
    CREATE TABLE public.service_translations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id UUID NOT NULL,
      service_id UUID NOT NULL,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT service_translations_locale_check CHECK (locale IN ('zh-CN', 'en')),
      CONSTRAINT service_translations_name_check CHECK (BTRIM(name) <> ''),
      CONSTRAINT service_translations_shop_service_locale_key
        UNIQUE (shop_id, service_id, locale),
      CONSTRAINT service_translations_shop_service_fkey
        FOREIGN KEY (shop_id, service_id)
        REFERENCES public.services (shop_id, id)
        ON DELETE RESTRICT
    );
  END IF;
END
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS service_translations_shop_locale_service_idx
  ON public.service_translations (shop_id, locale, service_id);

-- Final validation: all newly created or pre-existing objects must match.
DO $$
DECLARE
  column_shape JSONB;
  column_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_attrdef AS d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.services'::regclass
      AND a.attname = 'price_is_from'
      AND a.atttypid = 'boolean'::regtype AND a.attnotnull
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) IN ('false', 'false::boolean')
  ) THEN RAISE EXCEPTION 'service i18n schema: final price_is_from validation failed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.appointment_items'::regclass
      AND attname = 'service_locale_snapshot'
      AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.appointment_items'::regclass AND contype = 'c'
      AND regexp_replace(pg_catalog.pg_get_expr(conbin, conrelid), '\s+', '', 'g') IN (
        '((service_locale_snapshotISNULL)OR(service_locale_snapshot=ANY(ARRAY[''zh-CN''::text,''en''::text])))',
        '((service_locale_snapshotISNULL)OR((service_locale_snapshot=''zh-CN''::text)OR(service_locale_snapshot=''en''::text)))'
      )
  ) THEN RAISE EXCEPTION 'service i18n schema: final snapshot validation failed'; END IF;

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
    RAISE EXCEPTION 'service i18n schema: final column validation failed';
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
    RAISE EXCEPTION 'service i18n schema: final default validation failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'p'
      AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,n)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['id']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.service_translations'::regclass AND c.contype = 'u'
      AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,n)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['shop_id','service_id','locale']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid='public.service_translations'::regclass AND c.contype='f'
      AND c.confrelid='public.services'::regclass AND c.confdeltype='r'
      AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,n)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['shop_id','service_id']::name[]
      AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum,n)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.confrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.service_translations'::regclass AND c.contype='c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'\s+','','g') IN
          ('(locale=ANY(ARRAY[''zh-CN''::text,''en''::text]))','((locale=''zh-CN''::text)OR(locale=''en''::text))')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.service_translations'::regclass AND c.contype='c'
      AND regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'\s+','','g') IN
          ('(btrim(name)<>''''::text)','(btrim(name)<>'''')')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i WHERE i.indrelid='public.service_translations'::regclass
      AND i.indisvalid AND i.indpred IS NULL AND i.indnkeyatts=3
      AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,n)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.n<=i.indnkeyatts)
          =ARRAY['shop_id','locale','service_id']::name[]
  ) THEN RAISE EXCEPTION 'service i18n schema: final constraint/index validation failed'; END IF;
END
$$ LANGUAGE plpgsql;

COMMIT;
