-- GG-Beauty Appointment Multi-Service schema draft
--
-- This migration creates structure only. It does not backfill or modify
-- appointment, customer, service, staff, or other business records.
-- Run 003_appointment_multi_service_preflight_readonly.sql and review every
-- result before this migration is approved for execution.

BEGIN;

-- Tenant-safe referenced keys required by the new composite foreign keys.
CREATE UNIQUE INDEX services_shop_id_id_uidx
  ON public.services (shop_id, id);

-- This key guarantees that an item location is the same location recorded on
-- its parent appointment, rather than merely another location in the shop.
CREATE UNIQUE INDEX appointments_shop_location_id_uidx
  ON public.appointments (shop_id, location_id, id);

CREATE TABLE public.appointment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  service_id UUID NOT NULL,
  sequence_no INTEGER NOT NULL,
  service_name_snapshot TEXT NOT NULL,
  duration_minutes_snapshot INTEGER NOT NULL,
  price_snapshot NUMERIC NULL,
  snapshot_source TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT appointment_items_sequence_check
    CHECK (sequence_no > 0),

  CONSTRAINT appointment_items_duration_check
    CHECK (duration_minutes_snapshot > 0),

  CONSTRAINT appointment_items_time_range_check
    CHECK (end_at > start_at),

  CONSTRAINT appointment_items_price_check
    CHECK (price_snapshot IS NULL OR price_snapshot >= 0),

  CONSTRAINT appointment_items_snapshot_source_check
    CHECK (
      snapshot_source IN (
        'booking',
        'manual_add',
        'legacy_backfill'
      )
    ),

  -- Item statuses intentionally require a non-empty value instead of a closed
  -- enum so future checked-in/in-service workflows can be added without
  -- rewriting historical rows. Current APIs must initially use the existing
  -- appointment statuses: pending, confirmed, completed, cancelled, no_show.
  CONSTRAINT appointment_items_status_check
    CHECK (BTRIM(status) <> ''),

  CONSTRAINT appointment_items_shop_location_id_key
    UNIQUE (shop_id, location_id, id),

  CONSTRAINT appointment_items_appointment_sequence_key
    UNIQUE (shop_id, appointment_id, sequence_no),

  CONSTRAINT appointment_items_parent_fkey
    FOREIGN KEY (shop_id, location_id, appointment_id)
    REFERENCES public.appointments (shop_id, location_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_items_location_fkey
    FOREIGN KEY (shop_id, location_id)
    REFERENCES public.locations (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_items_service_fkey
    FOREIGN KEY (shop_id, service_id)
    REFERENCES public.services (shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX appointment_items_service_idx
  ON public.appointment_items (shop_id, service_id);

CREATE TABLE public.appointment_item_staff_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  appointment_item_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  role TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT appointment_item_staff_role_check
    CHECK (role IN ('primary', 'assistant')),

  CONSTRAINT appointment_item_staff_time_range_check
    CHECK (end_at > start_at),

  CONSTRAINT appointment_item_staff_assignment_staff_key
    UNIQUE (
      shop_id,
      location_id,
      appointment_item_id,
      staff_id
    ),

  CONSTRAINT appointment_item_staff_item_fkey
    FOREIGN KEY (shop_id, location_id, appointment_item_id)
    REFERENCES public.appointment_items (shop_id, location_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT appointment_item_staff_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE RESTRICT
);

-- At most one primary is allowed per item. A later write API must also verify
-- that every completed item has one primary before committing its transaction.
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx
  ON public.appointment_item_staff_assignments (
    shop_id,
    location_id,
    appointment_item_id
  )
  WHERE role = 'primary';

-- Query support only. A database-level staff collision constraint will be
-- designed separately before multi-service writes are enabled.
CREATE INDEX appointment_item_staff_schedule_idx
  ON public.appointment_item_staff_assignments (
    shop_id,
    location_id,
    staff_id,
    start_at,
    end_at
  );

COMMIT;

