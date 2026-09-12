-- Verified phone history, hashed OTP challenges, customer sessions, and identity audit.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.customer_phone_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, customer_id uuid NOT NULL,
  phone_normalized text NOT NULL, is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE RESTRICT,
  CHECK (phone_normalized ~ '^\+[1-9][0-9]{7,14}$'), CHECK (ended_at IS NULL OR ended_at>=created_at)
);
CREATE INDEX customer_phone_lookup_idx ON public.customer_phone_identities(shop_id,phone_normalized);
CREATE UNIQUE INDEX customer_phone_one_active_verified_uidx ON public.customer_phone_identities(shop_id,phone_normalized)
  WHERE verified_at IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX customer_phone_one_primary_uidx ON public.customer_phone_identities(shop_id,customer_id)
  WHERE is_primary AND ended_at IS NULL;

CREATE TABLE public.customer_otp_challenges (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  customer_id uuid, purpose text NOT NULL, phone_normalized text NOT NULL,
  code_hash text NOT NULL, request_fingerprint_hash text NOT NULL, provider_key text NOT NULL,
  provider_message_id text, expires_at timestamptz NOT NULL, resend_after timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE RESTRICT,
  CHECK (purpose IN ('sign_in','phone_change')), CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CHECK (request_fingerprint_hash ~ '^[0-9a-f]{64}$'), CHECK (attempts>=0 AND max_attempts BETWEEN 1 AND 10)
);
CREATE INDEX customer_otp_phone_rate_idx ON public.customer_otp_challenges(shop_id,phone_normalized,created_at DESC);
CREATE INDEX customer_otp_fingerprint_rate_idx ON public.customer_otp_challenges(request_fingerprint_hash,created_at DESC);

CREATE TABLE public.customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, customer_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE RESTRICT,
  CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX customer_sessions_customer_idx ON public.customer_sessions(shop_id,customer_id,expires_at DESC);

CREATE TABLE public.customer_identity_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  customer_id uuid, event_type text NOT NULL, challenge_id uuid, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (challenge_id) REFERENCES public.customer_otp_challenges(id) ON DELETE RESTRICT
);
CREATE INDEX customer_identity_audit_customer_idx ON public.customer_identity_audit(shop_id,customer_id,created_at DESC);
COMMIT;
