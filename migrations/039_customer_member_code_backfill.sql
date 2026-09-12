-- Controlled legacy member-code allocation. Existing prefixes are immutable snapshots.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
INSERT INTO public.shop_customer_settings(shop_id) SELECT id FROM public.shops ON CONFLICT (shop_id) DO NOTHING;
INSERT INTO public.shop_member_code_counters(shop_id,next_value)
SELECT id,1 FROM public.shops ON CONFLICT (shop_id) DO NOTHING;

WITH numbered AS (
  SELECT id,shop_id,row_number() OVER (PARTITION BY shop_id ORDER BY id) AS member_number
  FROM public.customers WHERE member_code IS NULL
)
UPDATE public.customers c SET member_code=s.member_code_prefix||lpad(n.member_number::text,s.member_code_width,'0')
FROM numbered n JOIN public.shop_customer_settings s ON s.shop_id=n.shop_id WHERE c.id=n.id AND c.shop_id=n.shop_id;

UPDATE public.shop_member_code_counters counter SET next_value=calculated.next_value
FROM (SELECT c.shop_id,COUNT(*)::bigint+1 AS next_value FROM public.customers c GROUP BY c.shop_id) calculated
WHERE counter.shop_id=calculated.shop_id;
COMMIT;
