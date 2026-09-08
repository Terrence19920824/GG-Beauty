BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE bad BIGINT;
BEGIN
  IF to_regclass('public.services') IS NULL OR to_regclass('public.shops') IS NULL THEN RAISE EXCEPTION 'required tables missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='services' AND c.contype='u' AND (SELECT array_agg(a.attname::TEXT ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.attnum)=ARRAY['shop_id','id']::TEXT[]) THEN RAISE EXCEPTION 'services(shop_id,id) unique missing'; END IF;
  IF to_regclass('public.service_categories') IS NOT NULL OR to_regclass('public.service_category_translations') IS NOT NULL OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id') THEN RAISE EXCEPTION 'category foundation objects unexpectedly exist'; END IF;
END $$;
ROLLBACK;
