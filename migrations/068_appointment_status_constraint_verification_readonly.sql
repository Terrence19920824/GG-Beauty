-- Read-only verification of expanded appointments_status_check constraint.
BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE
  def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_status_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'appointments_status_check constraint is missing';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.appointments'::regclass
    AND conname = 'appointments_status_check'
    AND contype = 'c';

  IF def NOT LIKE '%''pending''%'
     OR def NOT LIKE '%''confirmed''%'
     OR def NOT LIKE '%''arrived''%'
     OR def NOT LIKE '%''in_service''%'
     OR def NOT LIKE '%''completed''%'
     OR def NOT LIKE '%''cancelled''%'
     OR def NOT LIKE '%''no_show''%' THEN
    RAISE EXCEPTION 'appointments_status_check missing required status values: %', def;
  END IF;

  IF def LIKE '%awaiting_checkout%' THEN
    RAISE EXCEPTION 'appointments_status_check contains unapproved status awaiting_checkout: %', def;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointments
    WHERE status NOT IN ('pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show')
  ) THEN
    RAISE EXCEPTION 'appointments table contains rows violating status set';
  END IF;
END $verify$;
COMMIT;
