BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN RAISE EXCEPTION 'appointments is required'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name IN ('shop_id','recipient_customer_id','start_at','id','status')) <> 5 THEN RAISE EXCEPTION 'appointments returning-customer columns are missing'; END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='appointments_returning_customer_lookup_idx' AND indexdef NOT LIKE '%(shop_id, recipient_customer_id, start_at, id)%') THEN RAISE EXCEPTION 'returning-customer index conflicts'; END IF;
END $preflight$;
COMMIT;
