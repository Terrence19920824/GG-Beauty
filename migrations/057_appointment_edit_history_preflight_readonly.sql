BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL
     OR to_regclass('public.locations') IS NULL
     OR to_regclass('public.staff') IS NULL
     OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.appointment_items') IS NULL
     OR to_regclass('public.appointment_item_staff_assignments') IS NULL THEN
    RAISE EXCEPTION 'Appointment edit history prerequisites missing';
  END IF;

  IF to_regclass('public.appointment_edit_history') IS NOT NULL THEN
    RAISE EXCEPTION 'appointment_edit_history table already exists';
  END IF;
END $preflight$;
COMMIT;
