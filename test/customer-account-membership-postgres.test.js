'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const { createCustomerAccountService } = require('../lib/customer-account-service');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || (fs.existsSync('/opt/homebrew/bin/initdb') ? '/opt/homebrew/bin' : '/opt/homebrew/opt/postgresql@17/bin');
const readSql = filename => fs.readFileSync(path.join(ROOT, 'migrations', filename), 'utf8');

const waitForPostgres = async (connectionString, pgProcess, getStderr) => {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pgProcess.exitCode !== null || pgProcess.signalCode !== null) {
      throw new Error(`PostgreSQL process exited unexpectedly: ${getStderr()}`);
    }
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
};

test('Customer Account & Membership Foundation (PostgreSQL 17)', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    return t.skip('PostgreSQL 17 unavailable');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-cust-acct-'));
  const dataDir = path.join(tempDir, 'data');
  const socketDir = path.join(tempDir, 'socket');
  fs.mkdirSync(socketDir);
  const port = 58800 + Math.floor(Math.random() * 200);

  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', dataDir, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  let stderr = '';
  const pgProcess = spawn(path.join(PG_BIN, 'postgres'), ['-D', dataDir, '-k', socketDir, '-p', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  pgProcess.stderr.on('data', chunk => { stderr += chunk; });
  const processExitPromise = new Promise(resolve => pgProcess.once('exit', resolve));

  const connectionString = `postgresql://${os.userInfo().username}@localhost:${port}/postgres?host=${encodeURIComponent(socketDir)}`;
  let db;

  try {
    db = await waitForPostgres(connectionString, pgProcess, () => stderr);

    // 1. Setup prerequisite baseline tables & triggers (simulating migrations 001 - 080)
    await db.query(`
      CREATE TABLE public.shops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'active'
      );

      CREATE TABLE public.customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        name text,
        phone text,
        phone_normalized text,
        phone_verified_at timestamptz,
        identity_status text NOT NULL DEFAULT 'unverified_contact',
        member_code text,
        email text,
        date_of_birth date,
        gender text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customers_shop_id_id_key UNIQUE (shop_id, id),
        CONSTRAINT customers_shop_id_phone_normalized_key UNIQUE (shop_id, phone_normalized),
        CONSTRAINT customers_identity_status_check CHECK (identity_status IN ('unverified_contact', 'verified_member')),
        CONSTRAINT customers_gender_check CHECK (gender IS NULL OR gender IN ('female', 'male', 'non_binary', 'prefer_not_to_say'))
      );

      CREATE TABLE public.shop_customer_settings (
        shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
        member_code_prefix text NOT NULL DEFAULT 'MEM-',
        member_code_width smallint NOT NULL DEFAULT 6,
        dob_requirement text NOT NULL DEFAULT 'optional',
        default_phone_country_code text NOT NULL DEFAULT '+65',
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT shop_customer_settings_prefix_check CHECK (member_code_prefix ~ '^[A-Z0-9][A-Z0-9-]{0,11}$'),
        CONSTRAINT shop_customer_settings_width_check CHECK (member_code_width BETWEEN 4 AND 12),
        CONSTRAINT shop_customer_settings_dob_check CHECK (dob_requirement IN ('optional', 'required')),
        CONSTRAINT shop_customer_settings_country_check CHECK (default_phone_country_code ~ '^\\+[1-9][0-9]{0,3}$')
      );

      CREATE TABLE public.shop_member_code_counters (
        shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
        next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0)
      );

      CREATE TABLE public.customer_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (shop_id, customer_id) REFERENCES public.customers(shop_id, id) ON DELETE RESTRICT
      );

      CREATE OR REPLACE FUNCTION public.provision_shop_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.shop_customer_settings(shop_id) VALUES(NEW.id) ON CONFLICT (shop_id) DO NOTHING;
        INSERT INTO public.shop_member_code_counters(shop_id,next_value) VALUES(NEW.id,1) ON CONFLICT (shop_id) DO NOTHING;
        RETURN NEW;
      END $$;
      CREATE TRIGGER shops_provision_customer_identity AFTER INSERT ON public.shops
      FOR EACH ROW EXECUTE FUNCTION public.provision_shop_customer_identity();

      CREATE OR REPLACE FUNCTION public.assign_customer_member_code() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE allocated bigint; prefix text; width smallint;
      BEGIN
        IF NEW.member_code IS NOT NULL THEN
          RAISE EXCEPTION 'member_code is server allocated' USING ERRCODE='23514';
        END IF;
        SELECT member_code_prefix,member_code_width INTO prefix,width FROM public.shop_customer_settings WHERE shop_id=NEW.shop_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'shop member settings missing' USING ERRCODE='23503'; END IF;
        UPDATE public.shop_member_code_counters SET next_value=next_value+1 WHERE shop_id=NEW.shop_id RETURNING next_value-1 INTO allocated;
        IF NOT FOUND THEN RAISE EXCEPTION 'shop member counter missing' USING ERRCODE='23503'; END IF;
        NEW.member_code:=prefix||lpad(allocated::text,width,'0'); RETURN NEW;
      END $$;
      CREATE TRIGGER customers_assign_member_code BEFORE INSERT ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.assign_customer_member_code();
    `);

    // Insert two test shops
    const shopAId = '11111111-1111-4111-8111-111111111111';
    const shopBId = '22222222-2222-4222-8222-222222222222';
    await db.query(`INSERT INTO public.shops (id, slug, name) VALUES ($1, 'shop-a', 'Shop A'), ($2, 'shop-b', 'Shop B')`, [shopAId, shopBId]);

    // 2. Preflight 081 must succeed on valid prerequisite state
    await db.query(readSql('081_customer_account_membership_preflight_readonly.sql'));

    // 3. Schema migration 082
    await db.query(readSql('082_customer_account_membership_schema.sql'));

    // Verify ordinary tier seeded for existing shops A and B
    const tiersRes = await db.query(`SELECT shop_id, tier_code, name, is_default, is_active FROM public.membership_tiers ORDER BY shop_id`);
    assert.equal(tiersRes.rows.length, 2);
    assert.equal(tiersRes.rows[0].tier_code, 'ordinary');
    assert.equal(tiersRes.rows[0].name, '普通会员');
    assert.equal(tiersRes.rows[0].is_default, true);
    assert.equal(tiersRes.rows[1].tier_code, 'ordinary');

    // Verify trigger for future shop provisioning
    const shopCId = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO public.shops (id, slug, name) VALUES ($1, 'shop-c', 'Shop C')`, [shopCId]);
    const shopCTier = await db.query(`SELECT tier_code, name, is_default FROM public.membership_tiers WHERE shop_id = $1`, [shopCId]);
    assert.equal(shopCTier.rows.length, 1);
    assert.equal(shopCTier.rows[0].tier_code, 'ordinary');

    // 4. Verification 083 must succeed
    await db.query(readSql('083_customer_account_membership_verification_readonly.sql'));

    // 5. Test CustomerAccountService business logic against real PostgreSQL
    const service = createCustomerAccountService({ pool: db });

    // Shop settings initial values: default membership_enabled is FALSE
    const settingsA = await service.getShopSettings(shopAId);
    assert.equal(settingsA.membership_enabled, false);
    assert.equal(settingsA.points_enabled, false);
    assert.equal(settingsA.stored_value_enabled, false);
    assert.equal(settingsA.packages_enabled, false);
    assert.equal(settingsA.auto_free_membership, true);

    // Newly provisioned shop C after migration 082 also defaults to false
    const settingsC = await service.getShopSettings(shopCId);
    assert.equal(settingsC.membership_enabled, false);

    // Reject / ignore enabling unsupported modules at service layer
    await service.updateShopSettings(shopAId, { points_enabled: true, stored_value_enabled: true, packages_enabled: true });
    const settingsAAfterModules = await service.getShopSettings(shopAId);
    assert.equal(settingsAAfterModules.points_enabled, false);
    assert.equal(settingsAAfterModules.stored_value_enabled, false);
    assert.equal(settingsAAfterModules.packages_enabled, false);

    // Register customer in Shop A without OTP while membership_enabled = false
    const regResult = await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '91234567',
      name: 'Alice Tan',
      email: 'alice@example.com',
      dateOfBirth: '1995-05-15',
      gender: 'female'
    });
    assert.ok(regResult.customerId);

    // Check customer row in DB: phone_verified_at must be NULL, identity_status 'unverified_contact'
    const custRow = (await db.query(`SELECT * FROM public.customers WHERE id = $1`, [regResult.customerId])).rows[0];
    assert.equal(custRow.phone_normalized, '+6591234567');
    assert.equal(custRow.phone_verified_at, null);
    assert.equal(custRow.identity_status, 'unverified_contact');
    assert.equal(custRow.email, 'alice@example.com');
    assert.ok(custRow.member_code.startsWith('MEM-'));

    // Check account row: active
    const acctRow = (await db.query(`SELECT * FROM public.customer_accounts WHERE customer_id = $1`, [regResult.customerId])).rows[0];
    assert.equal(acctRow.status, 'active');
    assert.equal(acctRow.phone_normalized, '+6591234567');
    assert.equal(acctRow.created_by_role, 'customer');

    // Check membership: NOT created because membership_enabled is false
    const initialMemCount = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(initialMemCount, '0');

    // Check summary with unverified phone privacy data minimization
    const summaryUnverified = await service.getCustomerSummary({ shopId: shopAId, customerId: regResult.customerId });
    assert.equal(summaryUnverified.isPhoneVerified, false);
    assert.equal(summaryUnverified.account.status, 'active');
    assert.equal(summaryUnverified.membership, null);
    assert.equal(summaryUnverified.modules.membership, false);
    assert.equal(summaryUnverified.modules.points, false);
    assert.equal(summaryUnverified.modules.storedValue, false);
    assert.equal(summaryUnverified.modules.packages, false);
    // Data minimization asserts:
    assert.equal(summaryUnverified.phone, null);
    assert.equal(summaryUnverified.email, null);
    assert.equal(summaryUnverified.dateOfBirth, null);
    assert.equal(summaryUnverified.gender, null);
    assert.equal(summaryUnverified.phoneNormalized, '+6591234567');

    // Repeated signInWithPhone idempotency test (while membership is OFF)
    const regRepeat = await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '91234567',
      name: 'Alice Tan Updated'
    });
    assert.equal(regRepeat.customerId, regResult.customerId);
    const custCountAfterRepeat = (await db.query(`SELECT count(*) FROM public.customers WHERE shop_id = $1 AND phone_normalized = '+6591234567'`, [shopAId])).rows[0].count;
    assert.equal(custCountAfterRepeat, '1');
    const acctCountAfterRepeat = (await db.query(`SELECT count(*) FROM public.customer_accounts WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(acctCountAfterRepeat, '1');
    const memCountAfterRepeat = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(memCountAfterRepeat, '0');

    // Cross-shop tier FK rejection at database level:
    // Attempting to insert a membership for Shop A customer with a tier belonging to Shop B
    const shopBTier = (await db.query(`SELECT id FROM public.membership_tiers WHERE shop_id = $1`, [shopBId])).rows[0];
    await assert.rejects(
      db.query(`
        INSERT INTO public.customer_memberships (shop_id, customer_id, tier_id, activated_by)
        VALUES ($1, $2, $3, 'manual_grant')
      `, [shopAId, regResult.customerId, shopBTier.id]),
      err => {
        assert.equal(err.code, '23503'); // foreign key violation
        return true;
      }
    );
    await db.query('ROLLBACK').catch(() => {});

    // Merchant enables membership module:
    await service.updateShopSettings(shopAId, { membership_enabled: true });
    const settingsAEnabled = await service.getShopSettings(shopAId);
    assert.equal(settingsAEnabled.membership_enabled, true);

    // Customer signs in again now that membership is enabled -> auto-provisions ordinary membership
    const regWithMem = await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '91234567',
      name: 'Alice Tan'
    });
    assert.equal(regWithMem.customerId, regResult.customerId);

    // Membership: auto-activated without owner approval
    const memRow = (await db.query(`SELECT * FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0];
    assert.equal(memRow.status, 'active');
    assert.equal(memRow.activated_by, 'auto_free');
    assert.equal(memRow.expires_at, null); // permanent

    // Check summary with active membership
    const summaryWithMem = await service.getCustomerSummary({ shopId: shopAId, customerId: regResult.customerId });
    assert.equal(summaryWithMem.account.status, 'active');
    assert.equal(summaryWithMem.membership.isActive, true);
    assert.equal(summaryWithMem.membership.tierCode, 'ordinary');
    assert.equal(summaryWithMem.membership.tierName, '普通会员');
    assert.equal(summaryWithMem.modules.membership, true);

    // Repeated signInWithPhone idempotency when membership is ON (no duplicate memberships)
    await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '91234567',
      name: 'Alice Tan'
    });
    const memCountWhenOn = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(memCountWhenOn, '1');

    // 6. Multi-tenant isolation test
    // Customer registered in Shop A cannot fetch summary in Shop B
    const crossSummary = await service.getCustomerSummary({ shopId: shopBId, customerId: regResult.customerId });
    assert.equal(crossSummary, null);

    // Settings update in Shop A does not leak to Shop B
    await service.updateShopSettings(shopAId, { membership_enabled: true });
    await service.updateShopSettings(shopBId, { membership_enabled: false });
    const settingsAUpdated = await service.getShopSettings(shopAId);
    assert.equal(settingsAUpdated.membership_enabled, true);

    const settingsB = await service.getShopSettings(shopBId);
    assert.equal(settingsB.membership_enabled, false);

    // 7. Off != Delete test: disabling membership module hides it in summary but preserves database row
    await service.updateShopSettings(shopAId, { membership_enabled: false });
    const summaryDisabled = await service.getCustomerSummary({ shopId: shopAId, customerId: regResult.customerId });
    assert.equal(summaryDisabled.modules.membership, false);
    assert.ok(summaryDisabled.membership); // historical record retained
    assert.equal(summaryDisabled.membership.tierCode, 'ordinary');

    const dbMembershipCount = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(dbMembershipCount, '1'); // Row preserved in database!

    // Re-enabling reuses existing membership without duplicate
    await service.updateShopSettings(shopAId, { membership_enabled: true });
    await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '91234567'
    });
    const dbMembershipCountReenabled = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regResult.customerId])).rows[0].count;
    assert.equal(dbMembershipCountReenabled, '1'); // No duplicate created!
    const summaryReenabled = await service.getCustomerSummary({ shopId: shopAId, customerId: regResult.customerId });
    assert.equal(summaryReenabled.modules.membership, true);
    assert.equal(summaryReenabled.membership.isActive, true);

    // 8. Registering when membership module is disabled creates account WITHOUT membership
    await service.updateShopSettings(shopBId, { membership_enabled: false });
    const regBob = await service.signInWithPhone({
      shopSlug: 'shop-b',
      countryCode: '+65',
      phone: '98887777',
      name: 'Bob Tan'
    });
    assert.ok(regBob.customerId);
    const bobAcct = (await db.query(`SELECT * FROM public.customer_accounts WHERE customer_id = $1`, [regBob.customerId])).rows[0];
    assert.equal(bobAcct.status, 'active');
    const bobMemCount = (await db.query(`SELECT count(*) FROM public.customer_memberships WHERE customer_id = $1`, [regBob.customerId])).rows[0].count;
    assert.equal(bobMemCount, '0'); // No membership created!
    const bobSummary = await service.getCustomerSummary({ shopId: shopBId, customerId: regBob.customerId });
    assert.equal(bobSummary.membership, null);
    assert.equal(bobSummary.modules.membership, false);

    // 9. Existing customer without account gets account linked and member_code preserved
    await db.query(`
      INSERT INTO public.customers (shop_id, name, phone, phone_normalized, identity_status)
      VALUES ($1, 'Carol Direct', '+6593334444', '+6593334444', 'unverified_contact')
    `, [shopAId]);
    const carolCust = (await db.query(`SELECT id, member_code FROM public.customers WHERE shop_id = $1 AND phone_normalized = '+6593334444'`, [shopAId])).rows[0];
    assert.ok(carolCust.member_code);

    const carolReg = await service.signInWithPhone({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '93334444',
      name: 'Carol Updated'
    });
    assert.equal(carolReg.customerId, carolCust.id);
    const carolAfter = (await db.query(`SELECT id, name, member_code FROM public.customers WHERE id = $1`, [carolCust.id])).rows[0];
    assert.equal(carolAfter.name, 'Carol Updated');
    assert.equal(carolAfter.member_code, carolCust.member_code); // preserved!
    const carolAcct = (await db.query(`SELECT * FROM public.customer_accounts WHERE customer_id = $1`, [carolCust.id])).rows[0];
    assert.equal(carolAcct.status, 'active');

    // 10. Phone verified status reflects accurately
    await db.query(`UPDATE public.customers SET phone_verified_at = now(), identity_status = 'verified_member' WHERE id = $1`, [carolCust.id]);
    const carolSummary = await service.getCustomerSummary({ shopId: shopAId, customerId: carolCust.id });
    assert.equal(carolSummary.isPhoneVerified, true);

    // 11. Rollback safety test:
    // When real customer accounts or memberships exist, rollback 082 MUST be blocked
    const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations/rollback/082_customer_account_membership_rollback.sql'), 'utf8');
    await assert.rejects(
      db.query(rollbackSql),
      /Customer account\/membership rollback blocked: real customer accounts or memberships exist/
    );
    await db.query('ROLLBACK');

    // Clean up all customer data
    await db.query(`DELETE FROM public.customer_memberships`);
    await db.query(`DELETE FROM public.customer_accounts`);
    await db.query(`DELETE FROM public.customer_sessions`);
    await db.query(`DELETE FROM public.customers`);

    // Test rollback blocked if custom tier exists
    await db.query(`
      INSERT INTO public.membership_tiers (shop_id, tier_code, name, price_minor, validity_type)
      VALUES ($1, 'vip_gold', '金卡会员', 10000, '12_months')
    `, [shopAId]);
    await assert.rejects(
      db.query(rollbackSql),
      /Customer account\/membership rollback blocked: merchant-customized membership tiers exist/
    );
    await db.query('ROLLBACK');
    await db.query(`DELETE FROM public.membership_tiers WHERE tier_code = 'vip_gold'`);

    // Now rollback must succeed cleanly
    await db.query(rollbackSql);

    // Verify tables are dropped
    const regCheck = await db.query(`
      SELECT to_regclass('public.customer_memberships') as m,
             to_regclass('public.customer_accounts') as a,
             to_regclass('public.membership_tiers') as t
    `);
    assert.equal(regCheck.rows[0].m, null);
    assert.equal(regCheck.rows[0].a, null);
    assert.equal(regCheck.rows[0].t, null);

    // Preflight 081 can run cleanly again
    await db.query(readSql('081_customer_account_membership_preflight_readonly.sql'));

  } finally {
    if (db) await db.end().catch(() => {});
    if (pgProcess.exitCode === null && pgProcess.signalCode === null) {
      pgProcess.kill('SIGTERM');
    }
    await processExitPromise;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
