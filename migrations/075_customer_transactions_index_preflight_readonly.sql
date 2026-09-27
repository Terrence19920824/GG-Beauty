BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.checkout_transactions') IS NULL THEN
    RAISE EXCEPTION 'checkout_transactions is required before adding customer transaction history index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='checkout_transactions' AND column_name='customer_id' AND data_type='uuid'
  ) THEN
    RAISE EXCEPTION 'checkout_transactions.customer_id is missing or has an unexpected type';
  END IF;
END $preflight$;
COMMIT;
