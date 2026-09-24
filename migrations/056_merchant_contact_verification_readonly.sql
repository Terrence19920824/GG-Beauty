BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_customer_settings'
      AND column_name IN ('public_contact_phone','public_whatsapp_phone')) <> 2 THEN
    RAISE EXCEPTION 'Merchant contact columns missing';
  END IF;
END $verify$;
COMMIT;
