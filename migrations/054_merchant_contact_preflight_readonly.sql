BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL OR to_regclass('public.shop_customer_settings') IS NULL THEN
    RAISE EXCEPTION 'Merchant contact prerequisites missing';
  END IF;
END $preflight$;
COMMIT;
