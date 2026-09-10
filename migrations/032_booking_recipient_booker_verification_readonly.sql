-- Booker/recipient foundation: strict read-only verification.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE definition text;
BEGIN
  FOREACH definition IN ARRAY ARRAY[
    'FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT',
    'FOREIGN KEY (shop_id, booker_customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT',
    'FOREIGN KEY (shop_id, recipient_customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.appointments'::regclass
      AND c.contype='f' AND c.convalidated AND pg_get_constraintdef(c.oid)=definition)
    THEN RAISE EXCEPTION 'Required tenant-safe customer FK missing: %',definition; END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.appointments'::regclass
    AND c.contype='f' AND c.confrelid='public.customers'::regclass
    AND pg_get_constraintdef(c.oid)='FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT')
  THEN RAISE EXCEPTION 'Legacy single-column customer FK still exists'; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments'
      AND column_name='booker_customer_id' AND is_nullable='NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments'
      AND column_name='recipient_customer_id' AND is_nullable='NO')
  THEN RAISE EXCEPTION 'Booker/recipient nullability drifted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.appointments'::regclass
    AND c.conname='appointments_customer_recipient_match_check' AND c.convalidated
    AND pg_get_constraintdef(c.oid)='CHECK ((customer_id = recipient_customer_id))')
  THEN RAISE EXCEPTION 'Customer/recipient consistency constraint missing or drifted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.appointments'::regclass
    AND t.tgname='appointments_customer_parties_sync_trigger' AND NOT t.tgisinternal AND t.tgenabled='O')
  THEN RAISE EXCEPTION 'Customer party compatibility trigger missing or disabled'; END IF;

  IF EXISTS (SELECT 1 FROM appointments WHERE customer_id IS DISTINCT FROM recipient_customer_id
    OR recipient_customer_id IS NULL OR booker_customer_id IS NULL)
  THEN RAISE EXCEPTION 'Appointment party identity invariant failed'; END IF;
  IF EXISTS (SELECT 1 FROM appointments a LEFT JOIN customers c ON c.shop_id=a.shop_id AND c.id=a.customer_id WHERE c.id IS NULL)
     OR EXISTS (SELECT 1 FROM appointments a LEFT JOIN customers c ON c.shop_id=a.shop_id AND c.id=a.booker_customer_id WHERE c.id IS NULL)
     OR EXISTS (SELECT 1 FROM appointments a LEFT JOIN customers c ON c.shop_id=a.shop_id AND c.id=a.recipient_customer_id WHERE c.id IS NULL)
  THEN RAISE EXCEPTION 'Orphan or cross-tenant appointment party detected'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='customers'
    AND indexname='customers_shop_phone_normalized_idx'
    AND indexdef='CREATE INDEX customers_shop_phone_normalized_idx ON public.customers USING btree (shop_id, phone_normalized) WHERE (phone_normalized IS NOT NULL)')
  THEN RAISE EXCEPTION 'Phone normalized lookup index missing or drifted'; END IF;
END $verify$;

SELECT
  COUNT(*) AS appointment_total,
  COUNT(*) FILTER (WHERE booker_customer_id<>recipient_customer_id) AS booker_differs_from_recipient_count,
  COUNT(*) FILTER (WHERE booker_name_snapshot IS NULL AND recipient_name_snapshot IS NULL) AS legacy_null_snapshot_compatible_count
FROM appointments;

SELECT shop_id,phone_normalized,COUNT(*) AS duplicate_count
FROM customers WHERE phone_normalized IS NOT NULL
GROUP BY shop_id,phone_normalized HAVING COUNT(*)>1
ORDER BY shop_id,phone_normalized;

ROLLBACK;
