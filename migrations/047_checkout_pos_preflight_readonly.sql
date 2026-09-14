-- READ ONLY / fail closed: checkout requires the existing tenant-safe appointment/customer keys.
DO $$ BEGIN
  IF to_regclass('public.appointments') IS NULL OR to_regclass('public.appointment_items') IS NULL OR to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'checkout preflight: required relation missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointments'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%UNIQUE (shop_id, id)%')
     AND NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.appointments'::regclass AND indisunique AND indisvalid AND indisready AND indpred IS NULL AND pg_get_indexdef(indexrelid) LIKE '%(shop_id, id)%') THEN RAISE EXCEPTION 'checkout preflight: appointments(shop_id,id) unique prerequisite missing'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('checkout_transactions','checkout_line_items','checkout_payments','checkout_staff_attributions') AND relnamespace='public'::regnamespace) THEN RAISE EXCEPTION 'checkout preflight: checkout objects already exist'; END IF;
END $$;
