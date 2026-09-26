BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'customers table is required before adding profile notes';
  END IF;
END $preflight$;
COMMIT;
