-- Appointments staff tenant-safe FK repair: repeatable read-only verification.
BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass
      AND c.conname='appointments_staff_id_fkey' AND c.contype='f'
      AND c.confrelid='public.staff'::regclass AND c.convalidated
      AND c.confdeltype='r' AND c.confupdtype='a'
      AND pg_get_constraintdef(c.oid)='FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT'
  ) THEN RAISE EXCEPTION 'Tenant-safe appointments staff FK missing or drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.appointments'::regclass AND c.contype='f'
      AND c.confrelid='public.staff'::regclass
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['staff_id']::name[]
  ) THEN RAISE EXCEPTION 'Legacy single-column appointments staff FK still exists'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix JOIN pg_class idx ON idx.oid=ix.indexrelid
    WHERE ix.indrelid='public.staff'::regclass AND idx.relname='staff_shop_id_id_uidx'
      AND ix.indisunique AND ix.indisvalid AND ix.indisready AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND ix.indnkeyatts=2 AND ix.indnatts=2
      AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum)=ARRAY['shop_id','id']::name[]
  ) THEN RAISE EXCEPTION 'Referenced staff unique key missing or drifted'; END IF;
  IF EXISTS (SELECT 1 FROM appointments ap LEFT JOIN staff s ON s.shop_id=ap.shop_id AND s.id=ap.staff_id WHERE s.id IS NULL) THEN
    RAISE EXCEPTION 'Missing or cross-shop appointment staff link detected';
  END IF;
END $verify$;

SELECT 'PASS' AS appointments_staff_tenant_fk_verification;
ROLLBACK;
