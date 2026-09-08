BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE unambiguous_legacy_categories ON COMMIT DROP AS
SELECT shop_id, MIN(btrim(category)) AS canonical_name
FROM services
WHERE category IS NOT NULL AND btrim(category)<>''
GROUP BY shop_id, lower(btrim(category))
HAVING count(DISTINCT btrim(category))=1;
INSERT INTO service_categories(shop_id,canonical_name)
SELECT shop_id,canonical_name FROM unambiguous_legacy_categories
ON CONFLICT(shop_id,canonical_name) DO NOTHING;
UPDATE services s SET category_id=c.id
FROM service_categories c
JOIN unambiguous_legacy_categories legacy ON legacy.shop_id=c.shop_id AND legacy.canonical_name=c.canonical_name
WHERE s.category IS NOT NULL AND s.category_id IS NULL AND c.shop_id=s.shop_id AND c.canonical_name=btrim(s.category);
COMMIT;
