-- Permit a front-desk membership to use the authenticated owner operations
-- needed to view appointment details and update appointment status.
-- This migration changes only the membership role constraint; it creates no
-- accounts, memberships, sessions, or appointment data.

BEGIN;

ALTER TABLE public.owner_shop_memberships
  DROP CONSTRAINT owner_shop_memberships_role_check;

ALTER TABLE public.owner_shop_memberships
  ADD CONSTRAINT owner_shop_memberships_role_check
  CHECK (role IN ('owner', 'manager', 'admin', 'front_desk'));

COMMIT;
