-- Member profile, merchant settings, and locked shop counter. No row backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.customers
  ADD COLUMN member_code text,
  ADD COLUMN date_of_birth date,
  ADD COLUMN gender text,
  ADD COLUMN phone_verified_at timestamptz,
  ADD COLUMN identity_status text NOT NULL DEFAULT 'unverified_contact',
  ADD CONSTRAINT customers_gender_check CHECK (gender IS NULL OR gender IN ('female','male','non_binary','prefer_not_to_say')),
  ADD CONSTRAINT customers_identity_status_check CHECK (identity_status IN ('unverified_contact','verified_member')),
  ADD CONSTRAINT customers_member_code_format_check CHECK (member_code IS NULL OR member_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');

CREATE TABLE public.shop_customer_settings (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
  member_code_prefix text NOT NULL DEFAULT 'MEM-',
  member_code_width smallint NOT NULL DEFAULT 6,
  dob_requirement text NOT NULL DEFAULT 'optional',
  default_phone_country_code text NOT NULL DEFAULT '+65',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_customer_settings_prefix_check CHECK (member_code_prefix ~ '^[A-Z0-9][A-Z0-9-]{0,11}$'),
  CONSTRAINT shop_customer_settings_width_check CHECK (member_code_width BETWEEN 4 AND 12),
  CONSTRAINT shop_customer_settings_dob_check CHECK (dob_requirement IN ('optional','required')),
  CONSTRAINT shop_customer_settings_country_check CHECK (default_phone_country_code ~ '^\+[1-9][0-9]{0,3}$')
);

CREATE TABLE public.shop_member_code_counters (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0)
);
COMMIT;
