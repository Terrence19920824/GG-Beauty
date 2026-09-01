-- GG-Beauty staff appointment move permission and immutable audit history
--
-- REVIEW ONLY. Do not execute until this migration has been approved against
-- the target Supabase PostgreSQL schema.
--
-- This migration is additive. It does not delete, rewrite, or rebuild any
-- business data. It does not alter appointment status, scheduling, working
-- hours, or the existing staff collision constraint. It contains no test data,
-- production identifiers, credentials, DROP, TRUNCATE, DELETE, or UPDATE.

BEGIN;

-- ==================================================
-- Least-privilege permission for moving own appointments
-- Existing rows receive FALSE through the default and NOT NULL definition.
-- No existing or future employee is granted this permission automatically.
-- The five existing staff permission columns remain unchanged.
-- ==================================================

ALTER TABLE staff_permissions
  ADD COLUMN can_move_own_appointments BOOLEAN NOT NULL DEFAULT FALSE;


-- ==================================================
-- Tenant-safe appointment reference
-- appointments.id is already a globally unique primary key. This additive
-- composite unique index does not change existing appointment relationships;
-- it allows the new audit table to require matching shop_id + appointment_id.
-- ==================================================

CREATE UNIQUE INDEX appointments_shop_id_id_uidx
  ON appointments (shop_id, id);


-- ==================================================
-- Immutable appointment time-change history
-- Application code must only INSERT audit events in the same transaction as
-- the appointment time update. No business-level UPDATE or DELETE workflow is
-- designed for this table.
--
-- actor_id is intentionally polymorphic and therefore has no foreign key in
-- this migration: the current repository has staff identities but no
-- tenant-aware admin_accounts table. actor_type and actor_id consistency is
-- still enforced below. A future reviewed migration can introduce typed actor
-- references after the admin identity model exists.
-- ==================================================

CREATE TABLE appointment_time_change_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  old_start_at TIMESTAMPTZ NOT NULL,
  old_end_at TIMESTAMPTZ NOT NULL,
  new_start_at TIMESTAMPTZ NOT NULL,
  new_end_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT appointment_time_history_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_time_history_shop_location_fkey
    FOREIGN KEY (shop_id, location_id)
    REFERENCES locations (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_time_history_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_time_history_shop_appointment_fkey
    FOREIGN KEY (shop_id, appointment_id)
    REFERENCES appointments (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_time_history_actor_type_check
    CHECK (actor_type IN ('staff', 'admin', 'system')),

  CONSTRAINT appointment_time_history_actor_identity_check
    CHECK (
      (actor_type = 'system' AND actor_id IS NULL)
      OR
      (actor_type IN ('staff', 'admin') AND actor_id IS NOT NULL)
    ),

  CONSTRAINT appointment_time_history_source_check
    CHECK (
      source IN (
        'staff_calendar_drag',
        'staff_time_picker',
        'admin_calendar',
        'system_reassignment'
      )
    ),

  CONSTRAINT appointment_time_history_old_time_check
    CHECK (old_end_at > old_start_at),

  CONSTRAINT appointment_time_history_new_time_check
    CHECK (new_end_at > new_start_at),

  CONSTRAINT appointment_time_history_changed_check
    CHECK (
      old_start_at <> new_start_at
      OR old_end_at <> new_end_at
    ),

  CONSTRAINT appointment_time_history_duration_check
    CHECK (
      old_end_at - old_start_at =
      new_end_at - new_start_at
    ),

  CONSTRAINT appointment_time_history_reason_check
    CHECK (reason IS NULL OR BTRIM(reason) <> '')
);


-- Supports an appointment detail/history timeline in chronological order.
CREATE INDEX appointment_time_history_appointment_idx
  ON appointment_time_change_history (
    shop_id,
    appointment_id,
    created_at DESC
  );

-- Supports staff-scoped operational and security audit queries.
CREATE INDEX appointment_time_history_staff_idx
  ON appointment_time_change_history (
    shop_id,
    staff_id,
    created_at DESC
  );

COMMIT;

-- Pre-execution review notes:
--   1. Confirm migration 001 is present, including unique indexes on
--      staff(shop_id, id) and locations(shop_id, id).
--   2. Confirm appointments.id remains a UUID primary key and shop_id is UUID
--      NOT NULL before creating appointments_shop_id_id_uidx.
--   3. Confirm staff_permissions does not already contain
--      can_move_own_appointments.
--   4. Application authorization must remain fail closed until server-side
--      permission mapping and the move endpoint are implemented and reviewed.
