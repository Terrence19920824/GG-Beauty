-- Customer account, membership tiers, customer memberships, and merchant feature toggles.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Merchant feature toggles on shop_customer_settings
ALTER TABLE public.shop_customer_settings
  ADD COLUMN membership_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN points_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN stored_value_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN packages_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_free_membership boolean NOT NULL DEFAULT true;

-- 2. Membership tier products
CREATE TABLE public.membership_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  tier_code text NOT NULL,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  price_minor integer NOT NULL DEFAULT 0,
  validity_type text NOT NULL DEFAULT 'permanent',
  validity_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_tiers_price_check CHECK (price_minor >= 0),
  CONSTRAINT membership_tiers_validity_type_check CHECK (validity_type IN ('permanent', '3_months', '6_months', '12_months', 'custom_days')),
  CONSTRAINT membership_tiers_validity_days_check CHECK (validity_days IS NULL OR validity_days > 0),
  CONSTRAINT membership_tiers_code_check CHECK (tier_code ~ '^[a-z0-9_-]{1,32}$'),
  CONSTRAINT membership_tiers_shop_tier_code_key UNIQUE (shop_id, tier_code),
  CONSTRAINT membership_tiers_shop_id_key UNIQUE (shop_id, id)
);

-- 3. Customer accounts (Account != Profile != Membership)
CREATE TABLE public.customer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  phone_normalized text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by_role text NOT NULL DEFAULT 'customer',
  registered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_accounts_shop_customer_key UNIQUE (shop_id, customer_id),
  CONSTRAINT customer_accounts_shop_phone_key UNIQUE (shop_id, phone_normalized),
  CONSTRAINT customer_accounts_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_accounts_status_check CHECK (status IN ('active', 'disabled', 'suspended')),
  CONSTRAINT customer_accounts_role_check CHECK (created_by_role IN ('customer', 'front_desk', 'owner', 'manager', 'admin', 'system')),
  CONSTRAINT customer_accounts_phone_check CHECK (phone_normalized ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE INDEX customer_accounts_lookup_idx ON public.customer_accounts(shop_id, phone_normalized, status);

-- 4. Customer memberships
CREATE TABLE public.customer_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  activated_by text NOT NULL DEFAULT 'auto_free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, tier_id) REFERENCES public.membership_tiers(shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_memberships_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_memberships_status_check CHECK (status IN ('active', 'expired', 'revoked', 'suspended')),
  CONSTRAINT customer_memberships_activated_by_check CHECK (activated_by IN ('auto_free', 'manual_grant', 'paid_vip', 'spend_qualified', 'system')),
  CONSTRAINT customer_memberships_dates_check CHECK (expires_at IS NULL OR expires_at >= started_at)
);

CREATE INDEX customer_memberships_lookup_idx ON public.customer_memberships(shop_id, customer_id, status);

-- 5. Backfill default ordinary tier for existing shops
INSERT INTO public.membership_tiers (shop_id, tier_code, name, is_default, is_active, price_minor, validity_type)
SELECT id, 'ordinary', '普通会员', true, true, 0, 'permanent'
FROM public.shops
ON CONFLICT (shop_id, tier_code) DO NOTHING;

-- 6. Trigger update for future shop provisioning
CREATE OR REPLACE FUNCTION public.provision_shop_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.shop_customer_settings(shop_id) VALUES(NEW.id) ON CONFLICT (shop_id) DO NOTHING;
  INSERT INTO public.shop_member_code_counters(shop_id,next_value) VALUES(NEW.id,1) ON CONFLICT (shop_id) DO NOTHING;
  INSERT INTO public.membership_tiers(shop_id, tier_code, name, is_default, is_active, price_minor, validity_type)
    VALUES(NEW.id, 'ordinary', '普通会员', true, true, 0, 'permanent')
    ON CONFLICT (shop_id, tier_code) DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
