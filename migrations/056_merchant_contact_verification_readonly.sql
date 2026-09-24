BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_customer_settings'
      AND column_name IN ('public_contact_phone','public_whatsapp_phone')) <> 2 THEN
    RAISE EXCEPTION 'Merchant contact columns missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.shop_customer_settings'::regclass
      AND conname='shop_customer_settings_public_contact_phone_check'
      AND pg_get_constraintdef(oid) LIKE '%public_contact_phone ~ ''^\+[1-9][0-9]{6,14}$''%'
  ) THEN
    RAISE EXCEPTION 'Merchant public contact phone constraint is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.shop_customer_settings'::regclass
      AND conname='shop_customer_settings_public_whatsapp_phone_check'
      AND pg_get_constraintdef(oid) LIKE '%public_whatsapp_phone ~ ''^\+[1-9][0-9]{6,14}$''%'
  ) THEN
    RAISE EXCEPTION 'Merchant public WhatsApp phone constraint is missing or invalid';
  END IF;
END $verify$;
COMMIT;
