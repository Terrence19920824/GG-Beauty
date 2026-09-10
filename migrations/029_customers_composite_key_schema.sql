-- Add only the tenant-safe composite customer key prerequisite.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'Required customers table missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.customers'::regclass
    AND c.contype='p' AND c.convalidated AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
  THEN RAISE EXCEPTION 'customers primary key baseline missing or drifted'; END IF;
  IF EXISTS (SELECT 1 FROM customers GROUP BY shop_id,id HAVING COUNT(*)>1)
  THEN RAISE EXCEPTION 'duplicate customers(shop_id,id) detected'; END IF;
  IF EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid='public.customers'::regclass
    AND ix.indnkeyatts=2 AND ix.indnatts=2
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
         JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[])
  THEN RAISE EXCEPTION 'customers(shop_id,id) index unexpectedly already exists'; END IF;
END $guard$;

CREATE UNIQUE INDEX customers_shop_id_id_uidx ON public.customers(shop_id,id);

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class idx ON idx.oid=ix.indexrelid
    WHERE ix.indrelid='public.customers'::regclass AND idx.relname='customers_shop_id_id_uidx'
      AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[])
  THEN RAISE EXCEPTION 'customers composite key creation verification failed'; END IF;
END $verify$;

COMMIT;
