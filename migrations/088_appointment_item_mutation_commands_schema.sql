-- Active Service Add-on V1: durable idempotency and immutable operational audit.
-- Additive schema only. No appointment, item, checkout, customer, service, or
-- staff business rows are inserted, updated, or deleted by this migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE UNIQUE INDEX owner_shop_memberships_shop_id_id_key
  ON public.owner_shop_memberships (shop_id, id);

CREATE UNIQUE INDEX appointment_items_id_appointment_id_key
  ON public.appointment_items (id, appointment_id);

CREATE TABLE public.appointment_item_mutation_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  appointment_item_id UUID NOT NULL,
  service_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  mutation_type TEXT NOT NULL,
  operator_membership_id UUID NOT NULL,
  operator_role_snapshot TEXT NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint TEXT NOT NULL,
  fingerprint_version SMALLINT NOT NULL DEFAULT 1,
  appointment_end_at_before TIMESTAMPTZ NOT NULL,
  appointment_end_at_after TIMESTAMPTZ NOT NULL,
  item_sequence_no INTEGER NOT NULL,
  item_start_at TIMESTAMPTZ NOT NULL,
  item_end_at TIMESTAMPTZ NOT NULL,
  service_name_snapshot TEXT NOT NULL,
  duration_minutes_snapshot INTEGER NOT NULL,
  price_snapshot NUMERIC NOT NULL,
  item_status_snapshot TEXT NOT NULL,
  staff_role_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT appointment_item_mutation_commands_shop_key
    UNIQUE (shop_id, idempotency_key),
  CONSTRAINT appointment_item_mutation_commands_type_check
    CHECK (mutation_type IN ('service_item_added')),
  CONSTRAINT appointment_item_mutation_commands_operator_role_check
    CHECK (operator_role_snapshot IN ('owner','manager','admin','front_desk')),
  CONSTRAINT appointment_item_mutation_commands_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT appointment_item_mutation_commands_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT appointment_item_mutation_commands_fingerprint_version_check
    CHECK (fingerprint_version = 1),
  CONSTRAINT appointment_item_mutation_commands_sequence_check
    CHECK (item_sequence_no > 0),
  CONSTRAINT appointment_item_mutation_commands_service_name_check
    CHECK (BTRIM(service_name_snapshot) <> ''),
  CONSTRAINT appointment_item_mutation_commands_duration_check
    CHECK (duration_minutes_snapshot > 0),
  CONSTRAINT appointment_item_mutation_commands_price_check
    CHECK (price_snapshot >= 0),
  CONSTRAINT appointment_item_mutation_commands_item_status_check
    CHECK (item_status_snapshot IN ('arrived','in_service')),
  CONSTRAINT appointment_item_mutation_commands_staff_role_check
    CHECK (staff_role_snapshot = 'primary'),
  CONSTRAINT appointment_item_mutation_commands_time_check
    CHECK (
      item_end_at > item_start_at
      AND appointment_end_at_after > appointment_end_at_before
      AND item_start_at = appointment_end_at_before
      AND item_end_at = appointment_end_at_after
      AND item_end_at = item_start_at + duration_minutes_snapshot * INTERVAL '1 minute'
    ),
  CONSTRAINT appointment_item_mutation_commands_item_scope_fkey
    FOREIGN KEY (shop_id, location_id, appointment_item_id)
    REFERENCES public.appointment_items (shop_id, location_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT appointment_item_mutation_commands_item_appointment_fkey
    FOREIGN KEY (appointment_item_id, appointment_id)
    REFERENCES public.appointment_items (id, appointment_id)
    ON DELETE RESTRICT,
  CONSTRAINT appointment_item_mutation_commands_staff_location_fkey
    FOREIGN KEY (shop_id, staff_id, location_id)
    REFERENCES public.staff_location_assignments (shop_id, staff_id, location_id)
    ON DELETE RESTRICT,
  CONSTRAINT appointment_item_mutation_commands_operator_fkey
    FOREIGN KEY (shop_id, operator_membership_id)
    REFERENCES public.owner_shop_memberships (shop_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX appointment_item_mutation_commands_service_add_key
  ON public.appointment_item_mutation_commands (shop_id, appointment_item_id)
  WHERE mutation_type = 'service_item_added';

CREATE INDEX appointment_item_mutation_commands_appointment_idx
  ON public.appointment_item_mutation_commands
    (shop_id, appointment_id, created_at, id);

CREATE INDEX appointment_item_mutation_commands_operator_idx
  ON public.appointment_item_mutation_commands
    (shop_id, operator_membership_id, created_at, id);

CREATE FUNCTION public.reject_appointment_item_mutation_command_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'appointment item mutation commands are immutable';
END
$function$;

CREATE TRIGGER appointment_item_mutation_commands_immutable
  BEFORE UPDATE OR DELETE
  ON public.appointment_item_mutation_commands
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_appointment_item_mutation_command_change();

COMMIT;
