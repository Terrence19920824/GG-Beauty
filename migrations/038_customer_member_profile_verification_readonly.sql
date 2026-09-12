-- Strict read-only verification for member profile schema.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.shop_customer_settings') IS NULL OR to_regclass('public.shop_member_code_counters') IS NULL THEN
    RAISE EXCEPTION 'Member settings/counter tables missing';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'
      AND column_name IN ('member_code','date_of_birth','gender','phone_verified_at','identity_status')) <> 5 THEN
    RAISE EXCEPTION 'Customer member columns missing';
  END IF;
  IF EXISTS (SELECT 1 FROM customers WHERE member_code IS NOT NULL OR date_of_birth IS NOT NULL
    OR gender IS NOT NULL OR phone_verified_at IS NOT NULL OR identity_status<>'unverified_contact') THEN
    RAISE EXCEPTION '037 unexpectedly rewrote customer profile data';
  END IF;
END $verify$;
SELECT COUNT(*) AS customers_total FROM customers;
ROLLBACK;
