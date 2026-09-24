BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_customer_settings'
      AND column_name IN ('public_address','public_postal_code','public_map_url','show_public_address')) <> 4 THEN
    RAISE EXCEPTION 'Merchant address columns missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.shop_customer_settings'::regclass
      AND conname='shop_customer_settings_public_address_check'
  ) THEN
    RAISE EXCEPTION 'Merchant public address constraint is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.shop_customer_settings'::regclass
      AND conname='shop_customer_settings_public_postal_code_check'
  ) THEN
    RAISE EXCEPTION 'Merchant public postal code constraint is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.shop_customer_settings'::regclass
      AND conname='shop_customer_settings_public_map_url_check'
      AND position('^https://' in pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'Merchant public map url constraint is missing or invalid';
  END IF;
END $verify$;
COMMIT;
