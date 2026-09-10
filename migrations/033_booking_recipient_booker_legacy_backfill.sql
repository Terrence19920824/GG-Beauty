-- Backfill legacy identity only. Historical contact snapshots intentionally remain NULL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

UPDATE public.appointments
SET booker_customer_id=customer_id,
    recipient_customer_id=customer_id
WHERE booker_customer_id IS NULL OR recipient_customer_id IS NULL;

UPDATE public.customers
SET phone_normalized=CASE
  WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^\+[1-9][0-9]{7,14}$'
    THEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g')
  WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^00[1-9][0-9]{7,14}$'
    THEN '+'||substr(regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g'),3)
  WHEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g') ~ '^[0-9]{8,15}$'
    THEN regexp_replace(BTRIM(phone),'[[:space:]().-]+','','g')
  ELSE NULL
END
WHERE phone_normalized IS NULL AND phone IS NOT NULL AND BTRIM(phone)<>'';

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM appointments WHERE booker_customer_id IS DISTINCT FROM customer_id OR recipient_customer_id IS DISTINCT FROM customer_id)
  THEN RAISE EXCEPTION 'Legacy appointment identity backfill mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE booker_name_snapshot IS NOT NULL OR booker_phone_snapshot IS NOT NULL
    OR booker_email_snapshot IS NOT NULL OR recipient_name_snapshot IS NOT NULL
    OR recipient_phone_snapshot IS NOT NULL OR recipient_email_snapshot IS NOT NULL)
  THEN RAISE EXCEPTION 'Historical contact snapshots must not be fabricated'; END IF;
END $verify$;

SELECT shop_id,phone_normalized,COUNT(*) AS duplicate_count
FROM customers WHERE phone_normalized IS NOT NULL
GROUP BY shop_id,phone_normalized HAVING COUNT(*)>1
ORDER BY shop_id,phone_normalized;

COMMIT;
