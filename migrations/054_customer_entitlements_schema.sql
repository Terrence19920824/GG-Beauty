BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Required for tstzrange exclusion constraint across same shop
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- 1. Extend shop_customer_settings with module toggles, currency, and audit prerequisites
ALTER TABLE public.shop_customer_settings
  ADD COLUMN IF NOT EXISTS membership_tier_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS packages_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stored_value_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS points_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS currency_code char(3) NOT NULL DEFAULT 'SGD',
  ADD CONSTRAINT shop_customer_settings_currency_check CHECK (currency_code ~ '^[A-Z]{3}$');

-- ============================================================================
-- 1. MEMBERSHIP TIERS, RULES, AND ENROLLMENTS
-- ============================================================================

CREATE TABLE public.customer_membership_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  tier_code text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  rank_order smallint NOT NULL DEFAULT 0,
  default_discount_basis_points integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_membership_tiers_tier_code_check CHECK (tier_code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT customer_membership_tiers_rank_check CHECK (rank_order >= 0),
  CONSTRAINT customer_membership_tiers_discount_check CHECK (default_discount_basis_points BETWEEN 0 AND 10000),
  CONSTRAINT customer_membership_tiers_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_membership_tiers_shop_tier_code_key UNIQUE (shop_id, tier_code),
  CONSTRAINT customer_membership_tiers_shop_rank_key UNIQUE (shop_id, rank_order)
);

