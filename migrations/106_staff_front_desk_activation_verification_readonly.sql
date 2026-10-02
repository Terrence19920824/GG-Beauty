-- Staff & Front Desk Activation Foundation: strict read-only verification.
-- Verifies all tables, columns, constraints, triggers, and indexes without data modification.
BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE
  v_def text;
BEGIN
  -- ==========================================================================
  -- 1. Table Existence Checks
  -- ==========================================================================
  IF to_regclass('public.staff_activation_invitations') IS NULL THEN
    RAISE EXCEPTION 'activation verification: public.staff_activation_invitations table missing';
  END IF;

  IF to_regclass('public.front_desk_invitations') IS NULL THEN
    RAISE EXCEPTION 'activation verification: public.front_desk_invitations table missing';
  END IF;

  IF to_regclass('public.merchant_auth_audit') IS NULL THEN
    RAISE EXCEPTION 'activation verification: public.merchant_auth_audit table missing';
  END IF;

  -- ==========================================================================
  -- 2. staff_activation_invitations Column Verifications
  -- ==========================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_activation_invitations'
      AND column_name = 'token_hash'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations.token_hash missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_activation_invitations'
      AND column_name = 'shop_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations.shop_id missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_activation_invitations'
      AND column_name = 'staff_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations.staff_id missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_activation_invitations'
      AND column_name = 'status'
      AND data_type = 'text'
      AND is_nullable = 'NO'
      AND column_default = '''pending''::text'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations.status missing, nullable, or default drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff_activation_invitations'
      AND column_name = 'created_by_owner_account_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations.created_by_owner_account_id missing or nullable';
  END IF;

  -- ==========================================================================
  -- 3. staff_activation_invitations Constraints & Indexes
  -- ==========================================================================
  -- Check: token_hash uniqueness
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
      AND c.conname = 'staff_activation_invitations_token_hash_key'
      AND c.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_token_hash_key constraint missing';
  END IF;

  -- Check: token_hash regex format check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
    AND c.conname = 'staff_activation_invitations_token_hash_format_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR v_def NOT LIKE '%token_hash ~ ''^[0-9a-f]{64}$''%' THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_token_hash_format_check missing or drifted: %', v_def;
  END IF;

  -- Check: status check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
    AND c.conname = 'staff_activation_invitations_status_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR (
    v_def NOT LIKE '%pending%' OR
    v_def NOT LIKE '%consumed%' OR
    v_def NOT LIKE '%revoked%' OR
    v_def NOT LIKE '%expired%'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_status_check missing or drifted: %', v_def;
  END IF;

  -- Check: expiry check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
    AND c.conname = 'staff_activation_invitations_expiry_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR v_def NOT LIKE '%expires_at > created_at%' THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_expiry_check missing or drifted: %', v_def;
  END IF;

  -- Check: tenant composite foreign key (shop_id, staff_id) -> staff(shop_id, id)
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
    AND c.conname = 'staff_activation_invitations_shop_staff_fkey'
    AND c.contype = 'f'
    AND c.confdeltype = 'r'; -- 'r' = RESTRICT
  IF v_def IS NULL OR v_def NOT LIKE '%FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id)%' THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_shop_staff_fkey missing or drifted: %', v_def;
  END IF;

  -- Check: creator foreign key
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.staff_activation_invitations'::regclass
      AND c.conname = 'staff_activation_invitations_creator_fkey'
      AND c.contype = 'f'
      AND c.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_creator_fkey missing or not restrict';
  END IF;

  -- Check: partial unique index on (shop_id, staff_id) WHERE status = 'pending'
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.staff_activation_invitations'::regclass
      AND c.relname = 'staff_activation_invitations_pending_uidx'
      AND i.indisunique = TRUE
      AND i.indisvalid = TRUE
  ) THEN
    RAISE EXCEPTION 'activation verification: staff_activation_invitations_pending_uidx index missing or invalid';
  END IF;

  -- ==========================================================================
  -- 4. front_desk_invitations Constraints & Indexes
  -- ==========================================================================
  -- Check: role constraint strictly front_desk
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.front_desk_invitations'::regclass
    AND c.conname = 'front_desk_invitations_role_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR v_def NOT LIKE '%role = ''front_desk''%' THEN
    RAISE EXCEPTION 'activation verification: front_desk_invitations_role_check missing or drifted: %', v_def;
  END IF;

  -- Check: token_hash uniqueness
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.front_desk_invitations'::regclass
      AND c.conname = 'front_desk_invitations_token_hash_key'
      AND c.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'activation verification: front_desk_invitations_token_hash_key constraint missing';
  END IF;

  -- Check: token_hash regex format check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.front_desk_invitations'::regclass
    AND c.conname = 'front_desk_invitations_token_hash_format_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR v_def NOT LIKE '%token_hash ~ ''^[0-9a-f]{64}$''%' THEN
    RAISE EXCEPTION 'activation verification: front_desk_invitations_token_hash_format_check missing or drifted: %', v_def;
  END IF;

  -- Check: shop foreign key
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.front_desk_invitations'::regclass
      AND c.conname = 'front_desk_invitations_shop_fkey'
      AND c.contype = 'f'
      AND c.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'activation verification: front_desk_invitations_shop_fkey missing or not restrict';
  END IF;

  -- Check: creator foreign key
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.front_desk_invitations'::regclass
      AND c.conname = 'front_desk_invitations_creator_fkey'
      AND c.contype = 'f'
      AND c.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'activation verification: front_desk_invitations_creator_fkey missing or not restrict';
  END IF;

  -- ==========================================================================
  -- 5. merchant_auth_audit Constraints, Trigger, and Immutability
  -- ==========================================================================
  -- Check: event_type check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.merchant_auth_audit'::regclass
    AND c.conname = 'merchant_auth_audit_event_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR (
    v_def NOT LIKE '%staff_invitation_created%' OR
    v_def NOT LIKE '%staff_account_activated%' OR
    v_def NOT LIKE '%staff_account_disabled%' OR
    v_def NOT LIKE '%front_desk_invitation_created%' OR
    v_def NOT LIKE '%front_desk_activated%' OR
    v_def NOT LIKE '%front_desk_disabled%'
  ) THEN
    RAISE EXCEPTION 'activation verification: merchant_auth_audit_event_check missing or drifted: %', v_def;
  END IF;

  -- Check: target_type check
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.merchant_auth_audit'::regclass
    AND c.conname = 'merchant_auth_audit_target_check'
    AND c.contype = 'c'
    AND c.convalidated = TRUE;
  IF v_def IS NULL OR (
    v_def NOT LIKE '%staff%' OR
    v_def NOT LIKE '%front_desk%'
  ) THEN
    RAISE EXCEPTION 'activation verification: merchant_auth_audit_target_check missing or drifted: %', v_def;
  END IF;

  -- Check: immutable trigger
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.merchant_auth_audit'::regclass
      AND t.tgname = 'merchant_auth_audit_immutable'
      AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'activation verification: merchant_auth_audit_immutable trigger missing or disabled';
  END IF;

  -- Check: trigger function rejects mutation
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.proname = 'reject_merchant_auth_audit_mutation';
  IF v_def IS NULL OR v_def NOT LIKE '%merchant_auth_audit is immutable%' THEN
    RAISE EXCEPTION 'activation verification: reject_merchant_auth_audit_mutation function missing or definition drifted';
  END IF;

END $verify$;
COMMIT;
