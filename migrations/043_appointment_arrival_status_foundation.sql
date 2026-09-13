-- Appointment arrival/service status foundation. Schema only; no appointment
-- rows are rewritten and legacy pending status remains unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.appointment_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  operator_type TEXT NOT NULL,
  operator_id UUID NULL,
  source TEXT NOT NULL,
  reason TEXT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_status_history_status_nonempty CHECK (BTRIM(from_status) <> '' AND BTRIM(to_status) <> ''),
  CONSTRAINT appointment_status_history_operator_type_check CHECK (operator_type IN ('owner','staff','system')),
  CONSTRAINT appointment_status_history_source_nonempty CHECK (BTRIM(source) <> ''),
  CONSTRAINT appointment_status_history_appointment_fkey FOREIGN KEY (shop_id, appointment_id)
    REFERENCES public.appointments (shop_id, id) ON DELETE RESTRICT
);
CREATE INDEX appointment_status_history_appointment_idx
  ON public.appointment_status_history (shop_id, appointment_id, changed_at, id);

CREATE OR REPLACE FUNCTION public.reject_appointment_status_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'appointment_status_history is immutable';
END;
$$;
CREATE TRIGGER appointment_status_history_immutable
  BEFORE UPDATE OR DELETE ON public.appointment_status_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_appointment_status_history_mutation();

-- Least privilege: existing staff cannot change appointment status until this
-- explicit permission is granted by a future owner permission-management UI.
ALTER TABLE public.staff_permissions
  ADD COLUMN can_update_own_appointment_status BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
