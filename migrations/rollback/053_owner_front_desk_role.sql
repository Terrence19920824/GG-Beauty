-- Rollback for migrations/053_owner_front_desk_role.sql.
--
-- This rollback is deliberately fail-closed: it never deletes, rewrites, or
-- deactivates memberships. Before running it, revoke or migrate every
-- front_desk membership through the application's normal audited workflow.
-- Owner, manager, and admin memberships are retained unchanged.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.owner_shop_memberships
    WHERE role = 'front_desk'
  ) THEN
    RAISE EXCEPTION
      'Cannot roll back 053 while front_desk memberships exist; revoke or migrate them first';
  END IF;
END
$$;

ALTER TABLE public.owner_shop_memberships
  DROP CONSTRAINT IF EXISTS owner_shop_memberships_role_check;

ALTER TABLE public.owner_shop_memberships
  ADD CONSTRAINT owner_shop_memberships_role_check
  CHECK (role IN ('owner', 'manager', 'admin'));

COMMIT;
