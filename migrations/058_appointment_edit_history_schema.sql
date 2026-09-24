BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.appointment_edit_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id UUID NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  old_start_at TIMESTAMPTZ NOT NULL,
  new_start_at TIMESTAMPTZ NOT NULL,
  old_end_at TIMESTAMPTZ NOT NULL,
  new_end_at TIMESTAMPTZ NOT NULL,
  old_staff_id UUID NOT NULL,
  new_staff_id UUID NOT NULL,
  items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  reassignment_reason TEXT NULL,
  override_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_reason TEXT NULL,
  customer_notified BOOLEAN NOT NULL DEFAULT FALSE,
  customer_agreed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT appointment_edit_history_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES public.shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_edit_history_shop_location_fkey
    FOREIGN KEY (shop_id, location_id)
    REFERENCES public.locations (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_edit_history_shop_appointment_fkey
    FOREIGN KEY (shop_id, appointment_id)
    REFERENCES public.appointments (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_edit_history_old_staff_fkey
    FOREIGN KEY (shop_id, old_staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_edit_history_new_staff_fkey
    FOREIGN KEY (shop_id, new_staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_edit_history_actor_role_check
    CHECK (actor_role IN ('owner', 'manager', 'admin', 'front_desk')),

  CONSTRAINT appointment_edit_history_old_time_check
    CHECK (old_end_at > old_start_at),

  CONSTRAINT appointment_edit_history_new_time_check
    CHECK (new_end_at > new_start_at),

  CONSTRAINT appointment_edit_history_duration_preserved_check
    CHECK ((old_end_at - old_start_at) = (new_end_at - new_start_at)),

  CONSTRAINT appointment_edit_history_conflict_reason_check
    CHECK (override_conflict = FALSE OR (conflict_reason IS NOT NULL AND BTRIM(conflict_reason) <> ''))
);

CREATE INDEX IF NOT EXISTS appointment_edit_history_appointment_idx
  ON public.appointment_edit_history (shop_id, appointment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS appointment_edit_history_new_staff_idx
  ON public.appointment_edit_history (shop_id, new_staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS appointment_edit_history_shop_created_idx
  ON public.appointment_edit_history (shop_id, created_at DESC);

COMMIT;
