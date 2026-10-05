-- Expand merchant_auth_audit event check to permit 'front_desk_password_reset'.
-- Non-destructive constraint update only.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.merchant_auth_audit
  DROP CONSTRAINT IF EXISTS merchant_auth_audit_event_check;

ALTER TABLE public.merchant_auth_audit
  ADD CONSTRAINT merchant_auth_audit_event_check
  CHECK (event_type IN (
    'staff_invitation_created',
    'staff_invitation_revoked',
    'staff_account_activated',
    'staff_account_disabled',
    'staff_account_reactivated',
    'front_desk_invitation_created',
    'front_desk_invitation_revoked',
    'front_desk_activated',
    'front_desk_disabled',
    'front_desk_reactivated',
    'front_desk_password_reset'
  ));

COMMIT;
