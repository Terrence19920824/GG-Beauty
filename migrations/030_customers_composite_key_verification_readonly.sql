-- customers(shop_id,id) tenant-key prerequisite: strict read-only verification.
BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class idx ON idx.oid=ix.indexrelid
    WHERE ix.indrelid='public.customers'::regclass AND idx.relname='customers_shop_id_id_uidx'
      AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[])
  THEN RAISE EXCEPTION 'customers composite key missing or drifted'; END IF;
  IF EXISTS (SELECT 1 FROM customers GROUP BY shop_id,id HAVING COUNT(*)>1)
  THEN RAISE EXCEPTION 'duplicate customers(shop_id,id) detected'; END IF;
END $verify$;

SELECT COUNT(*) AS customers_total,
  (SELECT COUNT(*) FROM (SELECT shop_id,id FROM customers GROUP BY shop_id,id HAVING COUNT(*)>1) d) AS duplicate_shop_id_id_groups
FROM customers;

ROLLBACK;
