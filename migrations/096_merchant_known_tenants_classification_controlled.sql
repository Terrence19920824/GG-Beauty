-- Merchant operational classification foundation: controlled classification of known existing merchants.
-- This migration updates ONLY the known pre-existing merchants to their designated operational classification.
-- It verifies exact shop UUID and slug before performing any update, and fails closed if identity does not match.
-- No unknown merchants are classified automatically, no records are deleted, and no business data is reset.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $controlled_classification$
DECLARE
  v_shop_a_found INT;
  v_shop_test_found INT;
  v_updated_count INT;
BEGIN
  -- 1. Guard check for Merchant 1: GG-Beauty
  SELECT count(*) INTO v_shop_a_found
  FROM public.shops
  WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'::uuid
    AND slug = 'gg-beauty';

  IF v_shop_a_found <> 1 THEN
    RAISE EXCEPTION 'Controlled classification aborted: Shop GG-Beauty (5e002f26-1267-4bb6-8c73-d60f11985799, gg-beauty) not found with matching UUID and slug';
  END IF;

  -- 2. Guard check for Merchant 2: GG-Beauty Test Shop
  SELECT count(*) INTO v_shop_test_found
  FROM public.shops
  WHERE id = 'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'::uuid
    AND slug = 'gg-beauty-test';

  IF v_shop_test_found <> 1 THEN
    RAISE EXCEPTION 'Controlled classification aborted: Shop GG-Beauty Test Shop (aa7a9c1b-a9c1-4775-86bd-9c11b16eb451, gg-beauty-test) not found with matching UUID and slug';
  END IF;

  -- 3. Execute exact guarded classification for GG-Beauty -> demo
  UPDATE public.shops
  SET tenant_mode = 'demo'
  WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'::uuid
    AND slug = 'gg-beauty';
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Controlled classification aborted: Failed to update exactly 1 row for GG-Beauty';
  END IF;

  -- 4. Execute exact guarded classification for GG-Beauty Test Shop -> test
  UPDATE public.shops
  SET tenant_mode = 'test'
  WHERE id = 'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'::uuid
    AND slug = 'gg-beauty-test';
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Controlled classification aborted: Failed to update exactly 1 row for GG-Beauty Test Shop';
  END IF;

END $controlled_classification$;

COMMIT;
