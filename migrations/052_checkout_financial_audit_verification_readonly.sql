-- READ ONLY / fail closed: verifies audit integrity and immutability contract.
DO $$
BEGIN
  IF to_regclass('public.checkout_financial_audit') IS NULL THEN RAISE EXCEPTION 'checkout audit verification: missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('id'),('shop_id'),('checkout_id'),('appointment_id'),('event_type'),('after_snapshot'),('operator_type'),('source'),('created_at')
    ) AS expected(column_name)
    LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name='checkout_financial_audit' AND c.column_name=expected.column_name
    WHERE c.column_name IS NULL OR c.is_nullable <> 'NO'
  ) THEN RAISE EXCEPTION 'checkout audit verification: required column missing or nullable'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_financial_audit'::regclass AND contype='f' AND confrelid='public.checkout_transactions'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, checkout_id) REFERENCES %checkout_transactions(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_financial_audit'::regclass AND contype='f' AND confrelid='public.appointments'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, appointment_id) REFERENCES %appointments(shop_id, id)%')
  THEN RAISE EXCEPTION 'checkout audit verification: tenant foreign key missing'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_line_items'::regclass AND conname='checkout_line_override_reason_check' AND contype='c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_line_items'::regclass AND conname='checkout_line_discount_reason_check' AND contype='c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_financial_audit'::regclass AND conname='checkout_financial_audit_reason' AND contype='c')
  THEN RAISE EXCEPTION 'checkout audit verification: reason constraint missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='checkout_financial_audit_immutable' AND t.tgenabled='O'
      AND t.tgrelid='public.checkout_financial_audit'::regclass
      AND t.tgfoid='public.reject_checkout_financial_audit_mutation()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='public.reject_checkout_financial_audit_mutation()'::regprocedure
      AND pg_get_functiondef(p.oid) LIKE '%RAISE EXCEPTION ''checkout_financial_audit is immutable''%'
  ) THEN RAISE EXCEPTION 'checkout audit verification: immutable trigger/function drift'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.checkout_financial_audit'::regclass AND indisvalid AND indisready AND indpred IS NULL AND pg_get_indexdef(indexrelid) LIKE '%(shop_id, checkout_id, created_at, id)%')
  THEN RAISE EXCEPTION 'checkout audit verification: checkout lookup index missing'; END IF;

  IF EXISTS (SELECT 1 FROM checkout_line_items WHERE (actual_price_minor<>quote_price_minor AND (price_override_reason IS NULL OR length(btrim(price_override_reason)) NOT BETWEEN 3 AND 500)) OR (discount_minor>0 AND (discount_reason IS NULL OR length(btrim(discount_reason)) NOT BETWEEN 3 AND 500)))
     OR EXISTS (SELECT 1 FROM checkout_financial_audit a LEFT JOIN checkout_transactions c ON c.shop_id=a.shop_id AND c.id=a.checkout_id WHERE c.id IS NULL)
  THEN RAISE EXCEPTION 'checkout audit verification: invariant or tenant orphan'; END IF;
END $$;