CREATE TABLE public.customer_membership_tier_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  service_id uuid NOT NULL,
  discount_basis_points integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_membership_tier_rules_discount_check CHECK (discount_basis_points BETWEEN 0 AND 10000),
  CONSTRAINT customer_membership_tier_rules_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_membership_tier_rules_shop_tier_service_key UNIQUE (shop_id, tier_id, service_id),
  FOREIGN KEY (shop_id, tier_id) REFERENCES public.customer_membership_tiers(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, service_id) REFERENCES public.services(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_membership_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_membership_enrollments_status_check CHECK (status IN ('active', 'expired', 'upgraded', 'revoked')),
  CONSTRAINT customer_membership_enrollments_expiry_check CHECK (expires_at IS NULL OR expires_at > valid_from),
  CONSTRAINT customer_membership_enrollments_shop_id_key UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, tier_id) REFERENCES public.customer_membership_tiers(shop_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_membership_enrollment_one_active_uidx
  ON public.customer_membership_enrollments(shop_id, customer_id) WHERE (status = 'active');

-- ============================================================================
-- 2. PACKAGES / PUNCH CARDS
-- ============================================================================

CREATE TABLE public.package_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  package_code text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  total_sessions integer NOT NULL,
  validity_days integer NULL,
  retail_price_minor bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_definitions_code_check CHECK (package_code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT package_definitions_sessions_check CHECK (total_sessions > 0),
  CONSTRAINT package_definitions_validity_check CHECK (validity_days IS NULL OR validity_days > 0),
  CONSTRAINT package_definitions_price_check CHECK (retail_price_minor >= 0),
  CONSTRAINT package_definitions_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT package_definitions_shop_code_key UNIQUE (shop_id, package_code)
);

CREATE TABLE public.package_definition_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  package_definition_id uuid NOT NULL,
  service_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_definition_services_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT package_definition_services_unique_link UNIQUE (shop_id, package_definition_id, service_id),
  FOREIGN KEY (shop_id, package_definition_id) REFERENCES public.package_definitions(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, service_id) REFERENCES public.services(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  package_definition_id uuid NOT NULL,
  purchase_checkout_id uuid NOT NULL,
  purchase_checkout_line_id uuid NOT NULL,
  package_name_snapshot text NOT NULL,
  purchase_price_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  total_sessions integer NOT NULL,
  validity_rule_snapshot jsonb NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_packages_price_check CHECK (purchase_price_minor >= 0),
  CONSTRAINT customer_packages_sessions_check CHECK (total_sessions > 0),
  CONSTRAINT customer_packages_currency_check CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT customer_packages_status_check CHECK (status IN ('active', 'frozen', 'void', 'refunded')),
  CONSTRAINT customer_packages_expiry_check CHECK (expires_at IS NULL OR expires_at >= activated_at),
  CONSTRAINT customer_packages_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_packages_tenant_customer_key UNIQUE (shop_id, customer_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, package_definition_id) REFERENCES public.package_definitions(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, purchase_checkout_id) REFERENCES public.checkout_transactions(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, purchase_checkout_line_id) REFERENCES public.checkout_line_items(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_package_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  customer_package_id uuid NOT NULL,
  entry_type text NOT NULL,
  session_delta integer NOT NULL,
  idempotency_key text NOT NULL,
  original_ledger_id uuid NULL,
  reference_checkout_id uuid NULL,
  reference_appointment_id uuid NULL,
  reference_appointment_item_id uuid NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_package_ledger_entry_type_check CHECK (entry_type IN ('purchase_grant', 'redemption', 'redemption_reversal', 'partial_refund_deduction', 'expiration_forfeit', 'manual_adjustment')),
  CONSTRAINT customer_package_ledger_delta_nonzero CHECK (session_delta <> 0),
  CONSTRAINT customer_package_ledger_delta_direction CHECK (
    ((entry_type IN ('purchase_grant', 'redemption_reversal')) AND session_delta > 0) OR
    ((entry_type IN ('redemption', 'partial_refund_deduction', 'expiration_forfeit')) AND session_delta < 0) OR
    (entry_type = 'manual_adjustment' AND session_delta <> 0)
  ),
  CONSTRAINT customer_package_ledger_no_self_ref CHECK (original_ledger_id IS NULL OR original_ledger_id <> id),
  CONSTRAINT customer_package_ledger_reversal_ref_check CHECK (entry_type <> 'redemption_reversal' OR original_ledger_id IS NOT NULL),
  CONSTRAINT customer_package_ledger_reason_check CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT customer_package_ledger_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_package_ledger_idempotency UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, customer_id, customer_package_id) REFERENCES public.customer_packages(shop_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_ledger_id) REFERENCES public.customer_package_ledger(shop_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 3. STORED VALUE ACCOUNTS, LOTS, LEDGER, AND ALLOCATIONS
-- ============================================================================

CREATE TABLE public.customer_stored_value_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  currency_code char(3) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_stored_value_accounts_status_check CHECK (status IN ('active', 'frozen', 'closed')),
  CONSTRAINT customer_stored_value_accounts_currency_check CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT customer_stored_value_accounts_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_stored_value_accounts_customer_key UNIQUE (shop_id, customer_id),
  CONSTRAINT customer_stored_value_accounts_tenant_composite_key UNIQUE (shop_id, customer_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_stored_value_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  entry_type text NOT NULL,
  principal_delta_minor bigint NOT NULL DEFAULT 0,
  bonus_delta_minor bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  original_ledger_id uuid NULL,
  reference_checkout_id uuid NULL,
  reference_appointment_id uuid NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_sv_ledger_entry_type_check CHECK (entry_type IN ('topup_grant', 'service_spend', 'spend_reversal', 'refund_payout', 'refund_bonus_void', 'expiration_forfeit', 'manual_adjustment')),
  CONSTRAINT customer_sv_ledger_delta_nonzero CHECK (principal_delta_minor <> 0 OR bonus_delta_minor <> 0),
  CONSTRAINT customer_sv_ledger_delta_direction CHECK (
    (entry_type = 'topup_grant' AND principal_delta_minor >= 0 AND bonus_delta_minor >= 0 AND (principal_delta_minor > 0 OR bonus_delta_minor > 0)) OR
    (entry_type = 'service_spend' AND principal_delta_minor <= 0 AND bonus_delta_minor <= 0 AND (principal_delta_minor < 0 OR bonus_delta_minor < 0)) OR
    (entry_type = 'spend_reversal' AND principal_delta_minor >= 0 AND bonus_delta_minor >= 0 AND (principal_delta_minor > 0 OR bonus_delta_minor > 0)) OR
    (entry_type = 'refund_payout' AND principal_delta_minor < 0 AND bonus_delta_minor = 0) OR
    (entry_type = 'refund_bonus_void' AND principal_delta_minor = 0 AND bonus_delta_minor < 0) OR
    (entry_type = 'expiration_forfeit' AND principal_delta_minor = 0 AND bonus_delta_minor < 0) OR
    (entry_type = 'manual_adjustment' AND (principal_delta_minor <> 0 OR bonus_delta_minor <> 0))
  ),
  CONSTRAINT customer_sv_ledger_no_self_ref CHECK (original_ledger_id IS NULL OR original_ledger_id <> id),
  CONSTRAINT customer_sv_ledger_reversal_ref_check CHECK (entry_type <> 'spend_reversal' OR original_ledger_id IS NOT NULL),
  CONSTRAINT customer_sv_ledger_reason_check CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT customer_sv_ledger_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_sv_ledger_idempotency UNIQUE (shop_id, idempotency_key),
  CONSTRAINT customer_sv_ledger_tenant_key UNIQUE (shop_id, account_id, customer_id, id),
  FOREIGN KEY (shop_id, customer_id, account_id) REFERENCES public.customer_stored_value_accounts(shop_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_ledger_id) REFERENCES public.customer_stored_value_ledger(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_stored_value_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  grant_ledger_id uuid NOT NULL,
  initial_principal_minor bigint NOT NULL,
  initial_bonus_minor bigint NOT NULL,
  principal_expires_at timestamptz NULL,
  bonus_expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_sv_lots_initial_principal_check CHECK (initial_principal_minor >= 0),
  CONSTRAINT customer_sv_lots_initial_bonus_check CHECK (initial_bonus_minor >= 0),
  CONSTRAINT customer_sv_lots_initial_positive CHECK (initial_principal_minor > 0 OR initial_bonus_minor > 0),
  CONSTRAINT customer_sv_lots_principal_no_expiry CHECK (principal_expires_at IS NULL),
  CONSTRAINT customer_sv_lots_status_check CHECK (status IN ('active', 'frozen', 'void')),
  CONSTRAINT customer_sv_lots_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_sv_lots_tenant_key UNIQUE (shop_id, account_id, customer_id, id),
  CONSTRAINT customer_sv_lots_grant_ledger_key UNIQUE (shop_id, grant_ledger_id),
  FOREIGN KEY (shop_id, customer_id, account_id) REFERENCES public.customer_stored_value_accounts(shop_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, grant_ledger_id) REFERENCES public.customer_stored_value_ledger(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_stored_value_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  spend_ledger_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  allocation_type text NOT NULL,
  original_allocation_id uuid NULL,
  allocated_principal_minor bigint NOT NULL DEFAULT 0,
  allocated_bonus_minor bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_sv_allocations_type_check CHECK (allocation_type IN ('consume', 'restore')),
  CONSTRAINT customer_sv_allocations_principal_check CHECK (allocated_principal_minor >= 0),
  CONSTRAINT customer_sv_allocations_bonus_check CHECK (allocated_bonus_minor >= 0),
  CONSTRAINT customer_sv_allocations_nonzero CHECK (allocated_principal_minor > 0 OR allocated_bonus_minor > 0),
  CONSTRAINT customer_sv_allocations_restore_ref_check CHECK (
    (allocation_type = 'consume' AND original_allocation_id IS NULL) OR
    (allocation_type = 'restore' AND original_allocation_id IS NOT NULL)
  ),
  CONSTRAINT customer_sv_allocations_no_self_ref CHECK (original_allocation_id IS NULL OR original_allocation_id <> id),
  CONSTRAINT customer_sv_allocations_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_sv_allocations_idempotency UNIQUE (shop_id, idempotency_key),
  CONSTRAINT customer_sv_allocations_spend_lot_type UNIQUE (shop_id, spend_ledger_id, lot_id, allocation_type),
  FOREIGN KEY (shop_id, account_id, customer_id, spend_ledger_id) REFERENCES public.customer_stored_value_ledger(shop_id, account_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, account_id, customer_id, lot_id) REFERENCES public.customer_stored_value_lots(shop_id, account_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_allocation_id) REFERENCES public.customer_stored_value_allocations(shop_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 4. POINTS ACCOUNTS, LOTS, LEDGER, AND ALLOCATIONS
-- ============================================================================

CREATE TABLE public.customer_points_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_points_accounts_status_check CHECK (status IN ('active', 'frozen', 'closed')),
  CONSTRAINT customer_points_accounts_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_points_accounts_customer_key UNIQUE (shop_id, customer_id),
  CONSTRAINT customer_points_accounts_tenant_key UNIQUE (shop_id, customer_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  entry_type text NOT NULL,
  points_delta bigint NOT NULL,
  idempotency_key text NOT NULL,
  original_ledger_id uuid NULL,
  reference_checkout_id uuid NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_points_ledger_entry_type_check CHECK (entry_type IN ('purchase_accrual', 'service_redemption', 'redemption_reversal', 'refund_clawback', 'expiration_forfeit', 'manual_adjustment')),
  CONSTRAINT customer_points_ledger_delta_nonzero CHECK (points_delta <> 0),
  CONSTRAINT customer_points_ledger_delta_direction CHECK (
    ((entry_type IN ('purchase_accrual', 'redemption_reversal')) AND points_delta > 0) OR
    ((entry_type IN ('service_redemption', 'refund_clawback', 'expiration_forfeit')) AND points_delta < 0) OR
    (entry_type = 'manual_adjustment' AND points_delta <> 0)
  ),
  CONSTRAINT customer_points_ledger_no_self_ref CHECK (original_ledger_id IS NULL OR original_ledger_id <> id),
  CONSTRAINT customer_points_ledger_reversal_ref_check CHECK (entry_type <> 'redemption_reversal' OR original_ledger_id IS NOT NULL),
  CONSTRAINT customer_points_ledger_reason_check CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT customer_points_ledger_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_points_ledger_idempotency UNIQUE (shop_id, idempotency_key),
  CONSTRAINT customer_points_ledger_tenant_key UNIQUE (shop_id, account_id, customer_id, id),
  FOREIGN KEY (shop_id, customer_id, account_id) REFERENCES public.customer_points_accounts(shop_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_ledger_id) REFERENCES public.customer_points_ledger(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_points_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  grant_ledger_id uuid NOT NULL,
  initial_points bigint NOT NULL,
  expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_points_lots_initial_check CHECK (initial_points > 0),
  CONSTRAINT customer_points_lots_status_check CHECK (status IN ('active', 'frozen', 'void')),
  CONSTRAINT customer_points_lots_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_points_lots_tenant_key UNIQUE (shop_id, account_id, customer_id, id),
  CONSTRAINT customer_points_lots_grant_ledger_key UNIQUE (shop_id, grant_ledger_id),
  FOREIGN KEY (shop_id, customer_id, account_id) REFERENCES public.customer_points_accounts(shop_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, grant_ledger_id) REFERENCES public.customer_points_ledger(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_points_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  spend_ledger_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  allocation_type text NOT NULL,
  original_allocation_id uuid NULL,
  allocated_points bigint NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_points_allocations_type_check CHECK (allocation_type IN ('consume', 'restore')),
  CONSTRAINT customer_points_allocations_points_check CHECK (allocated_points > 0),
  CONSTRAINT customer_points_allocations_restore_ref_check CHECK (
    (allocation_type = 'consume' AND original_allocation_id IS NULL) OR
    (allocation_type = 'restore' AND original_allocation_id IS NOT NULL)
  ),
  CONSTRAINT customer_points_allocations_no_self_ref CHECK (original_allocation_id IS NULL OR original_allocation_id <> id),
  CONSTRAINT customer_points_allocations_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT customer_points_allocations_idempotency UNIQUE (shop_id, idempotency_key),
  CONSTRAINT customer_points_allocations_spend_lot_type UNIQUE (shop_id, spend_ledger_id, lot_id, allocation_type),
  FOREIGN KEY (shop_id, account_id, customer_id, spend_ledger_id) REFERENCES public.customer_points_ledger(shop_id, account_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, account_id, customer_id, lot_id) REFERENCES public.customer_points_lots(shop_id, account_id, customer_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_allocation_id) REFERENCES public.customer_points_allocations(shop_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 5. POLICY AND STATUS AUDIT TABLES
-- ============================================================================

CREATE TABLE public.shop_entitlement_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz NULL,
  stored_value_spend_order text NOT NULL DEFAULT 'principal_first',
  discount_cap_basis_points integer NOT NULL DEFAULT 5000,
  stacking_mode text NOT NULL DEFAULT 'package_exclusive',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_entitlement_policies_version_check CHECK (policy_version > 0),
  CONSTRAINT shop_entitlement_policies_range_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT shop_entitlement_policies_spend_order_check CHECK (stored_value_spend_order IN ('principal_first', 'bonus_first', 'pro_rata')),
  CONSTRAINT shop_entitlement_policies_discount_cap_check CHECK (discount_cap_basis_points BETWEEN 0 AND 10000),
  CONSTRAINT shop_entitlement_policies_stacking_check CHECK (stacking_mode IN ('package_exclusive', 'strict_exclusive')),
  CONSTRAINT shop_entitlement_policies_shop_id_key UNIQUE (shop_id, id),
  CONSTRAINT shop_entitlement_policies_shop_version_key UNIQUE (shop_id, policy_version),
  CONSTRAINT shop_entitlement_policies_no_overlap EXCLUDE USING gist (
    shop_id WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);

CREATE TABLE public.customer_entitlement_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  old_status text NOT NULL,
  new_status text NOT NULL,
  reason text NOT NULL,
  operator_type text NOT NULL,
  operator_owner_id uuid NULL,
  operator_staff_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_status_history_entity_type_check CHECK (entity_type IN ('membership_enrollment', 'package', 'stored_value_account', 'stored_value_lot', 'points_account', 'points_lot')),
  CONSTRAINT entitlement_status_history_status_diff CHECK (old_status <> new_status),
  CONSTRAINT entitlement_status_history_reason_check CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT entitlement_status_history_operator_type CHECK (operator_type IN ('system', 'owner', 'staff')),
  CONSTRAINT entitlement_status_history_actor_check CHECK (
    (operator_type = 'system' AND operator_owner_id IS NULL AND operator_staff_id IS NULL) OR
    (operator_type = 'owner' AND operator_owner_id IS NOT NULL AND operator_staff_id IS NULL) OR
    (operator_type = 'staff' AND operator_staff_id IS NOT NULL AND operator_owner_id IS NULL)
  ),
  FOREIGN KEY (operator_owner_id, shop_id) REFERENCES public.owner_shop_memberships(owner_account_id, shop_id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, operator_staff_id) REFERENCES public.staff(shop_id, id) ON DELETE RESTRICT
);
CREATE INDEX customer_entitlement_status_history_entity_idx
  ON public.customer_entitlement_status_history(shop_id, entity_type, entity_id, created_at DESC);

-- ============================================================================
-- 6. TRIGGERS & BUSINESS INTEGRITY ENFORCEMENT
-- ============================================================================

-- Append-only trigger for ledgers, allocations, and status history
CREATE OR REPLACE FUNCTION public.reject_entitlement_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; update and delete are strictly forbidden', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER customer_package_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.customer_package_ledger
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

CREATE TRIGGER customer_stored_value_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.customer_stored_value_ledger
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

CREATE TRIGGER customer_stored_value_allocations_append_only
  BEFORE UPDATE OR DELETE ON public.customer_stored_value_allocations
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

CREATE TRIGGER customer_points_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.customer_points_ledger
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

CREATE TRIGGER customer_points_allocations_append_only
  BEFORE UPDATE OR DELETE ON public.customer_points_allocations
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

CREATE TRIGGER customer_entitlement_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.customer_entitlement_status_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_entitlement_append_only_mutation();

-- Policy parameters immutability trigger
CREATE OR REPLACE FUNCTION public.enforce_entitlement_policy_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deleting entitlement policy is forbidden' USING ERRCODE = '42501';
  END IF;
  IF OLD.stored_value_spend_order <> NEW.stored_value_spend_order
     OR OLD.discount_cap_basis_points <> NEW.discount_cap_basis_points
     OR OLD.stacking_mode <> NEW.stacking_mode
     OR OLD.effective_from <> NEW.effective_from
     OR OLD.policy_version <> NEW.policy_version
     OR OLD.shop_id <> NEW.shop_id THEN
    RAISE EXCEPTION 'entitlement policy parameters are immutable; create a new policy version instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shop_entitlement_policies_immutability
  BEFORE UPDATE OR DELETE ON public.shop_entitlement_policies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_entitlement_policy_update();

-- Auto-write status audit trigger on mutable status tables
CREATE OR REPLACE FUNCTION public.record_entitlement_status_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_operator_type text := current_setting('gg.operator_type', true);
  v_operator_id_raw text := current_setting('gg.operator_id', true);
  v_operator_id uuid;
  v_reason text := current_setting('gg.status_change_reason', true);
  v_entity_type text;
  v_owner_id uuid := NULL;
  v_staff_id uuid := NULL;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF v_operator_type IS NULL OR v_operator_type NOT IN ('system', 'owner', 'staff') THEN
    RAISE EXCEPTION 'entitlement status update requires active operator context in gg.operator_type'
      USING ERRCODE = '42501';
  END IF;

  IF v_operator_type <> 'system' THEN
    IF v_operator_id_raw IS NULL OR v_operator_id_raw = '' THEN
      RAISE EXCEPTION 'entitlement status update requires active operator id in gg.operator_id'
        USING ERRCODE = '42501';
    END IF;
    v_operator_id := v_operator_id_raw::uuid;
  END IF;

  IF v_reason IS NULL OR length(btrim(v_reason)) NOT BETWEEN 3 AND 500 THEN
    v_reason := 'status transitioned from ' || OLD.status || ' to ' || NEW.status;
  END IF;

  IF TG_TABLE_NAME = 'customer_membership_enrollments' THEN
    v_entity_type := 'membership_enrollment';
  ELSIF TG_TABLE_NAME = 'customer_packages' THEN
    v_entity_type := 'package';
  ELSIF TG_TABLE_NAME = 'customer_stored_value_accounts' THEN
    v_entity_type := 'stored_value_account';
  ELSIF TG_TABLE_NAME = 'customer_stored_value_lots' THEN
    v_entity_type := 'stored_value_lot';
  ELSIF TG_TABLE_NAME = 'customer_points_accounts' THEN
    v_entity_type := 'points_account';
  ELSIF TG_TABLE_NAME = 'customer_points_lots' THEN
    v_entity_type := 'points_lot';
  ELSE
    RAISE EXCEPTION 'unknown entity type for status history trigger: %', TG_TABLE_NAME;
  END IF;

  IF v_operator_type = 'owner' THEN
    v_owner_id := v_operator_id;
  ELSIF v_operator_type = 'staff' THEN
    v_staff_id := v_operator_id;
  END IF;

  INSERT INTO public.customer_entitlement_status_history (
    shop_id, entity_type, entity_id, old_status, new_status, reason, operator_type, operator_owner_id, operator_staff_id
  ) VALUES (
    NEW.shop_id, v_entity_type, NEW.id, OLD.status, NEW.status, v_reason, v_operator_type, v_owner_id, v_staff_id
  );

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_membership_enrollments_status_audit
  BEFORE UPDATE OF status ON public.customer_membership_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

CREATE TRIGGER customer_packages_status_audit
  BEFORE UPDATE OF status ON public.customer_packages
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

CREATE TRIGGER customer_stored_value_accounts_status_audit
  BEFORE UPDATE OF status ON public.customer_stored_value_accounts
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

CREATE TRIGGER customer_stored_value_lots_status_audit
  BEFORE UPDATE OF status ON public.customer_stored_value_lots
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

CREATE TRIGGER customer_points_accounts_status_audit
  BEFORE UPDATE OF status ON public.customer_points_accounts
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

CREATE TRIGGER customer_points_lots_status_audit
  BEFORE UPDATE OF status ON public.customer_points_lots
  FOR EACH ROW EXECUTE FUNCTION public.record_entitlement_status_history();

-- DEFERRABLE constraint trigger: Stored Value Lot initial amounts must match grant ledger
CREATE OR REPLACE FUNCTION public.check_stored_value_lot_grant_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_principal bigint;
  v_bonus bigint;
  v_entry_type text;
BEGIN
  SELECT principal_delta_minor, bonus_delta_minor, entry_type
    INTO v_principal, v_bonus, v_entry_type
    FROM public.customer_stored_value_ledger
   WHERE shop_id = NEW.shop_id AND id = NEW.grant_ledger_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stored value lot grant ledger % missing in shop %', NEW.grant_ledger_id, NEW.shop_id
      USING ERRCODE = '23503';
  END IF;

  IF v_entry_type <> 'topup_grant' THEN
    RAISE EXCEPTION 'stored value lot grant ledger must have entry_type topup_grant'
      USING ERRCODE = '23514';
  END IF;

  IF v_principal <> NEW.initial_principal_minor OR v_bonus <> NEW.initial_bonus_minor THEN
    RAISE EXCEPTION 'stored value lot amounts (principal %, bonus %) do not match grant ledger (principal %, bonus %)',
      NEW.initial_principal_minor, NEW.initial_bonus_minor, v_principal, v_bonus
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_stored_value_lot_grant_match_trigger
  AFTER INSERT OR UPDATE ON public.customer_stored_value_lots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_stored_value_lot_grant_match();

-- DEFERRABLE constraint trigger: Points Lot initial points must match grant ledger
CREATE OR REPLACE FUNCTION public.check_points_lot_grant_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_points bigint;
  v_entry_type text;
BEGIN
  SELECT points_delta, entry_type
    INTO v_points, v_entry_type
    FROM public.customer_points_ledger
   WHERE shop_id = NEW.shop_id AND id = NEW.grant_ledger_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'points lot grant ledger % missing in shop %', NEW.grant_ledger_id, NEW.shop_id
      USING ERRCODE = '23503';
  END IF;

  IF v_entry_type <> 'purchase_accrual' THEN
    RAISE EXCEPTION 'points lot grant ledger must have entry_type purchase_accrual'
      USING ERRCODE = '23514';
  END IF;

  IF v_points <> NEW.initial_points THEN
    RAISE EXCEPTION 'points lot amount (%) does not match grant ledger (%)',
      NEW.initial_points, v_points
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_points_lot_grant_match_trigger
  AFTER INSERT OR UPDATE ON public.customer_points_lots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_points_lot_grant_match();

-- Allocation integrity trigger (consume vs restore limits and directional match)
CREATE OR REPLACE FUNCTION public.check_stored_value_allocation_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_spend_entry text;
  v_spend_principal bigint;
  v_spend_bonus bigint;
  v_orig_type text;
  v_orig_principal bigint;
  v_orig_bonus bigint;
  v_cum_restored_principal bigint;
  v_cum_restored_bonus bigint;
BEGIN
  SELECT entry_type, principal_delta_minor, bonus_delta_minor
    INTO v_spend_entry, v_spend_principal, v_spend_bonus
    FROM public.customer_stored_value_ledger
   WHERE shop_id = NEW.shop_id AND id = NEW.spend_ledger_id;

  IF NEW.allocation_type = 'consume' THEN
    IF v_spend_entry <> 'service_spend' OR v_spend_principal > 0 OR v_spend_bonus > 0 THEN
      RAISE EXCEPTION 'consume allocation must link to service_spend ledger with negative delta'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.allocation_type = 'restore' THEN
    IF v_spend_entry NOT IN ('spend_reversal', 'refund_payout', 'refund_bonus_void')
       OR (v_spend_principal < 0 AND v_spend_entry = 'spend_reversal') THEN
      RAISE EXCEPTION 'restore allocation must link to positive reversal/refund ledger'
        USING ERRCODE = '23514';
    END IF;

    SELECT allocation_type, allocated_principal_minor, allocated_bonus_minor
      INTO v_orig_type, v_orig_principal, v_orig_bonus
      FROM public.customer_stored_value_allocations
     WHERE shop_id = NEW.shop_id AND id = NEW.original_allocation_id;

    IF v_orig_type <> 'consume' THEN
      RAISE EXCEPTION 'restore allocation original_allocation_id must be a consume allocation'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(allocated_principal_minor), 0), COALESCE(SUM(allocated_bonus_minor), 0)
      INTO v_cum_restored_principal, v_cum_restored_bonus
      FROM public.customer_stored_value_allocations
     WHERE shop_id = NEW.shop_id AND original_allocation_id = NEW.original_allocation_id;

    IF (v_cum_restored_principal + NEW.allocated_principal_minor > v_orig_principal) OR
       (v_cum_restored_bonus + NEW.allocated_bonus_minor > v_orig_bonus) THEN
      RAISE EXCEPTION 'cumulative restore allocation exceeds original consume allocation amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_stored_value_allocation_integrity_trigger
  BEFORE INSERT ON public.customer_stored_value_allocations
  FOR EACH ROW EXECUTE FUNCTION public.check_stored_value_allocation_integrity();

CREATE OR REPLACE FUNCTION public.check_points_allocation_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_spend_entry text;
  v_spend_points bigint;
  v_orig_type text;
  v_orig_points bigint;
  v_cum_restored_points bigint;
BEGIN
  SELECT entry_type, points_delta
    INTO v_spend_entry, v_spend_points
    FROM public.customer_points_ledger
   WHERE shop_id = NEW.shop_id AND id = NEW.spend_ledger_id;

  IF NEW.allocation_type = 'consume' THEN
    IF v_spend_entry <> 'service_redemption' OR v_spend_points > 0 THEN
      RAISE EXCEPTION 'points consume allocation must link to service_redemption ledger with negative delta'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.allocation_type = 'restore' THEN
    IF v_spend_entry NOT IN ('redemption_reversal', 'refund_clawback') THEN
      RAISE EXCEPTION 'points restore allocation must link to redemption_reversal/refund_clawback ledger'
        USING ERRCODE = '23514';
    END IF;

    SELECT allocation_type, allocated_points
      INTO v_orig_type, v_orig_points
      FROM public.customer_points_allocations
     WHERE shop_id = NEW.shop_id AND id = NEW.original_allocation_id;

    IF v_orig_type <> 'consume' THEN
      RAISE EXCEPTION 'points restore allocation original_allocation_id must be a consume allocation'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(allocated_points), 0)
      INTO v_cum_restored_points
      FROM public.customer_points_allocations
     WHERE shop_id = NEW.shop_id AND original_allocation_id = NEW.original_allocation_id;

    IF (v_cum_restored_points + NEW.allocated_points > v_orig_points) THEN
      RAISE EXCEPTION 'cumulative points restore allocation exceeds original consume allocation amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_points_allocation_integrity_trigger
  BEFORE INSERT ON public.customer_points_allocations
  FOR EACH ROW EXECUTE FUNCTION public.check_points_allocation_integrity();

-- Over-reversal check for customer_package_ledger
CREATE OR REPLACE FUNCTION public.check_package_ledger_reversal_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig_entry text;
  v_orig_delta integer;
  v_cum_reversal integer;
BEGIN
  IF NEW.original_ledger_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT entry_type, session_delta
    INTO v_orig_entry, v_orig_delta
    FROM public.customer_package_ledger
   WHERE shop_id = NEW.shop_id AND id = NEW.original_ledger_id;

  IF NEW.entry_type = 'redemption_reversal' THEN
    IF v_orig_entry <> 'redemption' THEN
      RAISE EXCEPTION 'redemption_reversal must reference a redemption entry' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(session_delta), 0)
      INTO v_cum_reversal
      FROM public.customer_package_ledger
     WHERE shop_id = NEW.shop_id AND original_ledger_id = NEW.original_ledger_id;
    IF v_cum_reversal + NEW.session_delta > ABS(v_orig_delta) THEN
      RAISE EXCEPTION 'cumulative redemption reversal exceeds original redemption sessions' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.entry_type = 'partial_refund_deduction' THEN
    IF v_orig_entry <> 'purchase_grant' THEN
      RAISE EXCEPTION 'partial_refund_deduction must reference a purchase_grant entry' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(ABS(session_delta)), 0)
      INTO v_cum_reversal
      FROM public.customer_package_ledger
     WHERE shop_id = NEW.shop_id AND original_ledger_id = NEW.original_ledger_id AND entry_type = 'partial_refund_deduction';
    IF v_cum_reversal + ABS(NEW.session_delta) > v_orig_delta THEN
      RAISE EXCEPTION 'cumulative partial refund deduction exceeds purchase grant total sessions' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_package_ledger_reversal_limit_trigger
  BEFORE INSERT ON public.customer_package_ledger
  FOR EACH ROW EXECUTE FUNCTION public.check_package_ledger_reversal_limit();

-- ============================================================================
-- 7. READ-ONLY BALANCE VIEWS (DYNAMIC AGGREGATION)
-- ============================================================================

CREATE OR REPLACE VIEW public.v_customer_package_balances AS
SELECT
  cp.shop_id,
  cp.customer_id,
  cp.id AS customer_package_id,
  cp.package_definition_id,
  cp.package_name_snapshot,
  cp.currency_code,
  cp.purchase_price_minor,
  cp.total_sessions,
  COALESCE(SUM(l.session_delta), 0)::integer AS remaining_sessions,
  CASE
    WHEN cp.status = 'active' AND (cp.expires_at IS NULL OR cp.expires_at > now())
    THEN GREATEST(0, COALESCE(SUM(l.session_delta), 0))::integer
    ELSE 0
  END AS usable_sessions,
  (COALESCE(SUM(l.session_delta), 0) <= 0) AS is_exhausted,
  (cp.expires_at IS NOT NULL AND cp.expires_at <= now()) AS is_expired,
  cp.status,
  cp.activated_at,
  cp.expires_at
FROM public.customer_packages cp
LEFT JOIN public.customer_package_ledger l
  ON l.shop_id = cp.shop_id AND l.customer_package_id = cp.id AND l.customer_id = cp.customer_id
GROUP BY cp.shop_id, cp.customer_id, cp.id;

CREATE OR REPLACE VIEW public.v_customer_stored_value_balances AS
WITH lot_balances AS (
  SELECT
    lot.shop_id,
    lot.customer_id,
    lot.account_id,
    lot.id AS lot_id,
    lot.initial_principal_minor,
    lot.initial_bonus_minor,
    lot.principal_expires_at,
    lot.bonus_expires_at,
    lot.status AS lot_status,
    COALESCE(SUM(CASE WHEN a.allocation_type = 'consume' THEN a.allocated_principal_minor WHEN a.allocation_type = 'restore' THEN -a.allocated_principal_minor ELSE 0 END), 0) AS principal_consumed,
    COALESCE(SUM(CASE WHEN a.allocation_type = 'consume' THEN a.allocated_bonus_minor WHEN a.allocation_type = 'restore' THEN -a.allocated_bonus_minor ELSE 0 END), 0) AS bonus_consumed
  FROM public.customer_stored_value_lots lot
  LEFT JOIN public.customer_stored_value_allocations a
    ON a.shop_id = lot.shop_id AND a.lot_id = lot.id
  GROUP BY lot.shop_id, lot.customer_id, lot.account_id, lot.id
),
account_lots_summary AS (
  SELECT
    shop_id,
    customer_id,
    account_id,
    SUM(CASE WHEN lot_status = 'active' AND (principal_expires_at IS NULL OR principal_expires_at > now()) THEN GREATEST(0, initial_principal_minor - principal_consumed) ELSE 0 END) AS usable_principal_minor,
    SUM(CASE WHEN lot_status = 'active' AND (bonus_expires_at IS NULL OR bonus_expires_at > now()) THEN GREATEST(0, initial_bonus_minor - bonus_consumed) ELSE 0 END) AS usable_bonus_minor
  FROM lot_balances
  GROUP BY shop_id, customer_id, account_id
),
ledger_summary AS (
  SELECT
    shop_id,
    customer_id,
    account_id,
    COALESCE(SUM(principal_delta_minor), 0) AS ledger_principal_balance_minor,
    COALESCE(SUM(bonus_delta_minor), 0) AS ledger_bonus_balance_minor
  FROM public.customer_stored_value_ledger
  GROUP BY shop_id, customer_id, account_id
)
SELECT
  acc.shop_id,
  acc.customer_id,
  acc.id AS account_id,
  acc.currency_code,
  acc.status,
  COALESCE(ls.ledger_principal_balance_minor, 0) AS ledger_principal_balance_minor,
  COALESCE(ls.ledger_bonus_balance_minor, 0) AS ledger_bonus_balance_minor,
  (COALESCE(ls.ledger_principal_balance_minor, 0) + COALESCE(ls.ledger_bonus_balance_minor, 0)) AS ledger_total_balance_minor,
  CASE WHEN acc.status = 'active' THEN COALESCE(als.usable_principal_minor, 0) ELSE 0 END AS usable_principal_balance_minor,
  CASE WHEN acc.status = 'active' THEN COALESCE(als.usable_bonus_minor, 0) ELSE 0 END AS usable_bonus_balance_minor,
  CASE WHEN acc.status = 'active' THEN (COALESCE(als.usable_principal_minor, 0) + COALESCE(als.usable_bonus_minor, 0)) ELSE 0 END AS usable_total_balance_minor
FROM public.customer_stored_value_accounts acc
LEFT JOIN ledger_summary ls ON ls.shop_id = acc.shop_id AND ls.account_id = acc.id AND ls.customer_id = acc.customer_id
LEFT JOIN account_lots_summary als ON als.shop_id = acc.shop_id AND als.account_id = acc.id AND als.customer_id = acc.customer_id;

CREATE OR REPLACE VIEW public.v_customer_points_balances AS
WITH lot_balances AS (
  SELECT
    lot.shop_id,
    lot.customer_id,
    lot.account_id,
    lot.id AS lot_id,
    lot.initial_points,
    lot.expires_at,
    lot.status AS lot_status,
    COALESCE(SUM(CASE WHEN a.allocation_type = 'consume' THEN a.allocated_points WHEN a.allocation_type = 'restore' THEN -a.allocated_points ELSE 0 END), 0) AS points_consumed
  FROM public.customer_points_lots lot
  LEFT JOIN public.customer_points_allocations a
    ON a.shop_id = lot.shop_id AND a.lot_id = lot.id
  GROUP BY lot.shop_id, lot.customer_id, lot.account_id, lot.id
),
account_lots_summary AS (
  SELECT
    shop_id,
    customer_id,
    account_id,
    SUM(CASE WHEN lot_status = 'active' AND (expires_at IS NULL OR expires_at > now()) THEN GREATEST(0, initial_points - points_consumed) ELSE 0 END) AS usable_points
  FROM lot_balances
  GROUP BY shop_id, customer_id, account_id
),
ledger_summary AS (
  SELECT
    shop_id,
    customer_id,
    account_id,
    COALESCE(SUM(points_delta), 0) AS ledger_points_balance
  FROM public.customer_points_ledger
  GROUP BY shop_id, customer_id, account_id
)
SELECT
  acc.shop_id,
  acc.customer_id,
  acc.id AS account_id,
  acc.status,
  COALESCE(ls.ledger_points_balance, 0) AS ledger_points_balance,
  CASE WHEN acc.status = 'active' THEN COALESCE(als.usable_points, 0) ELSE 0 END AS usable_points_balance
FROM public.customer_points_accounts acc
LEFT JOIN ledger_summary ls ON ls.shop_id = acc.shop_id AND ls.account_id = acc.id AND ls.customer_id = acc.customer_id
LEFT JOIN account_lots_summary als ON als.shop_id = acc.shop_id AND als.account_id = acc.id AND als.customer_id = acc.customer_id;

-- ============================================================================
-- 8. SECURITY DEFINER HELPER & PERMISSION REVOCATION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_entitlement_operator_context(
  p_operator_type text,
  p_operator_id uuid,
  p_reason text DEFAULT 'status change'
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF p_operator_type IS NULL OR p_operator_type NOT IN ('system', 'owner', 'staff') THEN
    RAISE EXCEPTION 'invalid operator_type';
  END IF;
  PERFORM set_config('gg.operator_type', p_operator_type, true);
  IF p_operator_type = 'system' THEN
    PERFORM set_config('gg.operator_id', '', true);
  ELSE
    IF p_operator_id IS NULL THEN RAISE EXCEPTION 'operator_id required'; END IF;
    PERFORM set_config('gg.operator_id', p_operator_id::text, true);
  END IF;
  PERFORM set_config('gg.status_change_reason', COALESCE(p_reason, 'status change'), true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_entitlement_operator_context(text, uuid, text) FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE ON
  public.customer_package_ledger,
  public.customer_stored_value_ledger,
  public.customer_stored_value_lots,
  public.customer_stored_value_allocations,
  public.customer_points_ledger,
  public.customer_points_lots,
  public.customer_points_allocations,
  public.customer_entitlement_status_history
FROM PUBLIC;

COMMIT;
