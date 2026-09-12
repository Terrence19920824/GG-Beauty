-- Customer member identity foundation: strict read-only preflight.
BEGIN TRANSACTION READ ONLY;
DO $guard$
BEGIN
  IF to_regclass('public.shops') IS NULL OR to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'Required shops/customers tables missing';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN RAISE EXCEPTION 'gen_random_uuid() prerequisite missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shops' AND column_name='slug')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shops' AND column_name='status') THEN
    RAISE EXCEPTION 'shops identity baseline missing or drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid='public.customers'::regclass
    AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]) THEN
    RAISE EXCEPTION 'customers(shop_id,id) prerequisite missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'
    AND column_name IN ('member_code','date_of_birth','gender','phone_verified_at','identity_status'))
    OR to_regclass('public.shop_customer_settings') IS NOT NULL
    OR to_regclass('public.shop_member_code_counters') IS NOT NULL
    OR to_regclass('public.customer_phone_identities') IS NOT NULL
    OR to_regclass('public.customer_otp_challenges') IS NOT NULL
    OR to_regclass('public.customer_sessions') IS NOT NULL
    OR to_regclass('public.customer_identity_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'Member identity objects already exist; inspect before continuing';
  END IF;
  IF EXISTS (SELECT 1 FROM customers WHERE phone_normalized IS NOT NULL
    GROUP BY shop_id,phone_normalized HAVING COUNT(*)>1) THEN
    RAISE EXCEPTION 'Ambiguous same-shop normalized phones require manual review';
  END IF;
END $guard$;
SELECT COUNT(*) AS customers_total,
  COUNT(*) FILTER (WHERE phone_normalized IS NOT NULL) AS normalized_phone_count,
  (SELECT COUNT(*) FROM (SELECT shop_id,phone_normalized FROM customers WHERE phone_normalized IS NOT NULL
    GROUP BY shop_id,phone_normalized HAVING COUNT(*)>1) d) AS ambiguous_phone_groups
FROM customers;
ROLLBACK;
