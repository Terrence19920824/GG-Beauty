BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- Required only to make the tenant-scoped line-item FK legally referenceable;
-- it does not rewrite business rows.
DO $$
DECLARE
  target_name CONSTANT text := 'appointment_items_shop_id_id_key';
  has_equivalent boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace='public'::regnamespace
      AND relname IN ('checkout_transactions','checkout_line_items','checkout_payments','checkout_staff_attributions')
  ) THEN RAISE EXCEPTION 'checkout schema already exists; do not rerun 048'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid='public.appointment_items'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND ARRAY(SELECT key.attnum FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ord) ORDER BY key.ord) = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid='public.appointment_items'::regclass AND attname='shop_id' AND NOT attisdropped),
        (SELECT attnum FROM pg_attribute WHERE attrelid='public.appointment_items'::regclass AND attname='id' AND NOT attisdropped)
      ]::smallint[]
  ) INTO has_equivalent;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relname=target_name
  ) AND NOT has_equivalent THEN
    RAISE EXCEPTION 'checkout prerequisite name % exists but is not an equivalent valid unique index', target_name;
  END IF;

  IF NOT has_equivalent THEN
    ALTER TABLE public.appointment_items ADD CONSTRAINT appointment_items_shop_id_id_key UNIQUE (shop_id,id);
  END IF;
END $$;
CREATE TABLE public.checkout_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, appointment_id uuid NOT NULL, customer_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'draft', currency_code char(3) NOT NULL, quote_total_minor bigint NOT NULL, actual_total_minor bigint NOT NULL, discount_total_minor bigint NOT NULL DEFAULT 0, final_due_minor bigint NOT NULL, paid_minor bigint NOT NULL DEFAULT 0,
 idempotency_key text NOT NULL, customer_display_snapshot jsonb, signature_snapshot jsonb, created_by_owner_id uuid, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT checkout_status CHECK(status IN ('draft','paid','void','partially_refunded','refunded')),
 CONSTRAINT checkout_amounts CHECK(quote_total_minor>=0 AND actual_total_minor>=0 AND discount_total_minor>=0 AND final_due_minor=actual_total_minor-discount_total_minor AND paid_minor>=0 AND paid_minor<=final_due_minor),
 CONSTRAINT checkout_appointment_one UNIQUE(shop_id,appointment_id), CONSTRAINT checkout_idempotency_one UNIQUE(shop_id,idempotency_key), CONSTRAINT checkout_shop_id_key UNIQUE(shop_id,id),
 FOREIGN KEY(shop_id,appointment_id) REFERENCES public.appointments(shop_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.checkout_line_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, checkout_id uuid NOT NULL, appointment_item_id uuid, line_type text NOT NULL, description_snapshot text NOT NULL, quote_price_minor bigint NOT NULL DEFAULT 0, actual_price_minor bigint NOT NULL DEFAULT 0, discount_minor bigint NOT NULL DEFAULT 0, final_value_minor bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT checkout_line_type CHECK(line_type IN ('service','package_sale','package_redemption','stored_value_principal','stored_value_bonus','points_redemption','discount','refund_adjustment')),
 CONSTRAINT checkout_line_amounts CHECK(quote_price_minor>=0 AND actual_price_minor>=0 AND discount_minor>=0 AND final_value_minor=actual_price_minor-discount_minor), CONSTRAINT checkout_line_shop_id_key UNIQUE(shop_id,id),
 FOREIGN KEY(shop_id,checkout_id) REFERENCES public.checkout_transactions(shop_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(shop_id,appointment_item_id) REFERENCES public.appointment_items(shop_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.checkout_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, checkout_id uuid NOT NULL, payment_method text NOT NULL, value_kind text NOT NULL, amount_minor bigint NOT NULL, cash_collected_minor bigint NOT NULL DEFAULT 0, provider_reference text, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT checkout_payment_method CHECK(payment_method IN ('cash','card','paynow_qr','other')), CONSTRAINT checkout_payment_kind CHECK(value_kind IN ('cash_collected','service_revenue','package_sale','package_redemption','stored_value_principal','stored_value_bonus','points_redemption','refund')),
 CONSTRAINT checkout_payment_amount CHECK(amount_minor>=0 AND cash_collected_minor>=0 AND cash_collected_minor<=amount_minor),
 FOREIGN KEY(shop_id,checkout_id) REFERENCES public.checkout_transactions(shop_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.checkout_staff_attributions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, checkout_line_item_id uuid NOT NULL, staff_id uuid NOT NULL, attribution_role text NOT NULL, attribution_minor bigint NOT NULL DEFAULT 0, commission_rule_snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT checkout_attribution_role CHECK(attribution_role IN ('salesperson','primary','assistant','commission')), CONSTRAINT checkout_attribution_amount CHECK(attribution_minor>=0),
 FOREIGN KEY(shop_id,checkout_line_item_id) REFERENCES public.checkout_line_items(shop_id,id) ON DELETE RESTRICT, FOREIGN KEY(shop_id,staff_id) REFERENCES public.staff(shop_id,id) ON DELETE RESTRICT
);
CREATE INDEX checkout_transactions_appointment_idx ON public.checkout_transactions(shop_id,appointment_id);
CREATE INDEX checkout_payments_checkout_idx ON public.checkout_payments(shop_id,checkout_id);
CREATE INDEX checkout_staff_attribution_staff_idx ON public.checkout_staff_attributions(shop_id,staff_id,created_at);
COMMIT;
