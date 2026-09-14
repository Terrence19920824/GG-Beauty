DO $$ BEGIN
 IF to_regclass('public.checkout_transactions') IS NULL OR to_regclass('public.checkout_line_items') IS NULL OR to_regclass('public.checkout_payments') IS NULL OR to_regclass('public.checkout_staff_attributions') IS NULL THEN RAISE EXCEPTION 'checkout verification: table missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkout_transactions'::regclass AND conname='checkout_appointment_one') THEN RAISE EXCEPTION 'checkout verification: one checkout constraint missing'; END IF;
 IF EXISTS (SELECT 1 FROM checkout_transactions c LEFT JOIN appointments a ON a.shop_id=c.shop_id AND a.id=c.appointment_id WHERE a.id IS NULL) THEN RAISE EXCEPTION 'checkout verification: orphan appointment'; END IF;
END $$;
