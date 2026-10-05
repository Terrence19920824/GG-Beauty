BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Rollback constraint if no front_desk_password_reset audit records exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.merchant_auth_audit
    WHERE event_type = 'front_desk_password_reset'
  ) THEN
    RAISE EXCEPTION 'Rollback refused: front_desk_password_reset audit records exist.';
  END IF;
END $$;

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
    'front_desk_reactivated'
  ));

COMMIT;
