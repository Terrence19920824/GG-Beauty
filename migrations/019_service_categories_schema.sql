BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF to_regclass('public.service_categories') IS NOT NULL OR to_regclass('public.service_category_translations') IS NOT NULL OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id') THEN RAISE EXCEPTION 'category foundation schema already exists or drifted'; END IF;
END $$;
CREATE TABLE service_categories (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
 canonical_name TEXT NOT NULL CHECK (btrim(canonical_name)<>''), icon_key TEXT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0), is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,id), UNIQUE(shop_id,canonical_name)
);
CREATE INDEX service_categories_shop_active_sort_idx ON service_categories(shop_id,is_active,sort_order,id);
CREATE TABLE service_category_translations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shop_id UUID NOT NULL, category_id UUID NOT NULL,
 locale TEXT NOT NULL CHECK(locale IN ('zh-CN','en')), name TEXT NOT NULL CHECK(btrim(name)<>''),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,category_id,locale), FOREIGN KEY(shop_id,category_id) REFERENCES service_categories(shop_id,id) ON DELETE RESTRICT
);
CREATE INDEX service_category_translations_shop_locale_category_idx ON service_category_translations(shop_id,locale,category_id);
ALTER TABLE services ADD COLUMN category_id UUID NULL;
ALTER TABLE services ADD CONSTRAINT services_category_tenant_fk FOREIGN KEY(shop_id,category_id) REFERENCES service_categories(shop_id,id) ON DELETE RESTRICT;
CREATE INDEX services_shop_category_idx ON services(shop_id,category_id);
COMMIT;
