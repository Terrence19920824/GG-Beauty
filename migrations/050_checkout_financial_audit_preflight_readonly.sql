DO $$ BEGIN
 IF to_regclass('public.checkout_transactions') IS NULL OR to_regclass('public.checkout_line_items') IS NULL THEN RAISE EXCEPTION 'checkout audit preflight: checkout schema missing'; END IF;
 IF to_regclass('public.checkout_financial_audit') IS NOT NULL THEN RAISE EXCEPTION 'checkout audit preflight: audit already exists'; END IF;
END $$;
