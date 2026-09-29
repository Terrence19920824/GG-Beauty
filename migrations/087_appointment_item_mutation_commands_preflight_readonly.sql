-- Active Service Add-on V1: read-only schema preflight.
-- This file performs no business-data or schema mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.appointments') IS NULL
     OR to_regclass('public.appointment_items') IS NULL
     OR to_regclass('public.appointment_item_staff_assignments') IS NULL
     OR to_regclass('public.staff_location_assignments') IS NULL
     OR to_regclass('public.owner_shop_memberships') IS NULL
     OR to_regclass('public.checkout_transactions') IS NULL THEN
    RAISE EXCEPTION 'appointment item mutation preflight: required relation missing';
  END IF;

  IF to_regclass('public.appointment_item_mutation_commands') IS NOT NULL
     OR to_regprocedure('public.reject_appointment_item_mutation_command_change()') IS NOT NULL THEN
    RAISE EXCEPTION 'appointment item mutation preflight: target objects already exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN (
        'owner_shop_memberships_shop_id_id_key',
        'appointment_items_id_appointment_id_key',
        'appointment_item_mutation_commands_shop_key',
        'appointment_item_mutation_commands_service_add_key',
        'appointment_item_mutation_commands_appointment_idx',
        'appointment_item_mutation_commands_operator_idx'
      )
  ) THEN
    RAISE EXCEPTION 'appointment item mutation preflight: target index name already exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointment_items'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (shop_id, location_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staff_location_assignments'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (shop_id, staff_id, location_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.owner_shop_memberships'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) THEN
    RAISE EXCEPTION 'appointment item mutation preflight: referenced key drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='appointment_items'
      AND column_name='price_snapshot' AND data_type='numeric'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='owner_shop_memberships'
      AND column_name='role' AND data_type='text'
  ) THEN
    RAISE EXCEPTION 'appointment item mutation preflight: column shape drift';
  END IF;
END
$preflight$;
COMMIT;
