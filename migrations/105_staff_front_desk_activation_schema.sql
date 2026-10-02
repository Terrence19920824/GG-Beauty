-- Staff & Front Desk Activation Foundation: additive schema migration.
-- This migration creates:
--   1. public.staff_activation_invitations
--   2. public.front_desk_invitations
--   3. public.merchant_auth_audit (immutable)
--
-- No existing tables or historical records are altered or dropped.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ============================================================================
-- 1. Staff Activation Invitations
-- Binds activation tokens strictly to tenant shop_id and staff_id.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff_activation_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_owner_account_id UUID NOT NULL,
  resulting_staff_account_id UUID,
  consumed_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_activation_invitations_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES public.shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_activation_invitations_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_activation_invitations_creator_fkey
    FOREIGN KEY (created_by_owner_account_id)
    REFERENCES public.owner_accounts (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_activation_invitations_account_fkey
    FOREIGN KEY (resulting_staff_account_id)
    REFERENCES public.staff_accounts (id)
    ON DELETE SET NULL,

  CONSTRAINT staff_activation_invitations_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT staff_activation_invitations_token_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT staff_activation_invitations_status_check
    CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),

  CONSTRAINT staff_activation_invitations_expiry_check
    CHECK (expires_at > created_at)
);

-- At most one active pending invitation per staff member
CREATE UNIQUE INDEX IF NOT EXISTS staff_activation_invitations_pending_uidx
  ON public.staff_activation_invitations (shop_id, staff_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS staff_activation_invitations_status_expires_idx
  ON public.staff_activation_invitations (status, expires_at);

CREATE INDEX IF NOT EXISTS staff_activation_invitations_shop_staff_idx
  ON public.staff_activation_invitations (shop_id, staff_id);


-- ============================================================================
-- 2. Front Desk Invitations
-- Binds activation tokens to tenant shop_id with role strictly 'front_desk'.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.front_desk_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'front_desk',
  invited_phone TEXT,
  invited_email TEXT,
  display_name_hint TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_owner_account_id UUID NOT NULL,
  resulting_owner_account_id UUID,
  resulting_membership_id UUID,
  consumed_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT front_desk_invitations_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES public.shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT front_desk_invitations_role_check
    CHECK (role = 'front_desk'),

  CONSTRAINT front_desk_invitations_creator_fkey
    FOREIGN KEY (created_by_owner_account_id)
    REFERENCES public.owner_accounts (id)
    ON DELETE RESTRICT,

  CONSTRAINT front_desk_invitations_account_fkey
    FOREIGN KEY (resulting_owner_account_id)
    REFERENCES public.owner_accounts (id)
    ON DELETE SET NULL,

  CONSTRAINT front_desk_invitations_membership_fkey
    FOREIGN KEY (resulting_membership_id)
    REFERENCES public.owner_shop_memberships (id)
    ON DELETE SET NULL,

  CONSTRAINT front_desk_invitations_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT front_desk_invitations_token_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT front_desk_invitations_status_check
    CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),

  CONSTRAINT front_desk_invitations_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS front_desk_invitations_shop_status_idx
  ON public.front_desk_invitations (shop_id, status, expires_at);

CREATE INDEX IF NOT EXISTS front_desk_invitations_status_expires_idx
  ON public.front_desk_invitations (status, expires_at);


-- ============================================================================
-- 3. Merchant Auth Audit Log (Immutable)
-- Records administrative and security events with operator attribution.
-- UPDATE and DELETE operations are forbidden by trigger.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.merchant_auth_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  operator_type TEXT NOT NULL,
  operator_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT merchant_auth_audit_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES public.shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT merchant_auth_audit_event_check
    CHECK (event_type IN (
      'staff_invitation_created',
      'staff_invitation_revoked',
      'staff_account_activated',
      'staff_account_disabled',
      'staff_account_reactivated',
      'front_desk_invitation_created',
      'front_desk_invitation_revoked',
      'front_desk_activated',
      'front_desk_disabled',
      'front_desk_reactivated'
    )),

  CONSTRAINT merchant_auth_audit_target_check
    CHECK (target_type IN ('staff', 'front_desk')),

  CONSTRAINT merchant_auth_audit_operator_check
    CHECK (operator_type IN ('owner', 'system', 'self_service'))
);

CREATE INDEX IF NOT EXISTS merchant_auth_audit_shop_target_idx
  ON public.merchant_auth_audit (shop_id, target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS merchant_auth_audit_shop_created_idx
  ON public.merchant_auth_audit (shop_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.reject_merchant_auth_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'merchant_auth_audit is immutable';
END;
$$;

DROP TRIGGER IF EXISTS merchant_auth_audit_immutable ON public.merchant_auth_audit;
CREATE TRIGGER merchant_auth_audit_immutable
  BEFORE UPDATE OR DELETE ON public.merchant_auth_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_merchant_auth_audit_mutation();

COMMIT;
