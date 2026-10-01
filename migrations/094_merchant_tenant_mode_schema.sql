-- Merchant operational classification foundation: schema migration.
-- Additive column on public.shops to distinguish demo, test, and live tenants.
-- Existing merchants default to 'live' without business data modification.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS tenant_mode TEXT NOT NULL DEFAULT 'live';

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shops'::regclass
      AND conname = 'shops_tenant_mode_check'
  ) THEN
    ALTER TABLE public.shops
      ADD CONSTRAINT shops_tenant_mode_check
      CHECK (tenant_mode IN ('demo', 'test', 'live'));
  END IF;
END $constraints$;

COMMIT;
