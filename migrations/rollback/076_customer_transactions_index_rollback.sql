BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP INDEX IF EXISTS public.checkout_transactions_shop_customer_created_id_idx;

COMMIT;
