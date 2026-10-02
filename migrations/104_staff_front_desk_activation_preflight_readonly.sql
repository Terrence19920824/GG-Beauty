-- Staff & Front Desk Activation Foundation: read-only schema preflight.
-- This file performs no schema or business-data mutation.
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  -- Verify essential prerequisite tables exist
  IF to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.shops table missing';
  END IF;

  IF to_regclass('public.staff') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.staff table missing';
  END IF;

  IF to_regclass('public.staff_accounts') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.staff_accounts table missing';
  END IF;

  IF to_regclass('public.staff_location_assignments') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.staff_location_assignments table missing';
  END IF;

  IF to_regclass('public.owner_accounts') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.owner_accounts table missing';
  END IF;

  IF to_regclass('public.owner_shop_memberships') IS NULL THEN
    RAISE EXCEPTION 'activation preflight: public.owner_shop_memberships table missing';
  END IF;

  -- Verify prerequisite composite unique constraint on staff(shop_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'staff'
      AND c.relname = 'staff_shop_id_id_uidx'
      AND i.indisunique = TRUE
  ) THEN
    RAISE EXCEPTION 'activation preflight: staff_shop_id_id_uidx index missing';
  END IF;

  -- Ensure target tables do not already exist to avoid conflicting migrations
  IF to_regclass('public.staff_activation_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'activation preflight: public.staff_activation_invitations table already exists';
  END IF;

  IF to_regclass('public.front_desk_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'activation preflight: public.front_desk_invitations table already exists';
  END IF;

  IF to_regclass('public.merchant_auth_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'activation preflight: public.merchant_auth_audit table already exists';
  END IF;
END $preflight$;
COMMIT;
