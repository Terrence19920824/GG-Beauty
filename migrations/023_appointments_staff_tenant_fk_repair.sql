-- Upgrade appointments.staff_id from a global-id FK to a tenant-safe composite FK.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass
      AND c.conname='appointments_staff_id_fkey' AND c.contype='f'
      AND c.confrelid='public.staff'::regclass AND c.convalidated
      AND c.confdeltype='r' AND c.confupdtype='a'
      AND pg_get_constraintdef(c.oid)='FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT'
  ) THEN RAISE EXCEPTION 'Legacy appointments staff FK missing or drifted'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.appointments'::regclass AND conname='appointments_staff_tenant_safe_fkey') THEN
    RAISE EXCEPTION 'Temporary appointments staff FK name already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix JOIN pg_class idx ON idx.oid=ix.indexrelid
    WHERE ix.indrelid='public.staff'::regclass AND idx.relname='staff_shop_id_id_uidx'
      AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN RAISE EXCEPTION 'staff(shop_id,id) unique prerequisite missing or drifted'; END IF;
  IF EXISTS (SELECT 1 FROM appointments ap LEFT JOIN staff s ON s.id=ap.staff_id WHERE s.id IS NULL)
     OR EXISTS (SELECT 1 FROM appointments ap JOIN staff s ON s.id=ap.staff_id WHERE ap.shop_id IS DISTINCT FROM s.shop_id)
  THEN RAISE EXCEPTION 'Appointment staff data is not safe for FK validation'; END IF;
END $guard$;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_staff_tenant_safe_fkey
  FOREIGN KEY (shop_id,staff_id)
  REFERENCES public.staff(shop_id,id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.appointments
  VALIDATE CONSTRAINT appointments_staff_tenant_safe_fkey;

ALTER TABLE public.appointments
  DROP CONSTRAINT appointments_staff_id_fkey;

ALTER TABLE public.appointments
  RENAME CONSTRAINT appointments_staff_tenant_safe_fkey TO appointments_staff_id_fkey;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass
      AND c.conname='appointments_staff_id_fkey' AND c.contype='f'
      AND c.confrelid='public.staff'::regclass AND c.convalidated
      AND c.confdeltype='r' AND c.confupdtype='a'
      AND pg_get_constraintdef(c.oid)='FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT'
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass AND c.contype='f'
      AND c.confrelid='public.staff'::regclass
      AND pg_get_constraintdef(c.oid)='FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT'
  ) THEN RAISE EXCEPTION 'Final appointments staff FK verification failed'; END IF;
END $post$;

COMMIT;
