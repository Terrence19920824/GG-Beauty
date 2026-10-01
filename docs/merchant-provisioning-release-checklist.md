# Merchant Provisioning Foundation V1 — Production Release Checklist

## 1. Release Preconditions
- [ ] Database backup snapshot completed before executing migrations.
- [ ] Authoritative baseline confirmed at `771551cb78946c9c076bdafe9bc90f85234613af`.
- [ ] Staging preflight validation executed cleanly.

## 2. Migration Execution Order
Execute the migration scripts in the exact sequence:

1. `migrations/093_merchant_tenant_mode_preflight_readonly.sql`
   - Read-only verification that `public.shops` exists, `tenant_mode` is not already present, and UUID/status columns match.
2. `migrations/094_merchant_tenant_mode_schema.sql`
   - Additive schema change: adds `tenant_mode TEXT NOT NULL DEFAULT 'live'` with check constraint `('demo', 'test', 'live')`.
3. `migrations/095_merchant_tenant_mode_verification_readonly.sql`
   - Read-only verification of column presence, non-nullability, and check constraint integrity.
4. `migrations/096_merchant_known_tenants_classification_controlled.sql`
   - Guarded controlled classification step.
   - Updates ONLY exact known merchants:
     - GG-Beauty (`5e002f26-1267-4bb6-8c73-d60f11985799`, `gg-beauty`) -> `demo`
     - GG-Beauty Test Shop (`aa7a9c1b-a9c1-4775-86bd-9c11b16eb451`, `gg-beauty-test`) -> `test`
   - **Fails closed** with exception rollback if either merchant UUID or slug does not match.
   - Does NOT touch or auto-classify any unknown merchant.
   - Does NOT delete or reset any merchant data.
5. `migrations/097_merchant_known_tenants_classification_verification_readonly.sql`
   - Read-only verification that both known merchants hold their expected tenant modes (`demo` and `test`).

## 3. Rollback Plan
If any step fails or needs to be rolled back:
1. Controlled classification rollback:
   - Run `migrations/rollback/096_merchant_known_tenants_classification_rollback.sql` to revert the two shops back to `live`.
2. Schema rollback:
   - Run `migrations/rollback/094_merchant_tenant_mode_rollback.sql` to drop constraint and column.
   - Note: Rollback does NOT drop `public.shops` or remove merchant records.

## 4. Merchant Provisioning Operation (Post-Release)
- Use `scripts/provision-merchant.js` for new merchant provisioning.
- Interactive secure TTY prompt is required for initial owner password. Plaintext command-line password flags (`--owner-password`) are strictly forbidden and rejected.
- Categories can be supplied via `--categories-json '[{"canonicalName":"...","nameZh":"...","nameEn":"..."}]'`.
