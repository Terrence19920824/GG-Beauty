BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS checkout_transactions_shop_customer_created_id_idx
  ON public.checkout_transactions (shop_id, customer_id, created_at DESC, id DESC);

COMMIT;
