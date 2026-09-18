'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const sql = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '11111111-1111-4111-8111-222222222222',
  customerA: '22222222-2222-4222-8222-111111111111',
  customerB: '22222222-2222-4222-8222-222222222222',
  serviceA: '33333333-3333-4333-8333-111111111111',
  serviceB: '33333333-3333-4333-8333-222222222222',
  ownerAccount: '44444444-4444-4444-8444-111111111111',
  staffA: '55555555-5555-4555-8555-111111111111',
  appointmentA: '66666666-6666-4666-8666-111111111111',
  itemA: '77777777-7777-4777-8777-111111111111',
  checkoutA: '88888888-8888-4888-8888-111111111111',
  checkoutLineA: '99999999-9999-4999-8999-111111111111'
};

async function connect(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const db = new Client({ connectionString: url });
    try {
      await db.connect();
      return db;
    } catch (error) {
      lastError = error;
      await db.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Unable to connect to PostgreSQL');
}

async function withIsolatedPostgres(t, testFn) {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    return t.skip('PostgreSQL 17 unavailable');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-entitlements-pg-'));
  const data = path.join(temp, 'data');
  const port = 58200 + Math.floor(Math.random() * 100);

  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  let db;

  try {
    const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
    db = await connect(url);

    // Setup base prerequisite schema matching migrations 000-052
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE shops (id uuid PRIMARY KEY);
      CREATE TABLE customers (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE services (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE shop_customer_settings (
        shop_id uuid PRIMARY KEY REFERENCES shops(id),
        member_code_prefix text NOT NULL DEFAULT 'MEM-',
        member_code_width smallint NOT NULL DEFAULT 6,
        dob_requirement text NOT NULL DEFAULT 'optional',
        default_phone_country_code text NOT NULL DEFAULT '+65'
      );
      CREATE TABLE staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE (shop_id, id));
      CREATE TABLE owner_accounts (id uuid PRIMARY KEY);
      CREATE TABLE owner_shop_memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
        shop_id uuid NOT NULL REFERENCES shops(id),
        role text NOT NULL DEFAULT 'owner',
        UNIQUE (owner_account_id, shop_id)
      );
      CREATE TABLE appointments (
        id uuid PRIMARY KEY,
        shop_id uuid NOT NULL,
        recipient_customer_id uuid NOT NULL,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY,
        shop_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE checkout_transactions (
        id uuid PRIMARY KEY,
        shop_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE checkout_line_items (
        id uuid PRIMARY KEY,
        shop_id uuid NOT NULL,
        checkout_id uuid NOT NULL,
        UNIQUE (shop_id, id)
      );

      -- Seed test records for Shop A and Shop B
      INSERT INTO shops (id) VALUES ('${ID.shopA}'), ('${ID.shopB}');
      INSERT INTO customers (id, shop_id) VALUES ('${ID.customerA}', '${ID.shopA}'), ('${ID.customerB}', '${ID.shopB}');
      INSERT INTO services (id, shop_id) VALUES ('${ID.serviceA}', '${ID.shopA}'), ('${ID.serviceB}', '${ID.shopB}');
      INSERT INTO shop_customer_settings (shop_id) VALUES ('${ID.shopA}'), ('${ID.shopB}');
      INSERT INTO staff (id, shop_id) VALUES ('${ID.staffA}', '${ID.shopA}');
      INSERT INTO owner_accounts (id) VALUES ('${ID.ownerAccount}');
      INSERT INTO owner_shop_memberships (owner_account_id, shop_id) VALUES ('${ID.ownerAccount}', '${ID.shopA}');
      INSERT INTO appointments (id, shop_id, recipient_customer_id) VALUES ('${ID.appointmentA}', '${ID.shopA}', '${ID.customerA}');
      INSERT INTO appointment_items (id, shop_id, appointment_id) VALUES ('${ID.itemA}', '${ID.shopA}', '${ID.appointmentA}');
      INSERT INTO checkout_transactions (id, shop_id, appointment_id, customer_id) VALUES ('${ID.checkoutA}', '${ID.shopA}', '${ID.appointmentA}', '${ID.customerA}');
      INSERT INTO checkout_line_items (id, shop_id, checkout_id) VALUES ('${ID.checkoutLineA}', '${ID.shopA}', '${ID.checkoutA}');
    `);

    await testFn(db);
  } finally {
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('053 -> 054 -> 055 migration chain executes cleanly and verifies on PostgreSQL 17', { timeout: 120000 }, async t => {
  await withIsolatedPostgres(t, async db => {
    // 1. Run 053 preflight
    await db.query(sql('053_customer_entitlements_preflight_readonly.sql'));

    // 2. Run 054 schema migration
    await db.query(sql('054_customer_entitlements_schema.sql'));

    // 3. Run 055 verification
    await db.query(sql('055_customer_entitlements_verification_readonly.sql'));

    // 4. Repeated 053 run fails closed because objects already exist
    await assert.rejects(
      db.query(sql('053_customer_entitlements_preflight_readonly.sql')),
      error => /entitlement objects already exist/.test(error.message)
    );
  });
});

test('PostgreSQL 17 enforces append-only, tenant FKs, and policy exclusions', { timeout: 120000 }, async t => {
  await withIsolatedPostgres(t, async db => {
    await db.query(sql('053_customer_entitlements_preflight_readonly.sql'));
    await db.query(sql('054_customer_entitlements_schema.sql'));
    await db.query(sql('055_customer_entitlements_verification_readonly.sql'));

    // A. Cross-tenant FK rejection: linking Shop A tier to Shop B service
    const tierResult = await db.query(`
      INSERT INTO customer_membership_tiers (shop_id, tier_code, name_zh, name_en, default_discount_basis_points)
      VALUES ('${ID.shopA}', 'GOLD', '金卡', 'Gold', 1000)
      RETURNING id;
    `);
    const tierId = tierResult.rows[0].id;

    await assert.rejects(
      db.query(`
        INSERT INTO customer_membership_tier_rules (shop_id, tier_id, service_id, discount_basis_points)
        VALUES ('${ID.shopA}', '${tierId}', '${ID.serviceB}', 1500);
      `),
      error => /violates foreign key constraint/.test(error.message)
    );

    // B. Policy non-overlapping exclusion constraint
    await db.query(`
      INSERT INTO shop_entitlement_policies (shop_id, policy_version, effective_from, effective_to, stored_value_spend_order)
      VALUES ('${ID.shopA}', 1, '2026-01-01 00:00:00+08', '2026-06-01 00:00:00+08', 'principal_first');
    `);

    // Overlapping interval for same shop rejected
    await assert.rejects(
      db.query(`
        INSERT INTO shop_entitlement_policies (shop_id, policy_version, effective_from, effective_to, stored_value_spend_order)
        VALUES ('${ID.shopA}', 2, '2026-03-01 00:00:00+08', '2026-09-01 00:00:00+08', 'principal_first');
      `),
      error => /conflicting key value violates exclusion constraint/.test(error.message)
    );

    // Same interval for DIFFERENT shop succeeds
    await db.query(`
      INSERT INTO shop_entitlement_policies (shop_id, policy_version, effective_from, effective_to, stored_value_spend_order)
      VALUES ('${ID.shopB}', 1, '2026-01-01 00:00:00+08', '2026-06-01 00:00:00+08', 'principal_first');
    `);

    // Non-overlapping interval for Shop A succeeds
    await db.query(`
      INSERT INTO shop_entitlement_policies (shop_id, policy_version, effective_from, effective_to, stored_value_spend_order)
      VALUES ('${ID.shopA}', 2, '2026-06-01 00:00:00+08', '2026-12-31 00:00:00+08', 'principal_first');
    `);

    // Policy parameters are immutable
    await assert.rejects(
      db.query(`UPDATE shop_entitlement_policies SET stored_value_spend_order = 'bonus_first' WHERE shop_id = '${ID.shopA}' AND policy_version = 1`),
      error => /entitlement policy parameters are immutable/.test(error.message)
    );

    // Closing policy by updating effective_to and is_active succeeds
    await db.query(`UPDATE shop_entitlement_policies SET effective_to = '2026-05-01 00:00:00+08', is_active = false WHERE shop_id = '${ID.shopA}' AND policy_version = 1`);

    // C. Stored Value Account and Deferrable Constraint Trigger for Lot/Grant matching
    const svAccountResult = await db.query(`
      INSERT INTO customer_stored_value_accounts (shop_id, customer_id, currency_code)
      VALUES ('${ID.shopA}', '${ID.customerA}', 'SGD')
      RETURNING id;
    `);
    const svAccountId = svAccountResult.rows[0].id;

    const grantLedgerResult = await db.query(`
      INSERT INTO customer_stored_value_ledger (
        shop_id, customer_id, account_id, entry_type, principal_delta_minor, bonus_delta_minor, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${svAccountId}', 'topup_grant', 10000, 2000, 'idem-topup-1', 'Initial topup'
      ) RETURNING id;
    `);
    const grantLedgerId = grantLedgerResult.rows[0].id;

    // Lot amounts mismatch with grant ledger -> fails deferred check at COMMIT!
    await assert.rejects(
      db.query(`
        BEGIN;
        INSERT INTO customer_stored_value_lots (
          shop_id, customer_id, account_id, grant_ledger_id, initial_principal_minor, initial_bonus_minor
        ) VALUES (
          '${ID.shopA}', '${ID.customerA}', '${svAccountId}', '${grantLedgerId}', 9999, 2000
        );
        COMMIT;
      `),
      error => /do not match grant ledger/.test(error.message)
    );

    // Matching Lot amounts succeeds
    const lotResult = await db.query(`
      INSERT INTO customer_stored_value_lots (
        shop_id, customer_id, account_id, grant_ledger_id, initial_principal_minor, initial_bonus_minor
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${svAccountId}', '${grantLedgerId}', 10000, 2000
      ) RETURNING id;
    `);
    const lotId = lotResult.rows[0].id;

    // Append-only defense on stored value ledger
    await assert.rejects(
      db.query(`UPDATE customer_stored_value_ledger SET reason = 'tampered' WHERE id = '${grantLedgerId}'`),
      error => /table customer_stored_value_ledger is append-only/.test(error.message)
    );
    await assert.rejects(
      db.query(`DELETE FROM customer_stored_value_ledger WHERE id = '${grantLedgerId}'`),
      error => /table customer_stored_value_ledger is append-only/.test(error.message)
    );

    // Duplicate idempotency key rejected
    await assert.rejects(
      db.query(`
        INSERT INTO customer_stored_value_ledger (
          shop_id, customer_id, account_id, entry_type, principal_delta_minor, bonus_delta_minor, idempotency_key, reason
        ) VALUES (
          '${ID.shopA}', '${ID.customerA}', '${svAccountId}', 'topup_grant', 5000, 0, 'idem-topup-1', 'Duplicate'
        );
      `),
      error => /duplicate key value violates unique constraint/.test(error.message)
    );

    // D. Allocation & Restore limits
    const spendLedgerResult = await db.query(`
      INSERT INTO customer_stored_value_ledger (
        shop_id, customer_id, account_id, entry_type, principal_delta_minor, bonus_delta_minor, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${svAccountId}', 'service_spend', -5000, 0, 'idem-spend-1', 'Service deduction'
      ) RETURNING id;
    `);
    const spendLedgerId = spendLedgerResult.rows[0].id;

    const consumeAllocResult = await db.query(`
      INSERT INTO customer_stored_value_allocations (
        shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, allocated_principal_minor, allocated_bonus_minor, idempotency_key
      ) VALUES (
        '${ID.shopA}', '${svAccountId}', '${ID.customerA}', '${spendLedgerId}', '${lotId}', 'consume', 5000, 0, 'idem-alloc-1'
      ) RETURNING id;
    `);
    const consumeAllocId = consumeAllocResult.rows[0].id;

    // Allocation append-only check
    await assert.rejects(
      db.query(`UPDATE customer_stored_value_allocations SET allocated_principal_minor = 1000 WHERE id = '${consumeAllocId}'`),
      error => /table customer_stored_value_allocations is append-only/.test(error.message)
    );

    // Spend reversal ledger and restore allocation
    const reversalLedgerResult = await db.query(`
      INSERT INTO customer_stored_value_ledger (
        shop_id, customer_id, account_id, entry_type, principal_delta_minor, bonus_delta_minor, original_ledger_id, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${svAccountId}', 'spend_reversal', 5000, 0, '${spendLedgerId}', 'idem-rev-1', 'Refund spend'
      ) RETURNING id;
    `);
    const reversalLedgerId = reversalLedgerResult.rows[0].id;

    // Over-restore rejected (restoring 6000 > original 5000)
    await assert.rejects(
      db.query(`
        INSERT INTO customer_stored_value_allocations (
          shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, original_allocation_id, allocated_principal_minor, allocated_bonus_minor, idempotency_key
        ) VALUES (
          '${ID.shopA}', '${svAccountId}', '${ID.customerA}', '${reversalLedgerId}', '${lotId}', 'restore', '${consumeAllocId}', 6000, 0, 'idem-alloc-restore-fail'
        );
      `),
      error => /cumulative restore allocation exceeds original consume/.test(error.message)
    );

    // Valid restore succeeds
    await db.query(`
      INSERT INTO customer_stored_value_allocations (
        shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, original_allocation_id, allocated_principal_minor, allocated_bonus_minor, idempotency_key
      ) VALUES (
        '${ID.shopA}', '${svAccountId}', '${ID.customerA}', '${reversalLedgerId}', '${lotId}', 'restore', '${consumeAllocId}', 5000, 0, 'idem-alloc-restore-ok'
      );
    `);

    // E. Status audit auto-write verification
    // Updating status without operator context fails
    await assert.rejects(
      db.query(`UPDATE customer_stored_value_accounts SET status = 'frozen' WHERE id = '${svAccountId}'`),
      error => /entitlement status update requires active operator context/.test(error.message)
    );

    // Updating status WITH operator context auto-inserts status audit
    await db.query(`
      BEGIN;
      SET LOCAL gg.operator_type = 'system';
      SET LOCAL gg.status_change_reason = 'Periodic account freeze test';
      UPDATE customer_stored_value_accounts SET status = 'frozen' WHERE id = '${svAccountId}';
      COMMIT;
    `);

    const auditCheck = await db.query(`
      SELECT entity_type, entity_id, old_status, new_status, operator_type
      FROM customer_entitlement_status_history
      WHERE shop_id = '${ID.shopA}' AND entity_id = '${svAccountId}';
    `);
    assert.equal(auditCheck.rows.length, 1);
    assert.equal(auditCheck.rows[0].entity_type, 'stored_value_account');
    assert.equal(auditCheck.rows[0].old_status, 'active');
    assert.equal(auditCheck.rows[0].new_status, 'frozen');
    assert.equal(auditCheck.rows[0].operator_type, 'system');


    // G. Package Definition, Instance & Ledger Reversal Limits
    const pkgDefResult = await db.query(`
      INSERT INTO package_definitions (
        shop_id, package_code, name_zh, name_en, total_sessions, retail_price_minor
      ) VALUES (
        '${ID.shopA}', 'FACIAL10', '面部护理10次卡', 'Facial 10 Sessions', 10, 100000
      ) RETURNING id;
    `);
    const pkgDefId = pkgDefResult.rows[0].id;

    const pkgInstResult = await db.query(`
      INSERT INTO customer_packages (
        shop_id, customer_id, package_definition_id, purchase_checkout_id, purchase_checkout_line_id,
        package_name_snapshot, purchase_price_minor, currency_code, total_sessions, validity_rule_snapshot
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${pkgDefId}', '${ID.checkoutA}', '${ID.checkoutLineA}',
        '面部护理10次卡', 100000, 'SGD', 10, '{}'::jsonb
      ) RETURNING id;
    `);
    const pkgInstId = pkgInstResult.rows[0].id;

    const grantPkgResult = await db.query(`
      INSERT INTO customer_package_ledger (
        shop_id, customer_id, customer_package_id, entry_type, session_delta, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${pkgInstId}', 'purchase_grant', 10, 'idem-pkg-grant-1', 'Initial grant'
      ) RETURNING id;
    `);
    const grantPkgLedgerId = grantPkgResult.rows[0].id;

    const redeemPkgResult = await db.query(`
      INSERT INTO customer_package_ledger (
        shop_id, customer_id, customer_package_id, entry_type, session_delta, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${pkgInstId}', 'redemption', -1, 'idem-pkg-redeem-1', 'Service session 1'
      ) RETURNING id;
    `);
    const redeemPkgLedgerId = redeemPkgResult.rows[0].id;

    // Over-reversal of package session (reversing 2 sessions when only 1 was redeemed)
    await assert.rejects(
      db.query(`
        INSERT INTO customer_package_ledger (
          shop_id, customer_id, customer_package_id, entry_type, session_delta, original_ledger_id, idempotency_key, reason
        ) VALUES (
          '${ID.shopA}', '${ID.customerA}', '${pkgInstId}', 'redemption_reversal', 2, '${redeemPkgLedgerId}', 'idem-pkg-rev-fail', 'Over reverse'
        );
      `),
      error => /cumulative redemption reversal exceeds original redemption sessions/.test(error.message)
    );

    // Over-refund of package sessions (refunding 11 sessions when total is 10)
    await assert.rejects(
      db.query(`
        INSERT INTO customer_package_ledger (
          shop_id, customer_id, customer_package_id, entry_type, session_delta, original_ledger_id, idempotency_key, reason
        ) VALUES (
          '${ID.shopA}', '${ID.customerA}', '${pkgInstId}', 'partial_refund_deduction', -11, '${grantPkgLedgerId}', 'idem-pkg-ref-fail', 'Over refund'
        );
      `),
      error => /cumulative partial refund deduction exceeds purchase grant total sessions/.test(error.message)
    );

    // Check package view
    const pkgView = await db.query(`
      SELECT * FROM v_customer_package_balances WHERE shop_id = '${ID.shopA}' AND customer_id = '${ID.customerA}';
    `);
    assert.equal(pkgView.rows.length, 1);
    assert.equal(pkgView.rows[0].remaining_sessions, 9);
    assert.equal(pkgView.rows[0].usable_sessions, 9);
    assert.equal(pkgView.rows[0].is_exhausted, false);

    // H. Points Lot Deferrable Constraint Trigger & Allocation Restores
    const ptsAccountResult = await db.query(`
      INSERT INTO customer_points_accounts (shop_id, customer_id)
      VALUES ('${ID.shopA}', '${ID.customerA}')
      RETURNING id;
    `);
    const ptsAccountId = ptsAccountResult.rows[0].id;

    const ptsGrantResult = await db.query(`
      INSERT INTO customer_points_ledger (
        shop_id, customer_id, account_id, entry_type, points_delta, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${ptsAccountId}', 'purchase_accrual', 500, 'idem-pts-grant-1', 'Welcome points'
      ) RETURNING id;
    `);
    const ptsGrantId = ptsGrantResult.rows[0].id;

    // Points Lot amount mismatch fails deferred trigger at COMMIT
    await assert.rejects(
      db.query(`
        BEGIN;
        INSERT INTO customer_points_lots (
          shop_id, customer_id, account_id, grant_ledger_id, initial_points
        ) VALUES (
          '${ID.shopA}', '${ID.customerA}', '${ptsAccountId}', '${ptsGrantId}', 499
        );
        COMMIT;
      `),
      error => /does not match grant ledger/.test(error.message)
    );

    const ptsLotResult = await db.query(`
      INSERT INTO customer_points_lots (
        shop_id, customer_id, account_id, grant_ledger_id, initial_points
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${ptsAccountId}', '${ptsGrantId}', 500
      ) RETURNING id;
    `);
    const ptsLotId = ptsLotResult.rows[0].id;

    const ptsSpendResult = await db.query(`
      INSERT INTO customer_points_ledger (
        shop_id, customer_id, account_id, entry_type, points_delta, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${ptsAccountId}', 'service_redemption', -200, 'idem-pts-spend-1', 'Points redeem'
      ) RETURNING id;
    `);
    const ptsSpendId = ptsSpendResult.rows[0].id;

    const ptsConsumeAllocResult = await db.query(`
      INSERT INTO customer_points_allocations (
        shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, allocated_points, idempotency_key
      ) VALUES (
        '${ID.shopA}', '${ptsAccountId}', '${ID.customerA}', '${ptsSpendId}', '${ptsLotId}', 'consume', 200, 'idem-pts-alloc-1'
      ) RETURNING id;
    `);
    const ptsConsumeAllocId = ptsConsumeAllocResult.rows[0].id;

    const ptsRevResult = await db.query(`
      INSERT INTO customer_points_ledger (
        shop_id, customer_id, account_id, entry_type, points_delta, original_ledger_id, idempotency_key, reason
      ) VALUES (
        '${ID.shopA}', '${ID.customerA}', '${ptsAccountId}', 'redemption_reversal', 200, '${ptsSpendId}', 'idem-pts-rev-1', 'Reverse points redeem'
      ) RETURNING id;
    `);
    const ptsRevId = ptsRevResult.rows[0].id;

    // Over-restore points fails
    await assert.rejects(
      db.query(`
        INSERT INTO customer_points_allocations (
          shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, original_allocation_id, allocated_points, idempotency_key
        ) VALUES (
          '${ID.shopA}', '${ptsAccountId}', '${ID.customerA}', '${ptsRevId}', '${ptsLotId}', 'restore', '${ptsConsumeAllocId}', 250, 'idem-pts-alloc-over'
        );
      `),
      error => /cumulative points restore allocation exceeds original consume/.test(error.message)
    );

    // Valid restore points succeeds
    await db.query(`
      INSERT INTO customer_points_allocations (
        shop_id, account_id, customer_id, spend_ledger_id, lot_id, allocation_type, original_allocation_id, allocated_points, idempotency_key
      ) VALUES (
        '${ID.shopA}', '${ptsAccountId}', '${ID.customerA}', '${ptsRevId}', '${ptsLotId}', 'restore', '${ptsConsumeAllocId}', 200, 'idem-pts-alloc-ok'
      );
    `);

    const ptsView = await db.query(`
      SELECT * FROM v_customer_points_balances WHERE shop_id = '${ID.shopA}' AND customer_id = '${ID.customerA}';
    `);
    assert.equal(ptsView.rows.length, 1);
    assert.equal(Number(ptsView.rows[0].ledger_points_balance), 500);
    assert.equal(Number(ptsView.rows[0].usable_points_balance), 500);

    // F. Test views return correct balances
    const svView = await db.query(`
      SELECT * FROM v_customer_stored_value_balances WHERE shop_id = '${ID.shopA}' AND customer_id = '${ID.customerA}';
    `);
    assert.equal(svView.rows.length, 1);
    assert.equal(Number(svView.rows[0].ledger_principal_balance_minor), 10000);
    assert.equal(Number(svView.rows[0].ledger_bonus_balance_minor), 2000);
    assert.equal(Number(svView.rows[0].ledger_total_balance_minor), 12000);
    // Since account is frozen, usable balance is 0
    assert.equal(Number(svView.rows[0].usable_total_balance_minor), 0);
  });
});
