-- SERVICE I18N FOUNDATION schema.
-- Apply only after reviewing 010_service_translations_preflight_readonly.sql.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS services_shop_id_id_uidx
  ON public.services (shop_id, id);

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS price_is_from BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.appointment_items
  ADD COLUMN IF NOT EXISTS service_locale_snapshot TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointment_items_service_locale_snapshot_check'
      AND conrelid = 'public.appointment_items'::regclass
  ) THEN
    ALTER TABLE public.appointment_items
      ADD CONSTRAINT appointment_items_service_locale_snapshot_check
      CHECK (
        service_locale_snapshot IS NULL
        OR service_locale_snapshot IN ('zh-CN', 'en')
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.service_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  service_id UUID NOT NULL,
  locale TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT service_translations_locale_check
    CHECK (locale IN ('zh-CN', 'en')),

  CONSTRAINT service_translations_name_check
    CHECK (BTRIM(name) <> ''),

  CONSTRAINT service_translations_shop_service_locale_key
    UNIQUE (shop_id, service_id, locale),

  CONSTRAINT service_translations_shop_service_fkey
    FOREIGN KEY (shop_id, service_id)
    REFERENCES public.services (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS service_translations_shop_locale_service_idx
  ON public.service_translations (shop_id, locale, service_id);

COMMIT;
