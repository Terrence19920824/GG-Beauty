BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'appointments table is required before adding internal notes';
  END IF;
END $preflight$;
COMMIT;
