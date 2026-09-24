-- Rollback is intentionally data-safe: it refuses to discard configured address data.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $rollback$
DECLARE
  address_columns_exist BOOLEAN;
  has_configured_address BOOLEAN;
BEGIN
  SELECT COUNT(*) = 4 INTO address_columns_exist
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='shop_customer_settings'
    AND column_name IN ('public_address','public_postal_code','public_map_url','show_public_address');
  IF address_columns_exist THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.shop_customer_settings WHERE public_address IS NOT NULL OR public_postal_code IS NOT NULL OR public_map_url IS NOT NULL)'
      INTO has_configured_address;
  END IF;
  IF COALESCE(has_configured_address, FALSE) THEN
    RAISE EXCEPTION 'Merchant address rollback blocked: clear or archive configured values by approved migration first';
  END IF;
END $rollback$;
ALTER TABLE public.shop_customer_settings
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_address_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_postal_code_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_map_url_check,
  DROP COLUMN IF EXISTS public_address,
  DROP COLUMN IF EXISTS public_postal_code,
  DROP COLUMN IF EXISTS public_map_url,
  DROP COLUMN IF EXISTS show_public_address;
COMMIT;
