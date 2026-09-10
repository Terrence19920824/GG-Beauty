-- Booking recipient/booker foundation: strict read-only preflight (after 028-030 prerequisite).
BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE legacy_definition text;
BEGIN
  IF to_regclass('public.customers') IS NULL OR to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'Required customers or appointments table missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='id' AND data_type='uuid' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='shop_id' AND data_type='uuid' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='phone')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='shop_id' AND data_type='uuid' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='customer_id' AND data_type='uuid' AND is_nullable='NO')
  THEN RAISE EXCEPTION 'Customer/appointment identity columns missing or drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid='public.customers'::regclass
    AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
    AND ix.indnkeyatts=2 AND ix.indnatts=2
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
         JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[])
  THEN RAISE EXCEPTION 'customers(shop_id,id) unique prerequisite missing or drifted'; END IF;

  SELECT pg_get_constraintdef(c.oid) INTO legacy_definition
  FROM pg_constraint c
  WHERE c.conrelid='public.appointments'::regclass
    AND c.conname='appointments_customer_id_fkey';
  IF legacy_definition IS DISTINCT FROM
    'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT' THEN
    RAISE EXCEPTION 'Legacy appointments customer FK missing or drifted: %',legacy_definition;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='appointments'
      AND column_name IN ('booker_customer_id','recipient_customer_id','booker_name_snapshot',
        'booker_phone_snapshot','booker_email_snapshot','recipient_name_snapshot',
        'recipient_phone_snapshot','recipient_email_snapshot')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='customers' AND column_name='phone_normalized'
  ) THEN RAISE EXCEPTION 'Recipient/booker foundation columns already exist'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id
    WHERE c.id IS NULL
  ) THEN RAISE EXCEPTION 'Missing appointment customer link detected'; END IF;
  IF EXISTS (
    SELECT 1 FROM appointments a JOIN customers c ON c.id=a.customer_id
    WHERE a.shop_id IS DISTINCT FROM c.shop_id
  ) THEN RAISE EXCEPTION 'Cross-shop appointment customer link detected'; END IF;
END $preflight$;

SELECT
  COUNT(*) AS appointment_total,
  COUNT(*) FILTER (WHERE customer_id IS NULL) AS null_customer_id_count,
  COUNT(*) FILTER (WHERE c.id IS NULL) AS missing_customer_link_count,
  COUNT(*) FILTER (WHERE c.id IS NOT NULL AND a.shop_id IS DISTINCT FROM c.shop_id) AS cross_shop_customer_link_count
FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id;

SELECT EXISTS (
  SELECT 1 FROM pg_index ix
  WHERE ix.indrelid='public.customers'::regclass
    AND ix.indisunique AND ix.indisvalid AND ix.indisready
    AND ix.indpred IS NULL AND ix.indexprs IS NULL
    AND ix.indnkeyatts=2 AND ix.indnatts=2
    AND (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
         JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)
      = ARRAY['shop_id','id']::name[]
) AS customers_shop_id_id_unique_ready;

WITH normalized AS (
  SELECT shop_id,phone,
    CASE
      WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^\+[1-9][0-9]{7,14}$'
        THEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g')
      WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^00[1-9][0-9]{7,14}$'
        THEN '+'||substr(regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g'),3)
      WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^[0-9]{8,15}$'
        THEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g')
      ELSE NULL
    END AS proposed_phone_normalized
  FROM customers
), duplicate_groups AS (
  SELECT shop_id,proposed_phone_normalized
  FROM normalized WHERE proposed_phone_normalized IS NOT NULL
  GROUP BY shop_id,proposed_phone_normalized HAVING COUNT(*)>1
)
SELECT
  (SELECT COUNT(*) FROM normalized WHERE phone IS NULL OR BTRIM(phone)='') AS blank_or_null_phone_count,
  (SELECT COUNT(*) FROM normalized WHERE phone IS NOT NULL AND BTRIM(phone)<>'' AND proposed_phone_normalized IS NULL) AS normalization_failure_count,
  (SELECT COUNT(*) FROM duplicate_groups) AS same_shop_normalized_duplicate_group_count;

ROLLBACK;
