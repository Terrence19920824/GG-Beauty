-- Merchant operational classification foundation: safe rollback.
-- Removes tenant_mode column and check constraint without dropping shops table or deleting business records.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.shops
  DROP CONSTRAINT IF EXISTS shops_tenant_mode_check;

ALTER TABLE public.shops
  DROP COLUMN IF EXISTS tenant_mode;

COMMIT;
