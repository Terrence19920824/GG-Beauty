BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='appointments_returning_customer_lookup_idx' AND i.indisvalid AND i.indisready AND pg_get_indexdef(i.indexrelid) LIKE '%(shop_id, recipient_customer_id, start_at, id)%' AND pg_get_expr(i.indpred,i.indrelid) ~ 'status.*arrived.*in_service.*completed') THEN RAISE EXCEPTION 'returning-customer lookup index is missing or drifted'; END IF;
END $verify$;
COMMIT;
