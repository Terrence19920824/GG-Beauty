BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.shop_customer_settings
  ADD COLUMN IF NOT EXISTS public_address TEXT NULL,
  ADD COLUMN IF NOT EXISTS public_postal_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS public_map_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS show_public_address BOOLEAN NOT NULL DEFAULT TRUE;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.shop_customer_settings'::regclass AND conname='shop_customer_settings_public_address_check') THEN
    ALTER TABLE public.shop_customer_settings ADD CONSTRAINT shop_customer_settings_public_address_check CHECK (public_address IS NULL OR length(public_address) <= 255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.shop_customer_settings'::regclass AND conname='shop_customer_settings_public_postal_code_check') THEN
    ALTER TABLE public.shop_customer_settings ADD CONSTRAINT shop_customer_settings_public_postal_code_check CHECK (public_postal_code IS NULL OR length(public_postal_code) <= 16);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.shop_customer_settings'::regclass AND conname='shop_customer_settings_public_map_url_check') THEN
    ALTER TABLE public.shop_customer_settings ADD CONSTRAINT shop_customer_settings_public_map_url_check CHECK (public_map_url IS NULL OR public_map_url ~* '^https://');
  END IF;
END $constraints$;
COMMIT;
