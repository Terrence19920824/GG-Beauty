-- Approved rollback for migration 088. Destructive schema removal is allowed
-- only before any immutable command/audit row exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF to_regclass('public.appointment_item_mutation_commands') IS NULL THEN
    RAISE EXCEPTION 'appointment item mutation rollback: target table missing';
  END IF;
END
$guard$;

-- Take the same lock mode required by DROP TABLE before checking emptiness.
-- This waits for in-flight INSERT/UPDATE/DELETE transactions and prevents new
-- writers from crossing the guard before the destructive rollback completes.
LOCK TABLE public.appointment_item_mutation_commands
  IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.appointment_item_mutation_commands) THEN
    RAISE EXCEPTION 'appointment item mutation rollback refused: audit rows exist';
  END IF;
END
$guard$;

DROP TRIGGER appointment_item_mutation_commands_immutable
  ON public.appointment_item_mutation_commands;
DROP TABLE public.appointment_item_mutation_commands;
DROP FUNCTION public.reject_appointment_item_mutation_command_change();
DROP INDEX public.appointment_items_id_appointment_id_key;
DROP INDEX public.owner_shop_memberships_shop_id_id_key;

COMMIT;
