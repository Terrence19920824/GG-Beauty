-- Booking Notifications V1: schema migration.
-- Additive schema only. No existing appointments or business data modified.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.booking_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_staff_id UUID NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ NULL,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT booking_notifications_event_type_check
    CHECK (event_type IN ('booking_created', 'booking_cancelled', 'booking_rescheduled')),
  CONSTRAINT booking_notifications_recipient_type_check
    CHECK (recipient_type IN ('shop', 'staff')),
  CONSTRAINT booking_notifications_recipient_check
    CHECK (
      (recipient_type = 'staff' AND recipient_staff_id IS NOT NULL)
      OR (recipient_type = 'shop' AND recipient_staff_id IS NULL)
    ),
  CONSTRAINT booking_notifications_appointment_scope_fkey
    FOREIGN KEY (shop_id, appointment_id)
    REFERENCES public.appointments (shop_id, id)
    ON DELETE CASCADE,
  CONSTRAINT booking_notifications_recipient_staff_scope_fkey
    FOREIGN KEY (shop_id, recipient_staff_id)
    REFERENCES public.staff (shop_id, id)
    ON DELETE CASCADE,
  CONSTRAINT booking_notifications_shop_dedupe_uidx
    UNIQUE (shop_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS booking_notifications_recipient_idx
  ON public.booking_notifications
    (shop_id, recipient_type, recipient_staff_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS booking_notifications_appointment_idx
  ON public.booking_notifications
    (shop_id, appointment_id);

COMMIT;
