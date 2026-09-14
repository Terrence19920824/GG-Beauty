DO $$ BEGIN
 IF to_regclass('public.checkout_financial_audit') IS NULL THEN RAISE EXCEPTION 'checkout audit verification: missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='checkout_financial_audit_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'checkout audit verification: immutability trigger missing'; END IF;
 IF EXISTS (SELECT 1 FROM checkout_line_items WHERE (actual_price_minor<>quote_price_minor AND (price_override_reason IS NULL OR length(btrim(price_override_reason))<3)) OR (discount_minor>0 AND (discount_reason IS NULL OR length(btrim(discount_reason))<3))) THEN RAISE EXCEPTION 'checkout audit verification: reason invariant failed'; END IF;
END $$;
