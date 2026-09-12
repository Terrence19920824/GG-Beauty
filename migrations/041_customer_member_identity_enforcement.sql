-- Stable member-code allocation and final constraints.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.customers ALTER COLUMN member_code SET NOT NULL;
CREATE UNIQUE INDEX customers_shop_member_code_uidx ON public.customers(shop_id,member_code);

CREATE OR REPLACE FUNCTION public.provision_shop_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.shop_customer_settings(shop_id) VALUES(NEW.id) ON CONFLICT (shop_id) DO NOTHING;
  INSERT INTO public.shop_member_code_counters(shop_id,next_value) VALUES(NEW.id,1) ON CONFLICT (shop_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER shops_provision_customer_identity AFTER INSERT ON public.shops
FOR EACH ROW EXECUTE FUNCTION public.provision_shop_customer_identity();

CREATE OR REPLACE FUNCTION public.assign_customer_member_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated bigint; prefix text; width smallint;
BEGIN
  IF NEW.member_code IS NOT NULL THEN
    RAISE EXCEPTION 'member_code is server allocated' USING ERRCODE='23514';
  END IF;
  SELECT member_code_prefix,member_code_width INTO prefix,width FROM public.shop_customer_settings WHERE shop_id=NEW.shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'shop member settings missing' USING ERRCODE='23503'; END IF;
  UPDATE public.shop_member_code_counters SET next_value=next_value+1 WHERE shop_id=NEW.shop_id RETURNING next_value-1 INTO allocated;
  IF NOT FOUND THEN RAISE EXCEPTION 'shop member counter missing' USING ERRCODE='23503'; END IF;
  NEW.member_code:=prefix||lpad(allocated::text,width,'0'); RETURN NEW;
END $$;
CREATE TRIGGER customers_assign_member_code BEFORE INSERT ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.assign_customer_member_code();
COMMIT;
