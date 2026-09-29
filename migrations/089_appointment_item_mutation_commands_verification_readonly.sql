-- Active Service Add-on V1: read-only final verification.
BEGIN TRANSACTION READ ONLY;
DO $verify$
BEGIN
  IF to_regclass('public.appointment_item_mutation_commands') IS NULL THEN
    RAISE EXCEPTION 'appointment item mutation verification: table missing';
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='appointment_item_mutation_commands') <> 24 THEN
    RAISE EXCEPTION 'appointment item mutation verification: column count mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid='public.owner_shop_memberships'::regclass
      AND indisunique AND indisvalid AND indisready
      AND indexrelid='public.owner_shop_memberships_shop_id_id_key'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid='public.appointment_items'::regclass
      AND indisunique AND indisvalid AND indisready
      AND indexrelid='public.appointment_items_id_appointment_id_key'::regclass
  ) THEN
    RAISE EXCEPTION 'appointment item mutation verification: supporting unique key missing';
  END IF;

  IF (SELECT COUNT(*) FROM pg_constraint
      WHERE conrelid='public.appointment_item_mutation_commands'::regclass
        AND contype='f' AND confdeltype='r') <> 4 THEN
    RAISE EXCEPTION 'appointment item mutation verification: restrictive FK set mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.appointment_item_mutation_commands'::regclass
      AND tgname='appointment_item_mutation_commands_immutable'
      AND tgenabled='O' AND NOT tgisinternal
      AND tgfoid='public.reject_appointment_item_mutation_command_change()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'appointment item mutation verification: immutable trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid='public.appointment_item_mutation_commands'::regclass
      AND indexrelid='public.appointment_item_mutation_commands_service_add_key'::regclass
      AND indisunique AND indisvalid AND indisready AND indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'appointment item mutation verification: service-add uniqueness missing';
  END IF;

  IF EXISTS (SELECT 1 FROM public.appointment_item_mutation_commands) THEN
    RAISE EXCEPTION 'appointment item mutation verification: new table is not empty';
  END IF;
END
$verify$;
COMMIT;
