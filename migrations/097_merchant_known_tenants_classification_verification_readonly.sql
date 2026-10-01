-- Merchant operational classification foundation: read-only verification of controlled classification.
-- Verifies that known existing merchants hold their intended tenant_mode without modifying data.
BEGIN TRANSACTION READ ONLY;
DO $verify_classification$
DECLARE
  v_demo_mode TEXT;
  v_test_mode TEXT;
BEGIN
  -- Verify GG-Beauty is classified as 'demo'
  SELECT tenant_mode INTO v_demo_mode
  FROM public.shops
  WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'::uuid
    AND slug = 'gg-beauty';

  IF v_demo_mode IS NULL OR v_demo_mode <> 'demo' THEN
    RAISE EXCEPTION 'Classification verification failed: GG-Beauty tenant_mode is %, expected demo', COALESCE(v_demo_mode, 'NULL');
  END IF;

  -- Verify GG-Beauty Test Shop is classified as 'test'
  SELECT tenant_mode INTO v_test_mode
  FROM public.shops
  WHERE id = 'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'::uuid
    AND slug = 'gg-beauty-test';

  IF v_test_mode IS NULL OR v_test_mode <> 'test' THEN
    RAISE EXCEPTION 'Classification verification failed: GG-Beauty Test Shop tenant_mode is %, expected test', COALESCE(v_test_mode, 'NULL');
  END IF;
END $verify_classification$;
COMMIT;
