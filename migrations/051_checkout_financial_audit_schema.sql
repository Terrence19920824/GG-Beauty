BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
ALTER TABLE public.checkout_line_items ADD COLUMN price_override_reason text NULL, ADD COLUMN discount_reason text NULL,
 ADD CONSTRAINT checkout_line_override_reason_check CHECK ((actual_price_minor=quote_price_minor) OR (price_override_reason IS NOT NULL AND length(btrim(price_override_reason)) BETWEEN 3 AND 500)),
 ADD CONSTRAINT checkout_line_discount_reason_check CHECK ((discount_minor=0) OR (discount_reason IS NOT NULL AND length(btrim(discount_reason)) BETWEEN 3 AND 500));
CREATE TABLE public.checkout_financial_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, checkout_id uuid NOT NULL, appointment_id uuid NOT NULL, event_type text NOT NULL, before_snapshot jsonb, after_snapshot jsonb NOT NULL, reason text, operator_type text NOT NULL, operator_id uuid, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT checkout_financial_audit_event CHECK(event_type IN ('checkout_created','price_override','discount','payment_recorded','void','refund')),
 CONSTRAINT checkout_financial_audit_operator CHECK(operator_type IN ('owner','system')),
 CONSTRAINT checkout_financial_audit_reason CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
 FOREIGN KEY(shop_id,checkout_id) REFERENCES public.checkout_transactions(shop_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(shop_id,appointment_id) REFERENCES public.appointments(shop_id,id) ON DELETE RESTRICT
);
CREATE INDEX checkout_financial_audit_checkout_idx ON public.checkout_financial_audit(shop_id,checkout_id,created_at,id);
CREATE OR REPLACE FUNCTION public.reject_checkout_financial_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'checkout_financial_audit is immutable'; END; $$;
CREATE TRIGGER checkout_financial_audit_immutable BEFORE UPDATE OR DELETE ON public.checkout_financial_audit FOR EACH ROW EXECUTE FUNCTION public.reject_checkout_financial_audit_mutation();
COMMIT;
