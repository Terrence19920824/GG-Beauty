BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE category_backfill_metrics(metric TEXT PRIMARY KEY,value BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO category_backfill_metrics VALUES ('categories_before',(SELECT count(*) FROM service_categories)),('translations_before',(SELECT count(*) FROM service_category_translations));
CREATE TEMP TABLE unambiguous_legacy_categories ON COMMIT DROP AS
SELECT shop_id,MIN(btrim(category)) canonical_name FROM services
WHERE category IS NOT NULL AND btrim(category)<>'' GROUP BY shop_id,lower(btrim(category)) HAVING count(DISTINCT btrim(category))=1;
INSERT INTO service_categories(shop_id,canonical_name)
SELECT shop_id,canonical_name FROM unambiguous_legacy_categories ON CONFLICT(shop_id,canonical_name) DO NOTHING;
WITH linked AS (
 UPDATE services s SET category_id=c.id FROM service_categories c
 JOIN unambiguous_legacy_categories legacy ON legacy.shop_id=c.shop_id AND legacy.canonical_name=c.canonical_name
 WHERE s.category IS NOT NULL AND s.category_id IS NULL AND c.shop_id=s.shop_id AND c.canonical_name=btrim(s.category) RETURNING s.id
)
INSERT INTO category_backfill_metrics VALUES('linked_services_this_run',(SELECT count(*) FROM linked));
DO $$ DECLARE bad BIGINT; BEGIN
 SELECT count(*) INTO bad FROM services s JOIN service_categories c ON c.id=s.category_id WHERE c.shop_id<>s.shop_id;
 IF bad>0 THEN RAISE EXCEPTION 'cross-shop category links: %',bad; END IF;
 SELECT count(*) INTO bad FROM service_category_translations;
 IF bad<>(SELECT value FROM category_backfill_metrics WHERE metric='translations_before') THEN RAISE EXCEPTION 'backfill must not create translations'; END IF;
END $$;
SELECT (SELECT count(*) FROM service_categories)-(SELECT value FROM category_backfill_metrics WHERE metric='categories_before') created_category_count,
 (SELECT count(*) FROM service_category_translations)-(SELECT value FROM category_backfill_metrics WHERE metric='translations_before') created_translation_count,
 (SELECT value FROM category_backfill_metrics WHERE metric='linked_services_this_run') linked_service_count,
 (SELECT count(*) FROM services WHERE category_id IS NULL) remaining_unmapped_count;
COMMIT;
