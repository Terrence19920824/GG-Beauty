-- Safe rollback for 082: refuses to drop tables if real customer accounts or memberships exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  has_accounts boolean := false;
  has_memberships boolean := false;
  has_custom_tiers boolean := false;
BEGIN
  IF to_regclass('public.customer_accounts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.customer_accounts)' INTO has_accounts;
  END IF;

  IF to_regclass('public.customer_memberships') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.customer_memberships)' INTO has_memberships;
  END IF;

  IF to_regclass('public.membership_tiers') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.membership_tiers WHERE tier_code <> ''ordinary'')' INTO has_custom_tiers;
  END IF;

  IF has_accounts OR has_memberships THEN
    RAISE EXCEPTION 'Customer account/membership rollback blocked: real customer accounts or memberships exist; refuse to drop tables';
  END IF;

  IF has_custom_tiers THEN
    RAISE EXCEPTION 'Customer account/membership rollback blocked: merchant-customized membership tiers exist; refuse to drop tables';
  END IF;
END $rollback$;

-- Restore trigger to migration 041 definition
CREATE OR REPLACE FUNCTION public.provision_shop_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.shop_customer_settings(shop_id) VALUES(NEW.id) ON CONFLICT (shop_id) DO NOTHING;
  INSERT INTO public.shop_member_code_counters(shop_id,next_value) VALUES(NEW.id,1) ON CONFLICT (shop_id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TABLE IF EXISTS public.customer_memberships;
DROP TABLE IF EXISTS public.customer_accounts;
DROP TABLE IF EXISTS public.membership_tiers;

ALTER TABLE public.shop_customer_settings
  DROP COLUMN IF EXISTS membership_enabled,
  DROP COLUMN IF EXISTS points_enabled,
  DROP COLUMN IF EXISTS stored_value_enabled,
  DROP COLUMN IF EXISTS packages_enabled,
  DROP COLUMN IF EXISTS auto_free_membership;

COMMIT;
