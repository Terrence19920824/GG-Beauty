BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category' AND data_type='text') THEN RAISE EXCEPTION 'legacy services.category missing/drifted'; END IF;
 IF to_regclass('public.service_categories') IS NOT NULL OR to_regclass('public.service_category_translations') IS NOT NULL OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id') THEN RAISE EXCEPTION 'category foundation already exists or drifted'; END IF;
END $$;
CREATE TABLE service_categories (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
 canonical_name TEXT NOT NULL CHECK(btrim(canonical_name)<>''),icon_key TEXT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0),is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,id),UNIQUE(shop_id,canonical_name)
);
CREATE INDEX service_categories_shop_active_sort_idx ON service_categories(shop_id,is_active,sort_order,id);
CREATE TABLE service_category_translations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),shop_id UUID NOT NULL,category_id UUID NOT NULL,
 locale TEXT NOT NULL CHECK(locale IN('zh-CN','en')),name TEXT NOT NULL CHECK(btrim(name)<>''),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,category_id,locale),FOREIGN KEY(shop_id,category_id) REFERENCES service_categories(shop_id,id) ON DELETE RESTRICT
);
CREATE INDEX service_category_translations_shop_locale_category_idx ON service_category_translations(shop_id,locale,category_id);
ALTER TABLE services ADD COLUMN category_id UUID NULL;
ALTER TABLE services ADD CONSTRAINT services_category_tenant_fk FOREIGN KEY(shop_id,category_id) REFERENCES service_categories(shop_id,id) ON DELETE RESTRICT;
CREATE INDEX services_shop_category_idx ON services(shop_id,category_id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category' AND data_type='text') THEN RAISE EXCEPTION 'legacy services.category removed'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='service_categories')<>8 OR EXISTS(SELECT 1 FROM (VALUES ('id','uuid','NO'),('shop_id','uuid','NO'),('canonical_name','text','NO'),('icon_key','text','YES'),('sort_order','integer','NO'),('is_active','boolean','NO'),('created_at','timestamp with time zone','NO'),('updated_at','timestamp with time zone','NO')) e(name,type,nullable) LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name='service_categories' AND c.column_name=e.name WHERE c.column_name IS NULL OR c.data_type<>e.type OR c.is_nullable<>e.nullable) THEN RAISE EXCEPTION 'service_categories columns drift'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='service_category_translations')<>7 OR EXISTS(SELECT 1 FROM (VALUES ('id','uuid','NO'),('shop_id','uuid','NO'),('category_id','uuid','NO'),('locale','text','NO'),('name','text','NO'),('created_at','timestamp with time zone','NO'),('updated_at','timestamp with time zone','NO')) e(name,type,nullable) LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name='service_category_translations' AND c.column_name=e.name WHERE c.column_name IS NULL OR c.data_type<>e.type OR c.is_nullable<>e.nullable) THEN RAISE EXCEPTION 'service_category_translations columns drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id' AND data_type='uuid' AND is_nullable='YES') THEN RAISE EXCEPTION 'services.category_id drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (id)') THEN RAISE EXCEPTION 'category primary key missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (shop_id, id)') THEN RAISE EXCEPTION 'category composite unique missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (shop_id, canonical_name)') THEN RAISE EXCEPTION 'category canonical unique missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='f' AND confrelid='public.shops'::regclass AND confdeltype='r' AND pg_get_constraintdef(oid)='FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT') THEN RAISE EXCEPTION 'category shop FK drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_category_translations'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (id)') THEN RAISE EXCEPTION 'translation primary key missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_category_translations'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (shop_id, category_id, locale)') THEN RAISE EXCEPTION 'translation unique missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_category_translations'::regclass AND contype='f' AND confrelid='public.service_categories'::regclass AND confdeltype='r' AND pg_get_constraintdef(oid)='FOREIGN KEY (shop_id, category_id) REFERENCES service_categories(shop_id, id) ON DELETE RESTRICT') THEN RAISE EXCEPTION 'translation tenant FK drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.services'::regclass AND contype='f' AND confrelid='public.service_categories'::regclass AND confdeltype='r' AND pg_get_constraintdef(oid)='FOREIGN KEY (shop_id, category_id) REFERENCES service_categories(shop_id, id) ON DELETE RESTRICT') THEN RAISE EXCEPTION 'service tenant FK drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_category_translations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%zh-CN%' AND pg_get_constraintdef(oid) LIKE '%en%') THEN RAISE EXCEPTION 'locale check missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%btrim(canonical_name)%') THEN RAISE EXCEPTION 'canonical name check missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_categories'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%sort_order >= 0%') THEN RAISE EXCEPTION 'sort order check missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.service_category_translations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%btrim(name)%') THEN RAISE EXCEPTION 'translation name check missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='service_categories_shop_active_sort_idx' AND indexdef LIKE '%(shop_id, is_active, sort_order, id)%') THEN RAISE EXCEPTION 'category index drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='service_category_translations_shop_locale_category_idx' AND indexdef LIKE '%(shop_id, locale, category_id)%') THEN RAISE EXCEPTION 'translation index drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='services_shop_category_idx' AND indexdef LIKE '%(shop_id, category_id)%') THEN RAISE EXCEPTION 'service category index drift'; END IF;
END $$;
COMMIT;
