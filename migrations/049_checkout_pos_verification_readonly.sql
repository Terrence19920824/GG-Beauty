-- READ ONLY / fail closed: verifies the complete checkout schema contract.
DO $$
BEGIN
  IF to_regclass('public.checkout_transactions') IS NULL OR to_regclass('public.checkout_line_items') IS NULL
     OR to_regclass('public.checkout_payments') IS NULL OR to_regclass('public.checkout_staff_attributions') IS NULL
  THEN RAISE EXCEPTION 'checkout verification: table missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('checkout_transactions','id'),('checkout_transactions','shop_id'),('checkout_transactions','appointment_id'),('checkout_transactions','customer_id'),('checkout_transactions','currency_code'),('checkout_transactions','idempotency_key'),
      ('checkout_line_items','id'),('checkout_line_items','shop_id'),('checkout_line_items','checkout_id'),('checkout_line_items','line_type'),
      ('checkout_payments','id'),('checkout_payments','shop_id'),('checkout_payments','checkout_id'),('checkout_payments','payment_method'),
      ('checkout_staff_attributions','id'),('checkout_staff_attributions','shop_id'),('checkout_staff_attributions','checkout_line_item_id'),('checkout_staff_attributions','staff_id')
    ) AS expected(table_name,column_name)
    LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=expected.table_name AND c.column_name=expected.column_name
    WHERE c.column_name IS NULL OR c.is_nullable <> 'NO'
  ) THEN RAISE EXCEPTION 'checkout verification: required NOT NULL column missing or drifted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_transactions'::regclass AND conname='checkout_appointment_one' AND contype='u')
  THEN RAISE EXCEPTION 'checkout verification: one checkout constraint missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_transactions'::regclass AND conname='checkout_idempotency_one' AND contype='u')
  THEN RAISE EXCEPTION 'checkout verification: idempotency constraint missing'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_transactions'::regclass AND contype='f' AND confrelid='public.appointments'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, appointment_id) REFERENCES %appointments(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_transactions'::regclass AND contype='f' AND confrelid='public.customers'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, customer_id) REFERENCES %customers(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_line_items'::regclass AND contype='f' AND confrelid='public.checkout_transactions'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, checkout_id) REFERENCES %checkout_transactions(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_line_items'::regclass AND contype='f' AND confrelid='public.appointment_items'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, appointment_item_id) REFERENCES %appointment_items(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_payments'::regclass AND contype='f' AND confrelid='public.checkout_transactions'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, checkout_id) REFERENCES %checkout_transactions(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_staff_attributions'::regclass AND contype='f' AND confrelid='public.checkout_line_items'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, checkout_line_item_id) REFERENCES %checkout_line_items(shop_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_staff_attributions'::regclass AND contype='f' AND confrelid='public.staff'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id, staff_id) REFERENCES %staff(shop_id, id)%')
  THEN RAISE EXCEPTION 'checkout verification: tenant foreign key missing'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.checkout_transactions'::regclass AND indisunique AND indisvalid AND indisready AND indpred IS NULL AND pg_get_indexdef(indexrelid) LIKE '%(shop_id, appointment_id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.checkout_transactions'::regclass AND indisunique AND indisvalid AND indisready AND indpred IS NULL AND pg_get_indexdef(indexrelid) LIKE '%(shop_id, idempotency_key)%')
  THEN RAISE EXCEPTION 'checkout verification: required unique index missing'; END IF;

  IF EXISTS (SELECT 1 FROM checkout_transactions c LEFT JOIN appointments a ON a.shop_id=c.shop_id AND a.id=c.appointment_id WHERE a.id IS NULL)
     OR EXISTS (SELECT 1 FROM checkout_line_items l LEFT JOIN checkout_transactions c ON c.shop_id=l.shop_id AND c.id=l.checkout_id WHERE c.id IS NULL)
     OR EXISTS (SELECT 1 FROM checkout_payments p LEFT JOIN checkout_transactions c ON c.shop_id=p.shop_id AND c.id=p.checkout_id WHERE c.id IS NULL)
  THEN RAISE EXCEPTION 'checkout verification: tenant orphan'; END IF;
END $$;
