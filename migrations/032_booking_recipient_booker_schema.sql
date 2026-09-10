-- Booker/recipient schema, snapshots, phone lookup, and tenant-safe customer FKs.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF to_regclass('public.customers') IS NULL OR to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'Required customers or appointments table missing';
  END IF;
  IF EXISTS (SELECT 1 FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id WHERE c.id IS NULL)
     OR EXISTS (SELECT 1 FROM appointments a JOIN customers c ON c.id=a.customer_id WHERE a.shop_id IS DISTINCT FROM c.shop_id)
  THEN RAISE EXCEPTION 'Appointment customer data is not safe for FK validation'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.appointments'::regclass
      AND c.conname='appointments_customer_id_fkey' AND c.convalidated
      AND pg_get_constraintdef(c.oid)='FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT'
  ) THEN RAISE EXCEPTION 'Legacy appointments customer FK missing or drifted'; END IF;
END $guard$;

DO $create_customer_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    WHERE ix.indrelid='public.customers'::regclass AND ix.indisunique
      AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN
    CREATE UNIQUE INDEX customers_shop_id_id_uidx ON public.customers(shop_id,id);
  END IF;
END $create_customer_key$;

DO $unique_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    WHERE ix.indrelid='public.customers'::regclass
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN RAISE EXCEPTION 'customers(shop_id,id) unique prerequisite missing or drifted'; END IF;
END $unique_guard$;

ALTER TABLE public.customers ADD COLUMN phone_normalized text;
ALTER TABLE public.customers ADD CONSTRAINT customers_phone_normalized_format_check
  CHECK (phone_normalized IS NULL OR phone_normalized ~ '^(\+[1-9][0-9]{7,14}|[0-9]{8,15})$');
CREATE INDEX customers_shop_phone_normalized_idx
  ON public.customers(shop_id,phone_normalized) WHERE phone_normalized IS NOT NULL;

ALTER TABLE public.appointments
  ADD COLUMN booker_customer_id uuid,
  ADD COLUMN recipient_customer_id uuid,
  ADD COLUMN booker_name_snapshot text,
  ADD COLUMN booker_phone_snapshot text,
  ADD COLUMN booker_email_snapshot text,
  ADD COLUMN recipient_name_snapshot text,
  ADD COLUMN recipient_phone_snapshot text,
  ADD COLUMN recipient_email_snapshot text;

ALTER TABLE public.appointments ADD CONSTRAINT appointments_booker_customer_fkey
  FOREIGN KEY (shop_id,booker_customer_id) REFERENCES public.customers(shop_id,id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.appointments VALIDATE CONSTRAINT appointments_booker_customer_fkey;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_recipient_customer_fkey
  FOREIGN KEY (shop_id,recipient_customer_id) REFERENCES public.customers(shop_id,id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.appointments VALIDATE CONSTRAINT appointments_recipient_customer_fkey;

ALTER TABLE public.appointments ADD CONSTRAINT appointments_customer_tenant_safe_fkey
  FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.appointments VALIDATE CONSTRAINT appointments_customer_tenant_safe_fkey;
ALTER TABLE public.appointments DROP CONSTRAINT appointments_customer_id_fkey;
ALTER TABLE public.appointments RENAME CONSTRAINT appointments_customer_tenant_safe_fkey TO appointments_customer_id_fkey;

COMMIT;
