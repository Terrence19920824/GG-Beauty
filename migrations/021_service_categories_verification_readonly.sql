BEGIN TRANSACTION READ ONLY;
DO $$ DECLARE bad BIGINT; BEGIN
 IF to_regclass('public.service_categories') IS NULL OR to_regclass('public.service_category_translations') IS NULL THEN RAISE EXCEPTION 'category tables missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category_id' AND data_type='uuid' AND is_nullable='YES') THEN RAISE EXCEPTION 'services.category_id drift'; END IF;
 SELECT count(*) INTO bad FROM services s JOIN service_categories c ON c.id=s.category_id WHERE c.shop_id<>s.shop_id;
 IF bad>0 THEN RAISE EXCEPTION 'cross-tenant category links'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='services_category_tenant_fk' AND confdeltype='r') THEN RAISE EXCEPTION 'services category FK drift'; END IF;
END $$;
ROLLBACK;
