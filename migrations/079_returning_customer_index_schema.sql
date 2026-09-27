BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE INDEX IF NOT EXISTS appointments_returning_customer_lookup_idx ON public.appointments (shop_id, recipient_customer_id, start_at, id) WHERE status IN ('arrived','in_service','completed');
COMMIT;
