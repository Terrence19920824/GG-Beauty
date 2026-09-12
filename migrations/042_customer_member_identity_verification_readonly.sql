-- Final member identity verification: strict read-only/fail-closed.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE member_code IS NULL) THEN RAISE EXCEPTION 'Missing member code'; END IF;
  IF EXISTS (SELECT 1 FROM customers GROUP BY shop_id,member_code HAVING COUNT(*)>1) THEN RAISE EXCEPTION 'Duplicate shop member code'; END IF;
  IF to_regclass('public.customer_phone_identities') IS NULL OR to_regclass('public.customer_otp_challenges') IS NULL
    OR to_regclass('public.customer_sessions') IS NULL OR to_regclass('public.customer_identity_audit') IS NULL THEN
    RAISE EXCEPTION 'Identity foundation tables missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.customers'::regclass
    AND tgname='customers_assign_member_code' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Member-code trigger missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.shops'::regclass
    AND tgname='shops_provision_customer_identity' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Shop provisioning trigger missing'; END IF;
  IF EXISTS (SELECT 1 FROM customer_phone_identities p LEFT JOIN customers c ON c.shop_id=p.shop_id AND c.id=p.customer_id WHERE c.id IS NULL)
    OR EXISTS (SELECT 1 FROM customer_sessions s LEFT JOIN customers c ON c.shop_id=s.shop_id AND c.id=s.customer_id WHERE c.id IS NULL) THEN
    RAISE EXCEPTION 'Cross-tenant/orphan identity row';
  END IF;
END $verify$;
SELECT COUNT(*) AS customers_total,COUNT(DISTINCT (shop_id,member_code)) AS distinct_member_codes FROM customers;
ROLLBACK;
