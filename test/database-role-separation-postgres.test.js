'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-111111111111',
  staff: '33333333-3333-4333-8333-111111111111',
  service: '44444444-4444-4444-8444-111111111111',
  customer: '55555555-5555-4555-8555-111111111111',
  appointment: '66666666-6666-4666-8666-111111111111',
  item: '77777777-7777-4777-8777-111111111111',
  owner: '88888888-8888-4888-8888-111111111111',
  checkout: '99999999-9999-4999-8999-111111111111'
};

async function connectWhenReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('PostgreSQL did not start');
}

test('PostgreSQL 17 database role separation foundation (053-055) enforces least-privilege', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-role-pg-'));
  const data = path.join(temp, 'data');
  const port = 58600 + Math.floor(Math.random() * 200);

  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const adminUrl = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;

  let admin;
  let runtimeClient;
  let onboardingClient;

  try {
    admin = await connectWhenReady(adminUrl);

    // 1. Setup exact 35 baseline tables matching 000-052
    await admin.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE shops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'active'
      );
      CREATE TABLE locations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        name text NOT NULL,
        timezone text NOT NULL DEFAULT 'Asia/Singapore',
        is_active boolean NOT NULL DEFAULT TRUE,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE staff (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_code text,
        name text NOT NULL,
        email text,
        phone text,
        is_active boolean NOT NULL DEFAULT TRUE,
        bookable boolean NOT NULL DEFAULT TRUE,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE staff_working_hours (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        day_of_week smallint NOT NULL,
        start_time time NOT NULL,
        end_time time NOT NULL
      );
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        name text NOT NULL,
        phone text,
        email text,
        phone_normalized text,
        member_code text,
        date_of_birth date,
        gender text,
        phone_verified_at timestamptz,
        identity_status text NOT NULL DEFAULT 'unverified_contact',
        UNIQUE (shop_id, id)
      );
      CREATE TABLE services (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        category_id uuid,
        name text NOT NULL,
        duration_minutes integer NOT NULL DEFAULT 60,
        price numeric NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT TRUE,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE staff_services (
        shop_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        service_id uuid NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        PRIMARY KEY (shop_id, staff_id, service_id)
      );
      CREATE TABLE staff_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        login_identifier text NOT NULL,
        password_hash text NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        session_version integer NOT NULL DEFAULT 1,
        UNIQUE (shop_id, staff_id)
      );
      CREATE TABLE staff_location_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        location_id uuid NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        UNIQUE (shop_id, staff_id, location_id)
      );
      CREATE TABLE staff_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        staff_account_id uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        revoked_at timestamptz,
        expires_at timestamptz NOT NULL,
        session_version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE staff_permissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        permission_name text NOT NULL,
        UNIQUE (shop_id, staff_id, permission_name)
      );
      CREATE TABLE staff_location_working_hours (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        location_id uuid NOT NULL,
        day_of_week smallint NOT NULL,
        start_time time NOT NULL,
        end_time time NOT NULL
      );
      CREATE TABLE staff_schedule_overrides (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        staff_id uuid NOT NULL,
        location_id uuid NOT NULL,
        schedule_date date NOT NULL,
        override_type text NOT NULL,
        start_time time,
        end_time time,
        approval_status text NOT NULL DEFAULT 'approved',
        is_active boolean NOT NULL DEFAULT TRUE
      );
      CREATE TABLE appointment_time_change_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        previous_start_at timestamptz NOT NULL,
        previous_end_at timestamptz NOT NULL,
        new_start_at timestamptz NOT NULL,
        new_end_at timestamptz NOT NULL,
        changed_by_staff_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE appointments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL REFERENCES locations(id),
        staff_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        booker_customer_id uuid,
        recipient_customer_id uuid,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        cancelled_at timestamptz,
        service_completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        appointment_id uuid NOT NULL,
        sequence_no integer NOT NULL,
        service_id uuid NOT NULL,
        service_name_snapshot text NOT NULL,
        price_snapshot numeric,
        duration_minutes_snapshot integer NOT NULL DEFAULT 60,
        start_at timestamptz,
        end_at timestamptz,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE appointment_item_staff_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        appointment_item_id uuid NOT NULL,
        location_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'primary',
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        UNIQUE (shop_id, id)
      );
      CREATE TABLE owner_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        login_identifier text NOT NULL,
        login_identifier_normalized text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        display_name text NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        session_version integer NOT NULL DEFAULT 1,
        failed_login_attempts integer NOT NULL DEFAULT 0,
        locked_until timestamptz,
        password_changed_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE owner_shop_memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
        shop_id uuid NOT NULL REFERENCES shops(id),
        role text NOT NULL DEFAULT 'owner',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_account_id, shop_id)
      );
      CREATE TABLE owner_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
        token_hash text NOT NULL UNIQUE,
        revoked_at timestamptz,
        revoke_reason text,
        expires_at timestamptz NOT NULL,
        session_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE service_translations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        service_id uuid NOT NULL,
        locale text NOT NULL,
        name text NOT NULL,
        description text,
        UNIQUE (shop_id, service_id, locale)
      );
      CREATE TABLE service_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        name text NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        display_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE service_category_translations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        category_id uuid NOT NULL,
        locale text NOT NULL,
        name text NOT NULL,
        UNIQUE (shop_id, category_id, locale)
      );
      CREATE TABLE shop_customer_settings (
        shop_id uuid PRIMARY KEY REFERENCES shops(id),
        member_code_prefix text NOT NULL DEFAULT 'MEM-',
        member_code_width smallint NOT NULL DEFAULT 6,
        dob_requirement text NOT NULL DEFAULT 'optional',
        default_phone_country_code text NOT NULL DEFAULT '+65'
      );
      CREATE TABLE shop_member_code_counters (
        shop_id uuid PRIMARY KEY REFERENCES shops(id),
        next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0)
      );
      CREATE TABLE customer_phone_identities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        customer_id uuid NOT NULL,
        phone_normalized text NOT NULL,
        is_primary boolean NOT NULL DEFAULT TRUE,
        verified_at timestamptz,
        ended_at timestamptz,
        UNIQUE (shop_id, customer_id, phone_normalized)
      );
      CREATE TABLE customer_otp_challenges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        customer_id uuid,
        phone_normalized text NOT NULL,
        otp_hash text NOT NULL,
        purpose text NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        failed_attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE customer_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        customer_id uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE customer_identity_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        customer_id uuid NOT NULL,
        event_type text NOT NULL,
        challenge_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE appointment_status_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        appointment_id uuid NOT NULL,
        from_status text,
        to_status text NOT NULL,
        actor_type text NOT NULL,
        actor_id text,
        reason text,
        source text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE checkout_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        appointment_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        currency_code char(3) NOT NULL,
        quote_total_minor bigint NOT NULL,
        actual_total_minor bigint NOT NULL,
        discount_total_minor bigint NOT NULL DEFAULT 0,
        final_due_minor bigint NOT NULL,
        paid_minor bigint NOT NULL DEFAULT 0,
        idempotency_key text NOT NULL,
        created_by_owner_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, appointment_id),
        UNIQUE (shop_id, idempotency_key),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE checkout_line_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        checkout_id uuid NOT NULL REFERENCES checkout_transactions(id),
        appointment_item_id uuid,
        line_type text NOT NULL,
        description_snapshot text NOT NULL,
        quote_price_minor bigint NOT NULL DEFAULT 0,
        actual_price_minor bigint NOT NULL DEFAULT 0,
        discount_minor bigint NOT NULL DEFAULT 0,
        final_value_minor bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE checkout_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        checkout_id uuid NOT NULL REFERENCES checkout_transactions(id),
        payment_method text NOT NULL,
        value_kind text NOT NULL,
        amount_minor bigint NOT NULL,
        cash_collected_minor bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE checkout_staff_attributions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        checkout_id uuid NOT NULL REFERENCES checkout_transactions(id),
        staff_id uuid NOT NULL,
        role text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE checkout_financial_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        checkout_id uuid NOT NULL REFERENCES checkout_transactions(id),
        appointment_id uuid NOT NULL,
        event_type text NOT NULL,
        before_snapshot jsonb,
        after_snapshot jsonb NOT NULL,
        reason text,
        operator_type text NOT NULL,
        operator_id text,
        source text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- Member code trigger function
      CREATE OR REPLACE FUNCTION public.assign_customer_member_code() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE allocated bigint; prefix text; width smallint;
      BEGIN
        IF NEW.member_code IS NOT NULL THEN RETURN NEW; END IF;
        SELECT member_code_prefix, member_code_width INTO prefix, width FROM public.shop_customer_settings WHERE shop_id=NEW.shop_id;
        IF NOT FOUND THEN prefix := 'MEM-'; width := 6; END IF;
        UPDATE public.shop_member_code_counters SET next_value=next_value+1 WHERE shop_id=NEW.shop_id RETURNING next_value-1 INTO allocated;
        IF NOT FOUND THEN
          INSERT INTO public.shop_member_code_counters(shop_id, next_value) VALUES (NEW.shop_id, 2);
          allocated := 1;
        END IF;
        NEW.member_code := prefix || lpad(allocated::text, width, '0');
        RETURN NEW;
      END $$;
      CREATE TRIGGER customers_assign_member_code BEFORE INSERT ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.assign_customer_member_code();
    `);

    // Insert initial merchant test fixtures
    await admin.query(`
      INSERT INTO shops (id, slug, name, status) VALUES ('${ID.shop}', 'gg-beauty', 'GG Beauty', 'active');
      INSERT INTO locations (id, shop_id, name, timezone) VALUES ('${ID.location}', '${ID.shop}', 'Central', 'Asia/Singapore');
      INSERT INTO staff (id, shop_id, staff_code, name) VALUES ('${ID.staff}', '${ID.shop}', 'ST-01', 'Stylist Alice');
      INSERT INTO services (id, shop_id, name, duration_minutes, price) VALUES ('${ID.service}', '${ID.shop}', 'Haircut', 45, 50.00);
      INSERT INTO shop_customer_settings (shop_id, member_code_prefix, member_code_width) VALUES ('${ID.shop}', 'GG-', 6);
      INSERT INTO shop_member_code_counters (shop_id, next_value) VALUES ('${ID.shop}', 1);
    `);

    // 2. Execute 053 Preflight
    await admin.query(migration('053_database_role_preflight_readonly.sql'));

    // 3. Execute 054 ACL Foundation
    await admin.query(migration('054_database_role_acl_foundation.sql'));

    // 4. Execute 055 Verification
    await admin.query(migration('055_database_role_verification_readonly.sql'));

    // 5. Test Admin SET ROLE to gg_migration_owner
    await admin.query('SET ROLE gg_migration_owner;');
    const currentRole = (await admin.query('SELECT current_user;')).rows[0].current_user;
    assert.equal(currentRole, 'gg_migration_owner');
    await admin.query('RESET ROLE;');

    // 6. Test Direct Login as gg_app_runtime (unprivileged connection)
    const runtimeUrl = `postgresql://gg_app_runtime@127.0.0.1:${port}/postgres`;
    runtimeClient = await connectWhenReady(runtimeUrl);

    // Verify runtime user identity
    const runtimeUser = (await runtimeClient.query('SELECT current_user;')).rows[0].current_user;
    assert.equal(runtimeUser, 'gg_app_runtime');

    // (A) Runtime operational queries pass
    const shopsResult = await runtimeClient.query('SELECT id, name FROM shops WHERE id = $1', [ID.shop]);
    assert.equal(shopsResult.rows[0].name, 'GG Beauty');

    // Insert customer -> invokes trigger which updates shop_member_code_counters
    const newCustomer = (await runtimeClient.query(
      `INSERT INTO customers (shop_id, name, phone) VALUES ($1, 'Runtime Customer', '+6591234567') RETURNING id, member_code`,
      [ID.shop]
    )).rows[0];
    assert.equal(newCustomer.member_code, 'GG-000001');

    // Insert appointment and appointment items
    await runtimeClient.query(
      `INSERT INTO appointments (id, shop_id, location_id, staff_id, customer_id, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, '2030-01-01 10:00:00+08', '2030-01-01 11:00:00+08')`,
      [ID.appointment, ID.shop, ID.location, ID.staff, newCustomer.id]
    );

    await runtimeClient.query(
      `INSERT INTO appointment_items (id, shop_id, appointment_id, sequence_no, service_id, service_name_snapshot, price_snapshot)
       VALUES ($1, $2, $3, 1, $4, 'Haircut', 50.00)`,
      [ID.item, ID.shop, ID.appointment, ID.service]
    );

    // Row locking lookup: SELECT ... FOR UPDATE OF location passes
    const lockLocationResult = await runtimeClient.query(
      `SELECT location.id FROM locations AS location WHERE location.id = $1 FOR UPDATE OF location`,
      [ID.location]
    );
    assert.equal(lockLocationResult.rows[0].id, ID.location);

    // Row locking lookup: SELECT ... FOR UPDATE on checkout_transactions passes
    const lockTxResult = await runtimeClient.query(
      `SELECT id FROM checkout_transactions WHERE shop_id = $1 AND idempotency_key = 'test-key' FOR UPDATE`,
      [ID.shop]
    );
    assert.equal(lockTxResult.rows.length, 0);

    // Insert checkout POS records
    await runtimeClient.query(
      `INSERT INTO checkout_transactions (id, shop_id, appointment_id, customer_id, currency_code, quote_total_minor, actual_total_minor, final_due_minor, idempotency_key)
       VALUES ($1, $2, $3, $4, 'SGD', 5000, 5000, 5000, 'test-key')`,
      [ID.checkout, ID.shop, ID.appointment, newCustomer.id]
    );

    await runtimeClient.query(
      `INSERT INTO checkout_line_items (shop_id, checkout_id, appointment_item_id, line_type, description_snapshot, quote_price_minor, actual_price_minor, final_value_minor)
       VALUES ($1, $2, $3, 'service', 'Haircut', 5000, 5000, 5000)`,
      [ID.shop, ID.checkout, ID.item]
    );

    await runtimeClient.query(
      `INSERT INTO checkout_financial_audit (shop_id, checkout_id, appointment_id, event_type, after_snapshot, source, operator_type)
       VALUES ($1, $2, $3, 'checkout_created', '{"total": 5000}', 'test', 'owner')`,
      [ID.shop, ID.checkout, ID.appointment]
    );

    // (B) Negative security checks for gg_app_runtime
    // 1. DDL rejected
    await assert.rejects(
      runtimeClient.query('CREATE TABLE unauthorized_table (id int)'),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('DROP TABLE shops'),
      err => err.code === '42501'
    );

    // 2. TRUNCATE rejected
    await assert.rejects(
      runtimeClient.query('TRUNCATE appointments'),
      err => err.code === '42501'
    );

    // 3. DELETE rejected
    await assert.rejects(
      runtimeClient.query('DELETE FROM appointments WHERE id = $1', [ID.appointment]),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('DELETE FROM customers WHERE id = $1', [newCustomer.id]),
      err => err.code === '42501'
    );

    // 4. Mutation on locked lookup tables rejected by trigger
    await assert.rejects(
      runtimeClient.query('UPDATE locations SET name = \'Hacked Location\' WHERE id = $1', [ID.location]),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('UPDATE checkout_transactions SET status = \'void\' WHERE id = $1', [ID.checkout]),
      err => err.code === '42501'
    );

    // 5. TEMP table creation rejected
    await assert.rejects(
      runtimeClient.query('CREATE TEMP TABLE evil_temp (x int)'),
      err => err.code === '42501'
    );

    // 6. Privilege escalation / SET ROLE rejected
    await assert.rejects(
      runtimeClient.query('SET ROLE guoguanguan'),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('SET ROLE gg_migration_owner'),
      err => err.code === '42501'
    );

    // 7. Owner bootstrapping creation rejected for runtime
    await assert.rejects(
      runtimeClient.query(
        `INSERT INTO owner_accounts (login_identifier, login_identifier_normalized, password_hash, display_name)
         VALUES ('admin', 'admin', 'hash', 'Admin')`
      ),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query(
        `INSERT INTO owner_shop_memberships (owner_account_id, shop_id, role)
         VALUES ('${ID.owner}', '${ID.shop}', 'owner')`
      ),
      err => err.code === '42501'
    );

    // 7. Test Direct Login as gg_app_onboarding (CLI bootstrap-owner.js role)
    const onboardingUrl = `postgresql://gg_app_onboarding@127.0.0.1:${port}/postgres`;
    onboardingClient = await connectWhenReady(onboardingUrl);

    // (A) Onboarding operations pass
    // Plain SELECT on shops passes
    const shopSelectResult = await onboardingClient.query(
      `SELECT id FROM shops WHERE slug = $1 AND status = 'active'`,
      ['gg-beauty']
    );
    assert.equal(shopSelectResult.rows[0].id, ID.shop);

    // In PostgreSQL, FOR SHARE requires ACL_UPDATE; under pure SELECT it fails closed with 42501
    await assert.rejects(
      onboardingClient.query(
        `SELECT id FROM shops WHERE slug = $1 AND status = 'active' FOR SHARE`,
        ['gg-beauty']
      ),
      err => err.code === '42501'
    );

    // Insertion into owner_accounts and memberships passes
    const createdOwner = (await onboardingClient.query(
      `INSERT INTO owner_accounts (login_identifier, login_identifier_normalized, password_hash, display_name)
       VALUES ('owner@gg.com', 'owner@gg.com', 'test-hash', 'Salon Owner')
       RETURNING id`
    )).rows[0];

    await onboardingClient.query(
      `INSERT INTO owner_shop_memberships (owner_account_id, shop_id, role)
       VALUES ($1, $2, 'owner')`,
      [createdOwner.id, ID.shop]
    );

    // (B) Negative security checks for gg_app_onboarding
    await assert.rejects(
      onboardingClient.query('UPDATE shops SET name = \'Hacked\' WHERE id = $1', [ID.shop]),
      err => err.code === '42501'
    );
    await assert.rejects(
      onboardingClient.query('SELECT id FROM appointments LIMIT 1'),
      err => err.code === '42501'
    );
    await assert.rejects(
      onboardingClient.query('SELECT id FROM customers LIMIT 1'),
      err => err.code === '42501'
    );
    await assert.rejects(
      onboardingClient.query('SET ROLE guoguanguan'),
      err => err.code === '42501'
    );
    await assert.rejects(
      onboardingClient.query('SET ROLE gg_migration_owner'),
      err => err.code === '42501'
    );

  } finally {
    if (runtimeClient) await runtimeClient.end().catch(() => {});
    if (onboardingClient) await onboardingClient.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    postgres.kill('SIGTERM');
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // transient Windows/mac file handle delay
    }
  }
});
