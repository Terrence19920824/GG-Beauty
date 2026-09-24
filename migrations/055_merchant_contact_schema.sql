BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.shop_customer_settings
  ADD COLUMN IF NOT EXISTS public_contact_phone TEXT NULL,
  ADD COLUMN IF NOT EXISTS public_whatsapp_phone TEXT NULL;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.shop_customer_settings'::regclass AND conname='shop_customer_settings_public_contact_phone_check') THEN
    ALTER TABLE public.shop_customer_settings ADD CONSTRAINT shop_customer_settings_public_contact_phone_check CHECK (public_contact_phone IS NULL OR public_contact_phone ~ '^\+[1-9][0-9]{6,14}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.shop_customer_settings'::regclass AND conname='shop_customer_settings_public_whatsapp_phone_check') THEN
    ALTER TABLE public.shop_customer_settings ADD CONSTRAINT shop_customer_settings_public_whatsapp_phone_check CHECK (public_whatsapp_phone IS NULL OR public_whatsapp_phone ~ '^\+[1-9][0-9]{6,14}$');
  END IF;
END $constraints$;
COMMIT;
