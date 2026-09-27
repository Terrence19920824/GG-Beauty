BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public'
       AND tablename='checkout_transactions'
       AND indexname='checkout_transactions_shop_customer_created_id_idx'
  ) THEN
    RAISE EXCEPTION 'customer transaction history index is missing';
  END IF;
END $verify$;
COMMIT;
