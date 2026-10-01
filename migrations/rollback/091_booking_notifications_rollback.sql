-- Booking Notifications V1: safe rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TABLE IF EXISTS public.booking_notifications CASCADE;

COMMIT;
