-- Merchant onboarding invitation foundation: read-only verification.
-- Verifies table, column types, constraints, and indexes without modifying data.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.merchant_onboarding_invitations') IS NULL THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: table missing';
  END IF;

  -- Verify essential columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merchant_onboarding_invitations'
      AND column_name = 'token_hash'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: token_hash missing or null';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merchant_onboarding_invitations'
      AND column_name = 'status'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: status column missing or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merchant_onboarding_invitations'
      AND column_name = 'expires_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: expires_at column missing or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merchant_onboarding_invitations'
      AND column_name = 'resulting_shop_id'
      AND data_type = 'uuid'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: resulting_shop_id column missing or drifted';
  END IF;

  -- Verify check constraints
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.merchant_onboarding_invitations'::regclass
      AND conname = 'merchant_onboarding_invitations_status_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: status check constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.merchant_onboarding_invitations'::regclass
      AND conname = 'merchant_onboarding_invitations_token_hash_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: token_hash unique constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.merchant_onboarding_invitations'::regclass
      AND conname = 'merchant_onboarding_invitations_resulting_shop_fkey'
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'merchant onboarding invitation verification: foreign key to shops missing';
  END IF;
END $verify$;
COMMIT;
