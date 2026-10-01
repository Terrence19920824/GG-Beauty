-- Merchant onboarding invitation foundation: schema migration.
-- Additive table for merchant self-service onboarding invitations.
-- Stores cryptographically strong token hashes with explicit lifecycles.
-- Invitations exist before tenant/shop provisioning.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.merchant_onboarding_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  resulting_shop_id UUID,
  merchant_name_hint TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  created_by TEXT NOT NULL DEFAULT 'platform_cli',
  consumed_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT merchant_onboarding_invitations_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT merchant_onboarding_invitations_token_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT merchant_onboarding_invitations_status_check
    CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),

  CONSTRAINT merchant_onboarding_invitations_resulting_shop_fkey
    FOREIGN KEY (resulting_shop_id)
    REFERENCES public.shops (id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_status_expires_idx
  ON public.merchant_onboarding_invitations (status, expires_at);

CREATE INDEX IF NOT EXISTS merchant_onboarding_invitations_resulting_shop_idx
  ON public.merchant_onboarding_invitations (resulting_shop_id)
  WHERE resulting_shop_id IS NOT NULL;

COMMIT;
