-- Safe rollback for 085: refuses to discard configured business profile data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  profile_columns_exist BOOLEAN;
  has_configured_profile BOOLEAN;
BEGIN
  SELECT COUNT(*) = 6 INTO profile_columns_exist
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
    AND column_name IN (
      'public_display_name',
      'public_business_hours',
      'public_website_url',
      'public_instagram_url',
      'customer_announcement_text',
      'customer_announcement_enabled'
    );

  IF profile_columns_exist THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.shop_customer_settings
      WHERE public_display_name IS NOT NULL
         OR public_business_hours IS NOT NULL
         OR public_website_url IS NOT NULL
         OR public_instagram_url IS NOT NULL
         OR customer_announcement_text IS NOT NULL
         OR customer_announcement_enabled = true
    )' INTO has_configured_profile;
  END IF;

  IF COALESCE(has_configured_profile, FALSE) THEN
    RAISE EXCEPTION 'Merchant business profile rollback blocked: clear or archive configured values first';
  END IF;
END $rollback$;

ALTER TABLE public.shop_customer_settings
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_display_name_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_business_hours_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_website_url_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_public_instagram_url_check,
  DROP CONSTRAINT IF EXISTS shop_customer_settings_customer_announcement_text_check,
  DROP COLUMN IF EXISTS public_display_name,
  DROP COLUMN IF EXISTS public_business_hours,
  DROP COLUMN IF EXISTS public_website_url,
  DROP COLUMN IF EXISTS public_instagram_url,
  DROP COLUMN IF EXISTS customer_announcement_text,
  DROP COLUMN IF EXISTS customer_announcement_enabled;

COMMIT;
