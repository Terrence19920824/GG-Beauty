BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
 IF to_regclass('public.services') IS NULL OR to_regclass('public.shops') IS NULL THEN RAISE EXCEPTION 'required tables services/shops missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category' AND data_type='text') THEN RAISE EXCEPTION 'legacy services.category TEXT missing or drifted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.services'::regclass AND c.contype='u' AND (SELECT array_agg(a.attname::TEXT ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.attnum)=ARRAY['shop_id','id']::TEXT[]) THEN RAISE EXCEPTION 'services(shop_id,id) unique missing'; END IF;
 IF to_regclass('public.service_categories') IS NOT NULL OR to_regclass('public.service_category_translations') IS NOT NULL OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id') THEN RAISE EXCEPTION 'category foundation objects unexpectedly exist; inspect schema drift'; END IF;
END $$;
WITH groups AS (
 SELECT shop_id,lower(btrim(category)) normalized,count(DISTINCT btrim(category)) variants,count(*) service_rows
 FROM services WHERE category IS NOT NULL AND btrim(category)<>'' GROUP BY shop_id,lower(btrim(category))
)
SELECT s.shop_id,count(*) services_total,
 count(*) FILTER(WHERE s.category IS NULL) category_null,
 count(*) FILTER(WHERE s.category IS NOT NULL AND btrim(s.category)='') category_blank,
 count(DISTINCT btrim(s.category)) FILTER(WHERE s.category IS NOT NULL AND btrim(s.category)<>'') distinct_legacy_categories,
 COALESCE((SELECT sum(g.service_rows) FROM groups g WHERE g.shop_id=s.shop_id AND g.variants=1),0) safely_backfillable_services,
 count(*) FILTER(WHERE s.category IS NOT NULL AND (btrim(s.category)='' OR EXISTS(SELECT 1 FROM groups g WHERE g.shop_id=s.shop_id AND g.normalized=lower(btrim(s.category)) AND g.variants>1))) not_automatically_backfillable
FROM services s GROUP BY s.shop_id ORDER BY s.shop_id;
WITH groups AS (
 SELECT shop_id,lower(btrim(category)) normalized,count(DISTINCT btrim(category)) variants,count(*) service_rows
 FROM services WHERE category IS NOT NULL AND btrim(category)<>'' GROUP BY shop_id,lower(btrim(category))
)
SELECT count(*) services_total,count(*) FILTER(WHERE category IS NULL) category_null,
 count(*) FILTER(WHERE category IS NOT NULL AND btrim(category)='') category_blank,
 count(DISTINCT (shop_id,btrim(category))) FILTER(WHERE category IS NOT NULL AND btrim(category)<>'') distinct_legacy_categories,
 COALESCE((SELECT sum(service_rows) FROM groups WHERE variants=1),0) safely_backfillable_services,
 count(*) FILTER(WHERE category IS NOT NULL AND (btrim(category)='' OR EXISTS(SELECT 1 FROM groups g WHERE g.shop_id=services.shop_id AND g.normalized=lower(btrim(services.category)) AND g.variants>1))) not_automatically_backfillable
FROM services;
ROLLBACK;
