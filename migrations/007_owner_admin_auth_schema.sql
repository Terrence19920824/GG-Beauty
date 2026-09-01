-- GG-Beauty owner/admin tenant authentication foundation
--
-- SCHEMA ONLY. Run 006_owner_admin_auth_preflight_readonly.sql and review all
-- results before execution. This migration creates no owner account,
-- membership, session, password, token, or other authentication data. It does
-- not modify the legacy global admin password/session implementation.

BEGIN;

-- Login identity. A normalized identifier is stored explicitly so no new
-- extension is required for case-insensitive login lookup. Application code
-- must normalize with trim + lowercase before querying or inserting.
CREATE TABLE public.owner_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_identifier TEXT NOT NULL,
  login_identifier_normalized TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_accounts_login_identifier_normalized_key
    UNIQUE (login_identifier_normalized),

  CONSTRAINT owner_accounts_identifier_check
    CHECK (
      BTRIM(login_identifier) <> ''
      AND login_identifier_normalized =
        LOWER(BTRIM(login_identifier))
    ),

  CONSTRAINT owner_accounts_display_name_check
    CHECK (BTRIM(display_name) <> ''),

  CONSTRAINT owner_accounts_password_hash_check
    CHECK (CHAR_LENGTH(password_hash) >= 40),

  CONSTRAINT owner_accounts_session_version_check
    CHECK (session_version >= 1),

  CONSTRAINT owner_accounts_failed_attempts_check
    CHECK (failed_login_attempts >= 0)
);

CREATE INDEX owner_accounts_active_idx
  ON public.owner_accounts (is_active, id);


-- Trusted account-to-shop authorization. An account may hold memberships in
-- multiple shops, while each account/shop pair has exactly one membership.
-- The composite identity key supports membership-bound session foreign keys.
CREATE TABLE public.owner_shop_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id UUID NOT NULL,
  shop_id UUID NOT NULL,
  role TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_shop_memberships_account_fkey
    FOREIGN KEY (owner_account_id)
    REFERENCES public.owner_accounts (id)
    ON DELETE RESTRICT,

  CONSTRAINT owner_shop_memberships_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES public.shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT owner_shop_memberships_role_check
    CHECK (role IN ('owner', 'manager', 'admin')),

  CONSTRAINT owner_shop_memberships_owner_shop_key
    UNIQUE (owner_account_id, shop_id),

  CONSTRAINT owner_shop_memberships_identity_key
    UNIQUE (id, owner_account_id, shop_id)
);

CREATE INDEX owner_shop_memberships_account_active_idx
  ON public.owner_shop_memberships (
    owner_account_id,
    is_active,
    shop_id
  );

CREATE INDEX owner_shop_memberships_shop_role_idx
  ON public.owner_shop_memberships (
    shop_id,
    is_active,
    role
  );


-- Server-side sessions are bound to one verified membership and therefore one
-- active shop context. Only a SHA-256 hex digest of the random raw token may be
-- stored. Every authenticated request must still join owner_accounts and
-- owner_shop_memberships and fail closed unless account, membership, shop,
-- expiry, revocation, and session_version checks all pass.
CREATE TABLE public.owner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  membership_id UUID NOT NULL,
  owner_account_id UUID NOT NULL,
  shop_id UUID NOT NULL,
  session_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,

  CONSTRAINT owner_sessions_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT owner_sessions_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT owner_sessions_membership_fkey
    FOREIGN KEY (
      membership_id,
      owner_account_id,
      shop_id
    )
    REFERENCES public.owner_shop_memberships (
      id,
      owner_account_id,
      shop_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT owner_sessions_session_version_check
    CHECK (session_version >= 1),

  CONSTRAINT owner_sessions_expiry_check
    CHECK (expires_at > created_at),

  CONSTRAINT owner_sessions_revoke_reason_check
    CHECK (
      revoke_reason IS NULL
      OR BTRIM(revoke_reason) <> ''
    )
);

CREATE INDEX owner_sessions_membership_active_idx
  ON public.owner_sessions (
    membership_id,
    expires_at
  )
  WHERE revoked_at IS NULL;

CREATE INDEX owner_sessions_account_active_idx
  ON public.owner_sessions (
    owner_account_id,
    expires_at
  )
  WHERE revoked_at IS NULL;

CREATE INDEX owner_sessions_expiry_idx
  ON public.owner_sessions (expires_at)
  WHERE revoked_at IS NULL;

COMMIT;

-- Application requirements for the later implementation (not executed here):
--   * bcryptjs password verification with generic failures and temporary lock.
--   * 32-byte random raw tokens in HttpOnly, SameSite=Lax cookies; Secure in
--     production. Database storage is token_hash only.
--   * requireOwnerAuth must validate account/membership/shop active state,
--     session expiry/revocation, and matching session_version on every request.
--   * Multi-shop switching must verify the target membership server-side and
--     rotate to a newly issued membership-bound session.
--   * Removing a membership or disabling an account must invalidate its scope
--     immediately on the next request; session rows may additionally be
--     explicitly revoked for cleanup and defense in depth.
--   * No initial owner account is created by this migration.
