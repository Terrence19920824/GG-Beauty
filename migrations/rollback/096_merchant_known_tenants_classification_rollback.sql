-- Merchant operational classification foundation: rollback for controlled classification.
-- Safely reverts the two known merchants to 'live' default if required during rollback.
-- Does not delete any merchant, drop tables, or modify any business data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

UPDATE public.shops
SET tenant_mode = 'live'
WHERE id IN (
  '5e002f26-1267-4bb6-8c73-d60f11985799'::uuid,
  'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'::uuid
);

COMMIT;
