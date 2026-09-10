-- customers(shop_id,id) tenant-key prerequisite: strict read-only preflight.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  IF to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'Required customers table missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='shop_id' AND data_type='uuid' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='id' AND data_type='uuid' AND is_nullable='NO')
  THEN RAISE EXCEPTION 'customers shop_id/id definitions missing or drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.customers'::regclass
    AND c.contype='p' AND c.convalidated AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
  THEN RAISE EXCEPTION 'customers primary key baseline missing or drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index ix WHERE ix.indrelid='public.customers'::regclass
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN RAISE EXCEPTION 'customers(shop_id,id) index already exists; inspect before continuing'; END IF;
  IF EXISTS (SELECT 1 FROM customers GROUP BY shop_id,id HAVING COUNT(*)>1)
  THEN RAISE EXCEPTION 'duplicate customers(shop_id,id) detected'; END IF;
END $preflight$;

SELECT COUNT(*) AS customers_total,
  (SELECT COUNT(*) FROM (SELECT shop_id,id FROM customers GROUP BY shop_id,id HAVING COUNT(*)>1) d) AS duplicate_shop_id_id_groups;

ROLLBACK;
