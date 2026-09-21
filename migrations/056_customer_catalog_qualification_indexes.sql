-- Migration 056: Customer Catalog Qualification & Batch Availability Indexes
-- Performance optimization for customer booking catalog and batch availability queries.
-- Idempotent, zero business data changes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Index on staff_services for efficient service-to-eligible-staff lookup
CREATE INDEX IF NOT EXISTS idx_staff_services_qualified
  ON public.staff_services (shop_id, service_id, staff_id)
  WHERE is_active = TRUE;

-- 2. Partial index on appointment_item_staff_assignments for active blocking collision checks
CREATE INDEX IF NOT EXISTS idx_appointment_item_staff_assignments_blocking
  ON public.appointment_item_staff_assignments (shop_id, location_id, staff_id, start_at, end_at)
  WHERE blocks_time = TRUE;

COMMIT;
