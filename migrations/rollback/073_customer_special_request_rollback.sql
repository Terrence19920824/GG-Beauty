-- Rollback is intentionally data-safe: it refuses to discard existing customer special requests.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  column_exists BOOLEAN;
  has_customer_special_requests BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name = 'customer_special_request'
  ) INTO column_exists;

  IF column_exists THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.appointments WHERE customer_special_request IS NOT NULL AND length(trim(customer_special_request)) > 0)'
      INTO has_customer_special_requests;
  END IF;

  IF COALESCE(has_customer_special_requests, FALSE) THEN
    RAISE EXCEPTION 'Customer special request rollback blocked: customer special requests exist; clear or archive them before dropping column';
  END IF;
END $rollback$;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_customer_special_request_length_check,
  DROP COLUMN IF EXISTS customer_special_request;
COMMIT;
