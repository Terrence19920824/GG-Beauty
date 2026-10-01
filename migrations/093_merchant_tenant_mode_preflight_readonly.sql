-- Merchant operational classification foundation: read-only schema preflight.
-- This file performs no schema or business-data mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'merchant tenant_mode preflight: public.shops table missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'tenant_mode'
  ) THEN
    RAISE EXCEPTION 'merchant tenant_mode preflight: shops.tenant_mode column already exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'merchant tenant_mode preflight: shops.id UUID missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'merchant tenant_mode preflight: shops.status column missing';
  END IF;
END $preflight$;
COMMIT;
