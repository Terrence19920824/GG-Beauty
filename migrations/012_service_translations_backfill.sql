-- Idempotent English fallback backfill for existing canonical services.
-- Existing service and appointment snapshot rows are never updated.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.service_translations (
  shop_id,
  service_id,
  locale,
  name,
  description
)
SELECT
  service.shop_id,
  service.id,
  'en',
  service.name,
  service.description
FROM public.services AS service
WHERE BTRIM(service.name) <> ''
ON CONFLICT (shop_id, service_id, locale) DO NOTHING;

COMMIT;
