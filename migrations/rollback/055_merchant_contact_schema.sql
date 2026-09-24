-- Rollback is intentionally data-safe: it refuses to discard configured contact data.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $rollback$
DECLARE
  contact_columns_exist BOOLEAN;
  has_configured_contact BOOLEAN;
BEGIN
  SELECT COUNT(*) = 2 INTO contact_columns_exist
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='shop_customer_settings'
    AND column_name IN ('public_contact_phone','public_whatsapp_phone');
  IF contact_columns_exist THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.shop_customer_settings WHERE public_contact_phone IS NOT NULL OR public_whatsapp_phone IS NOT NULL)'
      INTO has_configured_contact;
  END IF;
  IF COALESCE(has_configured_contact, FALSE) THEN
    RAISE EXCEPTION 'Merchant contact rollback blocked: clear or archive configured values by approved migration first';
  END IF;
END $rollback$;
ALTER TABLE public.shop_customer_settings
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_contact_phone_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_whatsapp_phone_check,
  DROP COLUMN IF EXISTS public_contact_phone,
  DROP COLUMN IF EXISTS public_whatsapp_phone;
COMMIT;
