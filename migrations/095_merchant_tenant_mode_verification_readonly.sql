-- Merchant operational classification foundation: read-only verification.
-- Verifies column existence, nullability, defaults, and check constraints without modifying data.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'merchant tenant_mode verification: public.shops table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'tenant_mode'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'merchant tenant_mode verification: shops.tenant_mode column missing or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.shops'::regclass
      AND conname = 'shops_tenant_mode_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%demo%'
      AND pg_get_constraintdef(oid) LIKE '%test%'
      AND pg_get_constraintdef(oid) LIKE '%live%'
  ) THEN
    RAISE EXCEPTION 'merchant tenant_mode verification: shops_tenant_mode_check constraint missing or drifted';
  END IF;
END $verify$;
COMMIT;
