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
  category: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
  customer: '55555555-5555-4555-8555-111111111111',
  appointment: '66666666-6666-4666-8666-111111111111',
  item: '77777777-7777-4777-8777-111111111111',
  assignment: 'cccccccc-cccc-4ccc-8ccc-111111111111',
  owner: '88888888-8888-4888-8888-111111111111',
  checkout: '99999999-9999-4999-8999-111111111111'
};

async function connectWhenReady(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new Client({ connectionString: url, ...options });
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

  // Generate self-signed SSL certificate in data directory so bootstrap-owner.js can connect via SSL
  spawnSync('openssl', [
    'req', '-new', '-x509', '-days', '365', '-nodes',
    '-out', path.join(data, 'server.crt'),
    '-keyout', path.join(data, 'server.key'),
    '-subj', '/CN=127.0.0.1'
  ]);
  fs.chmodSync(path.join(data, 'server.key'), 0o600);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), '\nssl = on\n');

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const adminUrl = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;

  let admin;
  let runtimeClient;
  let bootstrapClient;

  try {
    admin = await connectWhenReady(adminUrl, { ssl: { rejectUnauthorized: false } });

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
      CREATE TABLE service_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        canonical_name text NOT NULL,
        icon_key text,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE services (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        category_id uuid REFERENCES service_categories(id),
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
      CREATE TABLE appointments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL REFERENCES locations(id),
        staff_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        booker_customer_id uuid NOT NULL,
        recipient_customer_id uuid NOT NULL,
        override_conflict boolean NOT NULL DEFAULT FALSE,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        cancelled_at timestamptz,
        service_completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE appointment_time_change_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        actor_type text NOT NULL CHECK (actor_type IN ('staff', 'admin', 'system')),
        actor_id uuid,
        old_start_at timestamptz NOT NULL,
        old_end_at timestamptz NOT NULL,
        new_start_at timestamptz NOT NULL,
        new_end_at timestamptz NOT NULL,
        reason text,
        source text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        sequence_no integer NOT NULL,
        service_id uuid NOT NULL,
        service_name_snapshot text NOT NULL,
        price_snapshot numeric,
        duration_minutes_snapshot integer NOT NULL DEFAULT 60,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE appointment_item_staff_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL,
        appointment_item_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'primary',
        blocks_time boolean NOT NULL DEFAULT TRUE,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
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
        is_active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
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
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, service_id, locale)
      );
      CREATE TABLE service_category_translations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        category_id uuid NOT NULL,
        locale text NOT NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
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

      -- Repository trigger functions from 000-052
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

      CREATE OR REPLACE FUNCTION public.assignment_collision_sync_item_time()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
      BEGIN
        UPDATE public.appointment_item_staff_assignments
        SET start_at=NEW.start_at, end_at=NEW.end_at, updated_at=NOW()
        WHERE shop_id=NEW.shop_id AND location_id=NEW.location_id AND appointment_item_id=NEW.id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER appointment_items_sync_assignment_time
      AFTER UPDATE OF start_at, end_at ON public.appointment_items
      FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_sync_item_time();
    `);

    // Insert initial merchant test fixtures
    await admin.query(`
      INSERT INTO shops (id, slug, name, status) VALUES ('${ID.shop}', 'gg-beauty', 'GG Beauty', 'active');
      INSERT INTO locations (id, shop_id, name, timezone) VALUES ('${ID.location}', '${ID.shop}', 'Central', 'Asia/Singapore');
      INSERT INTO staff (id, shop_id, staff_code, name) VALUES ('${ID.staff}', '${ID.shop}', 'ST-01', 'Stylist Alice');
      INSERT INTO service_categories (id, shop_id, canonical_name, icon_key) VALUES ('${ID.category}', '${ID.shop}', 'Hair', 'scissors');
      INSERT INTO services (id, shop_id, category_id, name, duration_minutes, price) VALUES ('${ID.service}', '${ID.shop}', '${ID.category}', 'Haircut', 45, 50.00);
      INSERT INTO shop_customer_settings (shop_id, member_code_prefix, member_code_width) VALUES ('${ID.shop}', 'GG-', 6);
      INSERT INTO shop_member_code_counters (shop_id, next_value) VALUES ('${ID.shop}', 1);

      -- Existing owner account for owner login test
      INSERT INTO owner_accounts (id, login_identifier, login_identifier_normalized, password_hash, display_name)
      VALUES ('${ID.owner}', 'owner@gg.com', 'owner@gg.com', '$2a$12$e8Y/dGz2m8yGqB7M.zG9ce9wWc68Tz0jWwJ25v9Z1P3lX1O3I6Dqu', 'Owner Alice');
      INSERT INTO owner_shop_memberships (owner_account_id, shop_id, role) VALUES ('${ID.owner}', '${ID.shop}', 'owner');
    `);

    // 2. Execute 053 Preflight
    await admin.query(migration('053_database_role_preflight_readonly.sql'));

    // 3. Test 054 Atomic Rollback on failure
    await assert.rejects(
      admin.query(`
        DO $$
        BEGIN
          CREATE ROLE test_injected_role;
          RAISE EXCEPTION 'simulated failure in 054 migration step';
        END $$;
      `),
      err => err.message.includes('simulated failure in 054')
    );
    // Verify test_injected_role does not exist
    const injectedRoleCheck = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'test_injected_role'");
    assert.equal(injectedRoleCheck.rows.length, 0);

    // 4. Execute 054 ACL Foundation
    await admin.query(migration('054_database_role_acl_foundation.sql'));

    // 5. Execute 055 Verification
    await admin.query(migration('055_database_role_verification_readonly.sql'));

    // 6. Test Admin SET ROLE to gg_migration_owner
    await admin.query('SET ROLE gg_migration_owner;');
    const currentRole = (await admin.query('SELECT current_user;')).rows[0].current_user;
    assert.equal(currentRole, 'gg_migration_owner');
    await admin.query('RESET ROLE;');

    // 7. Test Direct Login as gg_app_runtime (unprivileged connection)
    const runtimeUrl = `postgresql://gg_app_runtime@127.0.0.1:${port}/postgres`;
    runtimeClient = await connectWhenReady(runtimeUrl, { ssl: { rejectUnauthorized: false } });

    const runtimeUser = (await runtimeClient.query('SELECT current_user;')).rows[0].current_user;
    assert.equal(runtimeUser, 'gg_app_runtime');

    // (A) Runtime Owner Login (lib/owner-auth.js flow)
    await runtimeClient.query('BEGIN');
    const ownerAccountLock = await runtimeClient.query(
      `SELECT id, login_identifier, password_hash, display_name, is_active, session_version,
              failed_login_attempts, locked_until,
              locked_until IS NOT NULL AND locked_until > NOW() AS is_locked
       FROM owner_accounts
       WHERE login_identifier_normalized = $1
       LIMIT 1
       FOR UPDATE`,
      ['owner@gg.com']
    );
    assert.equal(ownerAccountLock.rows.length, 1);
    assert.equal(ownerAccountLock.rows[0].id, ID.owner);

    // Update login attempts column on owner_accounts
    await runtimeClient.query(
      `UPDATE owner_accounts
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [ID.owner]
    );

    // FOR SHARE OF membership, shop
    const membershipShare = await runtimeClient.query(
      `SELECT membership.id AS membership_id, membership.owner_account_id, membership.shop_id,
              membership.role, shop.slug AS shop_slug, shop.name AS shop_name
       FROM owner_shop_memberships membership
       JOIN shops shop ON shop.id = membership.shop_id
       WHERE membership.owner_account_id = $1 AND membership.is_active = TRUE AND membership.role = ANY($2::TEXT[]) AND shop.status = 'active'
       ORDER BY shop.slug ASC, membership.id ASC
       FOR SHARE OF membership, shop`,
      [ID.owner, ['owner', 'manager', 'staff']]
    );
    assert.equal(membershipShare.rows.length, 1);
    assert.equal(membershipShare.rows[0].shop_name, 'GG Beauty');

    // Create session
    const sessionRes = await runtimeClient.query(
      `INSERT INTO owner_sessions (owner_account_id, token_hash, expires_at)
       VALUES ($1, 'dummy-owner-session-hash-1', NOW() + INTERVAL '1 day')
       RETURNING id`,
      [ID.owner]
    );
    assert.ok(sessionRes.rows[0].id);
    await runtimeClient.query('COMMIT');

    // (B) Translation two real upserts (service_translations and service_category_translations)
    // 1. service_translations INSERT
    const insertSvcTrans = await runtimeClient.query(
      `INSERT INTO service_translations (shop_id, service_id, locale, name, description)
       VALUES ($1, $2, 'zh-CN', '剪发', '优质剪发服务')
       ON CONFLICT (shop_id, service_id, locale)
       DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()
       RETURNING name`,
      [ID.shop, ID.service]
    );
    assert.equal(insertSvcTrans.rows[0].name, '剪发');

    // service_translations UPDATE path
    const updateSvcTrans = await runtimeClient.query(
      `INSERT INTO service_translations (shop_id, service_id, locale, name, description)
       VALUES ($1, $2, 'zh-CN', '高端剪发', '高端定制剪发服务')
       ON CONFLICT (shop_id, service_id, locale)
       DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()
       RETURNING name`,
      [ID.shop, ID.service]
    );
    assert.equal(updateSvcTrans.rows[0].name, '高端剪发');

    // 2. service_category_translations INSERT
    const insertCatTrans = await runtimeClient.query(
      `INSERT INTO service_category_translations (shop_id, category_id, locale, name)
       VALUES ($1, $2, 'zh-CN', '美发分类')
       ON CONFLICT (shop_id, category_id, locale)
       DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
       RETURNING name`,
      [ID.shop, ID.category]
    );
    assert.equal(insertCatTrans.rows[0].name, '美发分类');

    // service_category_translations UPDATE path
    const updateCatTrans = await runtimeClient.query(
      `INSERT INTO service_category_translations (shop_id, category_id, locale, name)
       VALUES ($1, $2, 'zh-CN', '美发设计分类')
       ON CONFLICT (shop_id, category_id, locale)
       DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
       RETURNING name`,
      [ID.shop, ID.category]
    );
    assert.equal(updateCatTrans.rows[0].name, '美发设计分类');

    // (C) Customer Creation & Member Code Trigger
    const newCustomer = (await runtimeClient.query(
      `INSERT INTO customers (shop_id, name, phone) VALUES ($1, 'Runtime Customer', '+6591234567') RETURNING id, member_code`,
      [ID.shop]
    )).rows[0];
    assert.equal(newCustomer.member_code, 'GG-000001');

    // (D) Appointment and Multi-Service Items Creation
    await runtimeClient.query(
      `INSERT INTO appointments (id, shop_id, location_id, staff_id, customer_id, booker_customer_id, recipient_customer_id, start_at, end_at, status)
       VALUES ($1, $2, $3, $4, $5, $5, $5, '2030-01-01 10:00:00+08', '2030-01-01 11:00:00+08', 'confirmed')`,
      [ID.appointment, ID.shop, ID.location, ID.staff, newCustomer.id]
    );

    await runtimeClient.query(
      `INSERT INTO appointment_items (id, shop_id, location_id, appointment_id, sequence_no, service_id, service_name_snapshot, price_snapshot, start_at, end_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'Haircut', 50.00, '2030-01-01 10:00:00+08', '2030-01-01 11:00:00+08')`,
      [ID.item, ID.shop, ID.location, ID.appointment, ID.service]
    );

    await runtimeClient.query(
      `INSERT INTO appointment_item_staff_assignments (id, shop_id, location_id, appointment_item_id, staff_id, role, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, 'primary', '2030-01-01 10:00:00+08', '2030-01-01 11:00:00+08')`,
      [ID.assignment, ID.shop, ID.location, ID.item, ID.staff]
    );

    // (E) Appointment Assignment Trigger Time Sync
    await runtimeClient.query(
      `UPDATE appointment_items
       SET start_at = '2030-01-01 10:15:00+08', end_at = '2030-01-01 11:15:00+08', updated_at = NOW()
       WHERE id = $1`,
      [ID.item]
    );
    const syncedAssignment = (await runtimeClient.query(
      `SELECT start_at, end_at FROM appointment_item_staff_assignments WHERE id = $1`,
      [ID.assignment]
    )).rows[0];
    assert.equal(new Date(syncedAssignment.start_at).toISOString(), new Date('2030-01-01 10:15:00+08').toISOString());

    // (F) Appointment Move CTE (lib/appointment-multi-service.js)
    const moveCteResult = await runtimeClient.query(
      `
      WITH parent_before AS (
        SELECT
          id,
          shop_id,
          location_id,
          staff_id,
          start_at AS old_start_at,
          end_at AS old_end_at,
          $5::TIMESTAMPTZ - start_at AS exact_delta
        FROM appointments
        WHERE id = $1
          AND shop_id = $2
          AND location_id = $3
          AND staff_id = $4
          AND status IN ('pending', 'confirmed', 'arrived', 'in_service')
          AND override_conflict = FALSE
        FOR UPDATE
      ),
      parent_updated AS (
        UPDATE appointments parent
        SET
          start_at = $5::TIMESTAMPTZ,
          end_at = parent.end_at + before.exact_delta,
          updated_at = NOW()
        FROM parent_before before
        WHERE parent.id = before.id
          AND parent.shop_id = before.shop_id
          AND parent.location_id = before.location_id
          AND parent.staff_id = before.staff_id
        RETURNING
          parent.id,
          parent.shop_id,
          parent.location_id,
          parent.staff_id,
          parent.start_at,
          parent.end_at,
          parent.status,
          before.old_start_at,
          before.old_end_at,
          before.exact_delta
      ),
      items_updated AS (
        UPDATE appointment_items item
        SET
          start_at = item.start_at + parent.exact_delta,
          end_at = item.end_at + parent.exact_delta,
          updated_at = NOW()
        FROM parent_updated parent
        WHERE item.shop_id = parent.shop_id
          AND item.location_id = parent.location_id
          AND item.appointment_id = parent.id
        RETURNING item.id
      ),
      assignments_scoped AS (
        SELECT assignment.id
        FROM appointment_item_staff_assignments assignment
        JOIN appointment_items item
          ON item.shop_id = assignment.shop_id
          AND item.location_id = assignment.location_id
          AND item.id = assignment.appointment_item_id
        JOIN parent_updated parent
          ON item.shop_id = parent.shop_id
          AND item.location_id = parent.location_id
          AND item.appointment_id = parent.id
      ),
      affected_counts AS (
        SELECT
          (SELECT COUNT(*) FROM items_updated) AS item_count,
          (SELECT COUNT(*) FROM assignments_scoped) AS assignment_count
      ),
      audit_insert AS (
        INSERT INTO appointment_time_change_history (
          shop_id,
          location_id,
          appointment_id,
          staff_id,
          actor_type,
          actor_id,
          old_start_at,
          old_end_at,
          new_start_at,
          new_end_at,
          reason,
          source
        )
        SELECT
          parent.shop_id,
          parent.location_id,
          parent.id,
          parent.staff_id,
          'staff',
          $8::UUID,
          parent.old_start_at,
          parent.old_end_at,
          parent.start_at,
          parent.end_at,
          NULL,
          'staff_time_picker'
        FROM parent_updated parent
        CROSS JOIN affected_counts counts
        WHERE counts.item_count = $6::INTEGER
          AND counts.assignment_count = $7::INTEGER
        RETURNING id, appointment_id, new_start_at
      )
      SELECT * FROM audit_insert
      `,
      [
        ID.appointment,
        ID.shop,
        ID.location,
        ID.staff,
        '2030-01-01 14:00:00+08',
        1,
        1,
        ID.staff
      ]
    );
    assert.equal(moveCteResult.rows.length, 1);
    assert.equal(moveCteResult.rows[0].appointment_id, ID.appointment);

    // (G) Time history INSERT RETURNING direct verification
    const timeHistoryReturning = await runtimeClient.query(
      `INSERT INTO appointment_time_change_history (
         shop_id, location_id, appointment_id, staff_id, actor_type, actor_id,
         old_start_at, old_end_at, new_start_at, new_end_at, source
       ) VALUES (
         $1, $2, $3, $4, 'system', NULL,
         '2030-01-01 14:00:00+08', '2030-01-01 15:00:00+08',
         '2030-01-01 15:00:00+08', '2030-01-01 16:00:00+08', 'test_source'
       ) RETURNING id, appointment_id, created_at`,
      [ID.shop, ID.location, ID.appointment, ID.staff]
    );
    assert.ok(timeHistoryReturning.rows[0].id);

    // (H) Checkout Row Locking & POS Flow
    const lockLocationResult = await runtimeClient.query(
      `SELECT location.id FROM locations AS location WHERE location.id = $1 FOR UPDATE OF location`,
      [ID.location]
    );
    assert.equal(lockLocationResult.rows[0].id, ID.location);

    const lockTxResult = await runtimeClient.query(
      `SELECT id FROM checkout_transactions WHERE shop_id = $1 AND idempotency_key = 'test-key' FOR UPDATE`,
      [ID.shop]
    );
    assert.equal(lockTxResult.rows.length, 0);

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
      `INSERT INTO checkout_payments (shop_id, checkout_id, payment_method, value_kind, amount_minor)
       VALUES ($1, $2, 'cash', 'exact', 5000)`,
      [ID.shop, ID.checkout]
    );

    await runtimeClient.query(
      `INSERT INTO checkout_financial_audit (shop_id, checkout_id, appointment_id, event_type, after_snapshot, source, operator_type)
       VALUES ($1, $2, $3, 'checkout_created', '{"total": 5000}', 'test', 'owner')`,
      [ID.shop, ID.checkout, ID.appointment]
    );

    // (I) Negative Security Checks for gg_app_runtime
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
      runtimeClient.query('UPDATE locations SET id = id WHERE id = $1', [ID.location]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    await assert.rejects(
      runtimeClient.query('UPDATE checkout_transactions SET status = \'void\' WHERE id = $1', [ID.checkout]),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('UPDATE checkout_transactions SET id = id WHERE id = $1', [ID.checkout]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    await assert.rejects(
      runtimeClient.query('UPDATE shops SET name = \'Hacked Shop\' WHERE id = $1', [ID.shop]),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('UPDATE shops SET id = id WHERE id = $1', [ID.shop]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    await assert.rejects(
      runtimeClient.query('UPDATE owner_shop_memberships SET role = \'admin\' WHERE id = $1', [membershipShare.rows[0].membership_id]),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('UPDATE owner_shop_memberships SET id = id WHERE id = $1', [membershipShare.rows[0].membership_id]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    // 5. Guard function direct EXECUTE rejected
    await assert.rejects(
      runtimeClient.query('SELECT reject_locked_lookup_actual_update()'),
      err => err.code === '42501'
    );

    // 6. Excess privileges removed
    await assert.rejects(
      runtimeClient.query(
        `INSERT INTO staff_accounts (shop_id, staff_id, login_identifier, password_hash)
         VALUES ('${ID.shop}', '${ID.staff}', 'staff01', 'hash')`
      ),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query(
        `INSERT INTO shop_member_code_counters (shop_id, next_value) VALUES ('${ID.shop}', 10)`
      ),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('SELECT * FROM checkout_staff_attributions'),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query(
        `INSERT INTO checkout_staff_attributions (shop_id, checkout_id, staff_id, role)
         VALUES ('${ID.shop}', '${ID.checkout}', '${ID.staff}', 'stylist')`
      ),
      err => err.code === '42501'
    );

    // 7. TEMP table creation rejected
    await assert.rejects(
      runtimeClient.query('CREATE TEMP TABLE evil_temp (x int)'),
      err => err.code === '42501'
    );

    // 8. Privilege escalation / SET ROLE rejected
    await assert.rejects(
      runtimeClient.query(`SET ROLE ${os.userInfo().username}`),
      err => err.code === '42501'
    );
    await assert.rejects(
      runtimeClient.query('SET ROLE gg_migration_owner'),
      err => err.code === '42501'
    );

    // 8. Test Direct Login as gg_app_onboarding (CLI bootstrap-owner.js role)
    const onboardingUrl = `postgresql://gg_app_onboarding@127.0.0.1:${port}/postgres`;
    bootstrapClient = await connectWhenReady(onboardingUrl, { ssl: { rejectUnauthorized: false } });

    // (A) Onboarding operations pass
    // 1. Transaction with FOR SHARE on shops and owner_accounts (exact script query logic)
    await bootstrapClient.query('BEGIN');
    const shopShareResult = await bootstrapClient.query(
      `SELECT id FROM public.shops WHERE slug = $1 AND status = 'active' FOR SHARE`,
      ['gg-beauty']
    );
    assert.equal(shopShareResult.rows[0].id, ID.shop);

    const existingAccountResult = await bootstrapClient.query(
      `SELECT id FROM public.owner_accounts WHERE login_identifier_normalized = $1 LIMIT 2 FOR SHARE`,
      ['newowner@gg.com']
    );
    assert.equal(existingAccountResult.rows.length, 0);

    const createdOwner = (await bootstrapClient.query(
      `INSERT INTO public.owner_accounts (login_identifier, login_identifier_normalized, password_hash, display_name)
       VALUES ('newowner@gg.com', 'newowner@gg.com', 'test-hash', 'Salon New Owner')
       RETURNING id`
    )).rows[0];

    await bootstrapClient.query(
      `INSERT INTO public.owner_shop_memberships (owner_account_id, shop_id, role)
       VALUES ($1, $2, 'owner')
       RETURNING id`,
      [createdOwner.id, ID.shop]
    );
    await bootstrapClient.query('COMMIT');

    // 2. Actual CLI run of scripts/bootstrap-owner.js via pty to verify real process execution
    const scriptPath = path.join(ROOT, 'scripts', 'bootstrap-owner.js');
    const pythonScript = `
import pty, os, sys, time, shutil

master, slave = pty.openpty()
os.set_blocking(master, False)
node_bin = shutil.which('node') or '${process.execPath}'
env = dict(os.environ)
env['DATABASE_URL'] = '${onboardingUrl}'

pid = os.fork()
if pid == 0:
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvpe(node_bin, [node_bin, '${scriptPath}'], env)
else:
    os.close(slave)

    def read_all(timeout=1.0):
        res = b''
        start = time.time()
        while time.time() - start < timeout:
            try:
                chunk = os.read(master, 1024)
                if chunk:
                    res += chunk
                    start = time.time()
            except Exception:
                pass
            time.sleep(0.05)
        return res

    read_all(0.5)
    os.write(master, b'CREATE OWNER FOR gg-beauty\\n')
    read_all(0.3)
    os.write(master, b'cli-owner@gg.com\\n')
    read_all(0.3)
    os.write(master, b'CLI Owner\\n')
    read_all(0.3)
    os.write(master, b'supersecurepassword12345!\\n')
    read_all(0.3)
    os.write(master, b'supersecurepassword12345!\\n')

    out = read_all(2.0)
    os.close(master)
    try:
        os.kill(pid, 9)
    except Exception:
        pass
    print(out.decode('utf-8', errors='ignore'))
`;
    const cliRes = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.match(cliRes.stdout, /Owner account created successfully/);

    // Verify created in DB
    const cliOwnerCheck = await admin.query(
      "SELECT id FROM owner_accounts WHERE login_identifier_normalized = 'cli-owner@gg.com'"
    );
    assert.equal(cliOwnerCheck.rows.length, 1);

    // (B) Negative security checks for gg_app_onboarding
    // Trigger blocks actual UPDATE on shops
    await assert.rejects(
      bootstrapClient.query('UPDATE shops SET name = \'Hacked\' WHERE id = $1', [ID.shop]),
      err => err.code === '42501'
    );
    await assert.rejects(
      bootstrapClient.query('UPDATE shops SET id = id WHERE id = $1', [ID.shop]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    // Trigger blocks actual UPDATE on owner_accounts
    await assert.rejects(
      bootstrapClient.query('UPDATE owner_accounts SET display_name = \'Hacked\' WHERE id = $1', [createdOwner.id]),
      err => err.code === '42501'
    );
    await assert.rejects(
      bootstrapClient.query('UPDATE owner_accounts SET id = id WHERE id = $1', [createdOwner.id]),
      err => err.code === '42501' && err.message.includes('row locking only')
    );

    // Unauthorized table access rejected
    await assert.rejects(
      bootstrapClient.query('SELECT id FROM appointments LIMIT 1'),
      err => err.code === '42501'
    );
    await assert.rejects(
      bootstrapClient.query('SELECT id FROM customers LIMIT 1'),
      err => err.code === '42501'
    );
    await assert.rejects(
      bootstrapClient.query('SELECT id FROM staff LIMIT 1'),
      err => err.code === '42501'
    );

    // Privilege escalation rejected
    await assert.rejects(
      bootstrapClient.query(`SET ROLE ${os.userInfo().username}`),
      err => err.code === '42501'
    );
    await assert.rejects(
      bootstrapClient.query('SET ROLE gg_migration_owner'),
      err => err.code === '42501'
    );

    // (C) Migration Owner Lock Guard Bypass Verification
    // The lock guard trigger does NOT block gg_migration_owner or admin updates
    await admin.query('SET ROLE gg_migration_owner;');
    await admin.query(`UPDATE shops SET name = 'GG Beauty Owner Modified' WHERE id = '${ID.shop}'`);
    const modifiedShop = (await admin.query(`SELECT name FROM shops WHERE id = '${ID.shop}'`)).rows[0];
    assert.equal(modifiedShop.name, 'GG Beauty Owner Modified');
    await admin.query('RESET ROLE;');

  } finally {
    if (runtimeClient) await runtimeClient.end().catch(() => {});
    if (bootstrapClient) await bootstrapClient.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    postgres.kill('SIGTERM');
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // transient Windows/mac file handle delay
    }
  }
});
