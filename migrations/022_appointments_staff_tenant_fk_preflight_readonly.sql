-- Appointments staff tenant-safe FK repair: strict read-only preflight.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  legacy_definition TEXT;
BEGIN
  IF to_regclass('public.appointments') IS NULL OR to_regclass('public.staff') IS NULL THEN
    RAISE EXCEPTION 'Required appointments or staff table missing';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO legacy_definition
  FROM pg_constraint c
  WHERE c.conrelid='public.appointments'::regclass
    AND c.conname='appointments_staff_id_fkey';

  IF legacy_definition IS DISTINCT FROM
    'FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT' THEN
    RAISE EXCEPTION 'Legacy appointments staff FK missing or drifted';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass AND c.contype='f'
      AND c.confrelid='public.staff'::regclass
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['shop_id','staff_id']::name[]
  ) THEN RAISE EXCEPTION 'Target appointments staff composite FK already exists'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='appointments' AND column_name='shop_id'
      AND udt_name='uuid' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='appointments' AND column_name='staff_id'
      AND udt_name='uuid' AND is_nullable='NO'
  ) THEN RAISE EXCEPTION 'Appointments shop/staff columns drifted'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
    JOIN pg_class idx ON idx.oid=ix.indexrelid
    WHERE ix.indrelid='public.staff'::regclass
      AND idx.relname='staff_shop_id_id_uidx'
      AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN RAISE EXCEPTION 'staff(shop_id,id) unique prerequisite missing or drifted'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointments ap LEFT JOIN staff s ON s.id=ap.staff_id
    WHERE s.id IS NULL
  ) THEN RAISE EXCEPTION 'Appointment staff link missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM appointments ap JOIN staff s ON s.id=ap.staff_id
    WHERE ap.shop_id IS DISTINCT FROM s.shop_id
  ) THEN RAISE EXCEPTION 'Cross-shop appointment staff link detected'; END IF;
END $preflight$;

SELECT 'PASS' AS appointments_staff_tenant_fk_preflight;
ROLLBACK;
