'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { Client, Pool } = require('pg');
const { app } = require('../server');
const { generateToken, hashToken } = require('../lib/invitation-token');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const merchantInvitationMigration = fs.readFileSync(
  path.join(ROOT, 'migrations/099_merchant_onboarding_invitation_schema.sql'),
  'utf8'
);
const staffActivationMigration = fs.readFileSync(
  path.join(ROOT, 'migrations/105_staff_front_desk_activation_schema.sql'),
  'utf8'
);

async function connectWhenReady(config, postgres) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      if (postgres.exitCode !== null || postgres.signalCode !== null) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const jsonRequest = async (baseUrl, route, { method = 'GET', body, cookie } = {}) => {
  const headers = { Origin: baseUrl };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
};

const checkStatus = (readiness, key) => readiness.checks
  .find(check => check.key === key)?.status;

test('disposable merchant completes the supported onboarding-to-launch flow', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    return t.skip('PostgreSQL 17 unavailable');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-launch-e2e-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const init = spawnSync(
    path.join(PG_BIN, 'initdb'),
    ['-D', data, '-A', 'trust', '--no-locale'],
    { encoding: 'utf8' }
  );
  assert.equal(init.status, 0, init.stderr);

  const port = 58000 + Math.floor(Math.random() * 1000);
  const postgres = spawn(
    path.join(PG_BIN, 'postgres'),
    ['-D', data, '-k', socket, '-p', String(port)],
    { stdio: 'ignore' }
  );
  const postgresExit = new Promise(resolve => postgres.once('exit', resolve));
  const config = {
    host: socket,
    port,
    database: 'postgres',
    user: os.userInfo().username
  };
  let setup;
  let pool;

  const previous = {
    merchantOnboardingPool: app.locals.merchantOnboardingPool,
    ownerAuthPool: app.locals.ownerAuthPool,
    bookingPool: app.locals.bookingPool,
    publicBaseUrl: app.locals.publicBaseUrl,
    qrCode: app.locals.qrCode
  };

  try {
    setup = await connectWhenReady(config, postgres);
    await setup.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        tenant_mode TEXT NOT NULL DEFAULT 'live'
          CHECK (tenant_mode IN ('demo', 'test', 'live')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE public.locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE public.shop_customer_settings (
        shop_id UUID PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
        country_code TEXT,
        currency_code TEXT,
        default_locale TEXT,
        default_phone_country_code TEXT NOT NULL DEFAULT '+65',
        public_contact_phone TEXT,
        public_whatsapp_phone TEXT,
        public_address TEXT,
        public_postal_code TEXT,
        public_business_hours TEXT,
        public_display_name TEXT,
        member_code_prefix TEXT NOT NULL DEFAULT 'MEM-',
        member_code_width SMALLINT NOT NULL DEFAULT 6,
        dob_requirement TEXT NOT NULL DEFAULT 'optional',
        membership_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        points_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        stored_value_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        packages_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_free_membership BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION public.create_shop_settings() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.shop_customer_settings (shop_id) VALUES (NEW.id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER shops_create_settings AFTER INSERT ON public.shops
        FOR EACH ROW EXECUTE FUNCTION public.create_shop_settings();

      CREATE TABLE public.service_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        canonical_name TEXT NOT NULL,
        icon_key TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, id),
        UNIQUE (shop_id, canonical_name)
      );
      CREATE TABLE public.service_category_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        category_id UUID NOT NULL,
        locale TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, category_id, locale),
        FOREIGN KEY (shop_id, category_id)
          REFERENCES public.service_categories(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        category TEXT,
        category_id UUID,
        name TEXT NOT NULL,
        description TEXT,
        price NUMERIC NOT NULL DEFAULT 0,
        price_is_from BOOLEAN NOT NULL DEFAULT FALSE,
        duration_minutes INTEGER NOT NULL,
        bookable BOOLEAN NOT NULL DEFAULT TRUE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, id),
        FOREIGN KEY (shop_id, category_id)
          REFERENCES public.service_categories(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.service_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        service_id UUID NOT NULL,
        locale TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, service_id, locale),
        FOREIGN KEY (shop_id, service_id)
          REFERENCES public.services(shop_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE public.owner_accounts (
        id UUID PRIMARY KEY,
        login_identifier TEXT NOT NULL,
        login_identifier_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL,
        session_version INTEGER NOT NULL,
        failed_login_attempts INTEGER NOT NULL,
        locked_until TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE public.owner_shop_memberships (
        id UUID PRIMARY KEY,
        owner_account_id UUID NOT NULL REFERENCES public.owner_accounts(id) ON DELETE RESTRICT,
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'admin', 'front_desk')),
        is_active BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (owner_account_id, shop_id),
        UNIQUE (id, owner_account_id, shop_id)
      );
      CREATE TABLE public.owner_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash TEXT NOT NULL UNIQUE,
        membership_id UUID NOT NULL,
        owner_account_id UUID NOT NULL,
        shop_id UUID NOT NULL,
        session_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoke_reason TEXT,
        FOREIGN KEY (membership_id, owner_account_id, shop_id)
          REFERENCES public.owner_shop_memberships(id, owner_account_id, shop_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE public.staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        staff_code TEXT,
        bookable BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        can_login BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE public.staff_location_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        location_id UUID NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, staff_id, location_id),
        FOREIGN KEY (shop_id, staff_id) REFERENCES public.staff(shop_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (shop_id, location_id) REFERENCES public.locations(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.staff_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        service_id UUID NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, staff_id, service_id),
        FOREIGN KEY (shop_id, staff_id) REFERENCES public.staff(shop_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (shop_id, service_id) REFERENCES public.services(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.staff_location_working_hours (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        location_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        day_of_week INTEGER NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        effective_from DATE,
        effective_to DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (shop_id, staff_id, location_id)
          REFERENCES public.staff_location_assignments(shop_id, staff_id, location_id)
          ON DELETE RESTRICT
      );
      CREATE TABLE public.staff_schedule_overrides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        location_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        schedule_date DATE NOT NULL,
        override_type TEXT NOT NULL,
        start_time TIME,
        end_time TIME,
        reason TEXT,
        approval_status TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID,
        created_by_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE public.appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        location_id UUID NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE public.appointment_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        location_id UUID NOT NULL,
        appointment_id UUID NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE public.appointment_item_staff_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        location_id UUID NOT NULL,
        appointment_item_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        role TEXT NOT NULL
      );

      CREATE TABLE public.staff_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        staff_id UUID NOT NULL,
        login_identifier TEXT NOT NULL,
        login_identifier_normalized TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        session_version INTEGER NOT NULL DEFAULT 1,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, staff_id),
        UNIQUE (shop_id, login_identifier_normalized),
        FOREIGN KEY (shop_id, staff_id) REFERENCES public.staff(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.staff_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        staff_account_id UUID NOT NULL,
        can_view_customer_history BOOLEAN NOT NULL DEFAULT FALSE,
        can_view_service_notes BOOLEAN NOT NULL DEFAULT FALSE,
        can_view_own_sales BOOLEAN NOT NULL DEFAULT FALSE,
        can_view_own_commission BOOLEAN NOT NULL DEFAULT FALSE,
        can_view_full_customer_phone BOOLEAN NOT NULL DEFAULT FALSE,
        can_move_own_appointments BOOLEAN NOT NULL DEFAULT TRUE,
        can_update_own_appointment_status BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, staff_account_id),
        FOREIGN KEY (staff_account_id) REFERENCES public.staff_accounts(id) ON DELETE RESTRICT
      );
    `);
    await setup.query(merchantInvitationMigration);
    await setup.query(staffActivationMigration);
    await setup.end();
    setup = null;

    pool = new Pool({ ...config, max: 12 });
    app.locals.merchantOnboardingPool = pool;
    app.locals.ownerAuthPool = pool;
    app.locals.bookingPool = pool;
    app.locals.publicBaseUrl = 'https://booking.example.test';
    const qrPayloads = [];
    app.locals.qrCode = {
      toString: async payload => {
        qrPayloads.push(payload);
        return '<svg data-e2e="merchant-booking-qr"></svg>';
      }
    };

    const merchantToken = generateToken();
    await pool.query(
      `INSERT INTO public.merchant_onboarding_invitations (
         token_hash, status, expires_at, merchant_name_hint
       ) VALUES ($1, 'pending', NOW() + INTERVAL '1 day', 'Disposable Launch Merchant')`,
      [hashToken(merchantToken)]
    );

    await withServer(async baseUrl => {
      const ownerPassword = 'Disposable-Owner-Password-2026!';
      const onboarding = await jsonRequest(baseUrl, '/api/merchant-onboarding/invitation/consume', {
        method: 'POST',
        body: {
          token: merchantToken,
          businessName: 'Disposable Launch Merchant',
          slug: 'disposable-launch-merchant',
          locationName: 'Launch Test Location',
          country: 'SG',
          address: '1 Test Street',
          postalCode: '123456',
          timezone: 'Asia/Singapore',
          currencyCode: 'SGD',
          locale: 'en',
          ownerDisplayName: 'Disposable Owner',
          ownerLoginIdentifier: 'disposable-launch-owner',
          password: ownerPassword,
          passwordConfirmation: ownerPassword
        }
      });
      assert.equal(onboarding.response.status, 201);
      assert.equal(onboarding.payload.success, true);
      assert.equal(onboarding.payload.data.shop.slug, 'disposable-launch-merchant');
      assert.equal(JSON.stringify(onboarding.payload).includes(merchantToken), false);
      assert.equal(JSON.stringify(onboarding.payload).includes(ownerPassword), false);

      const login = await jsonRequest(baseUrl, '/api/owner/login', {
        method: 'POST',
        body: {
          loginIdentifier: 'disposable-launch-owner',
          password: ownerPassword,
          shopSlug: 'disposable-launch-merchant'
        }
      });
      assert.equal(login.response.status, 200);
      const cookie = login.response.headers.get('set-cookie').split(';')[0];

      const ownerMe = await jsonRequest(baseUrl, '/api/owner/me', { cookie });
      assert.equal(ownerMe.response.status, 200);
      assert.equal(ownerMe.payload.data.activeShop.slug, 'disposable-launch-merchant');
      assert.equal(ownerMe.payload.data.membership.role, 'owner');
      const merchantShopId = ownerMe.payload.data.activeShop.id;
      const canonicalUrl = 'https://booking.example.test/book/disposable-launch-merchant';
      const locationId = (await pool.query(
        `SELECT location.id
         FROM public.locations AS location
         JOIN public.shops AS shop ON shop.id = location.shop_id
         WHERE shop.slug = 'disposable-launch-merchant'`
      )).rows[0].id;

      await pool.query('UPDATE public.locations SET is_active = FALSE WHERE id = $1', [locationId]);
      const missingLocation = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(checkStatus(missingLocation.payload.data, 'active_location'), 'incomplete');
      assert.equal(checkStatus(missingLocation.payload.data, 'business_timezone'), 'incomplete');
      assert.equal(checkStatus(missingLocation.payload.data, 'booking_url'), 'incomplete');
      assert.equal(checkStatus(missingLocation.payload.data, 'booking_qr'), 'complete');
      await pool.query('UPDATE public.locations SET is_active = TRUE WHERE id = $1', [locationId]);

      const emptyConfiguration = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(emptyConfiguration.payload.data.booking.url, canonicalUrl);
      assert.equal(emptyConfiguration.payload.data.booking.qrAvailable, true);
      for (const key of [
        'active_service',
        'active_staff',
        'staff_location_assignment',
        'bookable_capability',
        'working_schedule'
      ]) {
        assert.equal(checkStatus(emptyConfiguration.payload.data, key), 'incomplete', key);
      }

      const category = await jsonRequest(baseUrl, '/api/owner/service-categories', {
        method: 'POST', cookie,
        body: {
          canonicalName: 'Launch Services',
          nameEn: 'Launch Services',
          nameZh: '开通服务',
          sortOrder: 0,
          isActive: false
        }
      });
      assert.equal(category.response.status, 201);
      const categoryId = category.payload.data.id;

      const service = await jsonRequest(baseUrl, '/api/owner/services', {
        method: 'POST', cookie,
        body: {
          name: 'Launch Facial',
          categoryId,
          price: 80,
          priceIsFrom: false,
          durationMinutes: 60,
          bookable: true,
          isActive: false,
          sortOrder: 0
        }
      });
      assert.equal(service.response.status, 201);
      const serviceId = service.payload.data.id;

      const staff = await jsonRequest(baseUrl, '/api/owner/staff', {
        method: 'POST', cookie,
        body: {
          name: 'Launch Staff',
          staffCode: 'LS01',
          bookable: false,
          isActive: false
        }
      });
      assert.equal(staff.response.status, 201);
      const staffId = staff.payload.data.id;

      const inactiveReadiness = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(inactiveReadiness.response.status, 200);
      assert.equal(inactiveReadiness.payload.data.ready, false);
      assert.equal(checkStatus(inactiveReadiness.payload.data, 'active_service'), 'incomplete');
      assert.equal(checkStatus(inactiveReadiness.payload.data, 'active_staff'), 'incomplete');

      assert.equal((await jsonRequest(baseUrl, `/api/owner/service-categories/${categoryId}`, {
        method: 'PATCH', cookie, body: { isActive: true }
      })).response.status, 200);
      assert.equal((await jsonRequest(baseUrl, `/api/owner/services/${serviceId}`, {
        method: 'PATCH', cookie, body: { isActive: true }
      })).response.status, 200);
      assert.equal((await jsonRequest(baseUrl, `/api/owner/staff/${staffId}`, {
        method: 'PATCH', cookie, body: { isActive: true, bookable: true }
      })).response.status, 200);

      const missingAssignment = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(checkStatus(missingAssignment.payload.data, 'active_service'), 'complete');
      assert.equal(checkStatus(missingAssignment.payload.data, 'active_staff'), 'complete');
      assert.equal(checkStatus(missingAssignment.payload.data, 'staff_location_assignment'), 'incomplete');
      assert.equal(checkStatus(missingAssignment.payload.data, 'bookable_capability'), 'incomplete');
      assert.equal(checkStatus(missingAssignment.payload.data, 'working_schedule'), 'incomplete');

      const assigned = await jsonRequest(baseUrl, `/api/owner/staff/${staffId}/locations`, {
        method: 'PUT', cookie, body: { locationIds: [locationId] }
      });
      assert.equal(assigned.response.status, 200);
      assert.deepEqual(assigned.payload.data.locationIds, [locationId]);
      const missingCapability = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(checkStatus(missingCapability.payload.data, 'staff_location_assignment'), 'complete');
      assert.equal(checkStatus(missingCapability.payload.data, 'bookable_capability'), 'incomplete');
      assert.equal(checkStatus(missingCapability.payload.data, 'working_schedule'), 'incomplete');

      const capability = await jsonRequest(baseUrl, `/api/owner/staff/${staffId}/services`, {
        method: 'PUT', cookie, body: { serviceIds: [serviceId] }
      });
      assert.equal(capability.response.status, 200);
      assert.deepEqual(capability.payload.data.serviceIds, [serviceId]);
      const missingSchedule = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(checkStatus(missingSchedule.payload.data, 'bookable_capability'), 'complete');
      assert.equal(checkStatus(missingSchedule.payload.data, 'working_schedule'), 'incomplete');

      const schedule = await jsonRequest(baseUrl, `/api/owner/staff/${staffId}/schedule`, {
        method: 'PUT', cookie,
        body: {
          locationId,
          days: Array.from({ length: 7 }, (_unused, index) => index === 0
            ? { dayOfWeek: 1, isWorking: true, startTime: '10:00', endTime: '18:00' }
            : { dayOfWeek: index + 1, isWorking: false })
        }
      });
      assert.equal(schedule.response.status, 200);

      const staffInvitation = await jsonRequest(
        baseUrl,
        `/api/owner/staff/${staffId}/activation-invitation`,
        { method: 'POST', cookie, body: { ttlDays: 7 } }
      );
      assert.equal(staffInvitation.response.status, 201);
      const staffToken = staffInvitation.payload.data.rawToken;
      assert.match(staffToken, /^[A-Za-z0-9_-]+$/);

      const staffPassword = 'Disposable-Staff-Password-2026!';
      const activation = await jsonRequest(baseUrl, '/api/staff-activation/consume', {
        method: 'POST',
        body: {
          token: staffToken,
          username: 'launch.staff',
          password: staffPassword,
          passwordConfirmation: staffPassword
        }
      });
      assert.equal(activation.response.status, 201);
      assert.equal(activation.payload.data.success, true);
      assert.equal(activation.payload.data.shopSlug, 'disposable-launch-merchant');
      assert.equal(
        (await pool.query(
          `SELECT COUNT(*)::INTEGER AS count
           FROM public.staff_accounts
           WHERE shop_id = $1 AND staff_id = $2 AND status = 'active'`,
          [merchantShopId, staffId]
        )).rows[0].count,
        1
      );

      const readiness = await jsonRequest(baseUrl, '/api/owner/launch/readiness', { cookie });
      assert.equal(readiness.response.status, 200);
      assert.equal(readiness.payload.data.ready, true);
      assert.equal(readiness.payload.data.checks.length, 11);
      assert.equal(readiness.payload.data.checks.every(check => check.status === 'complete'), true);
      assert.equal(readiness.payload.data.booking.url, canonicalUrl);
      assert.equal(readiness.payload.data.booking.qrAvailable, true);

      const qr = await fetch(`${baseUrl}/api/owner/launch/booking-qr.svg`, {
        headers: {
          Cookie: cookie,
          Origin: baseUrl,
          'X-Forwarded-Host': 'attacker.invalid'
        }
      });
      assert.equal(qr.status, 200);
      assert.equal(qrPayloads.at(-1), canonicalUrl);
      assert.equal(qrPayloads.at(-1).includes(merchantToken), false);
      assert.equal(qrPayloads.at(-1).includes(staffToken), false);
      assert.equal(qrPayloads.at(-1).includes(onboarding.payload.data.shop.id), false);

      const bookingPage = await fetch(`${baseUrl}/book/disposable-launch-merchant`);
      assert.equal(bookingPage.status, 200);
      const publicContext = await jsonRequest(
        baseUrl,
        '/api/booking/context?shopSlug=disposable-launch-merchant'
      );
      assert.equal(publicContext.response.status, 200);
      assert.deepEqual(publicContext.payload, {
        success: true,
        data: {
          shopSlug: 'disposable-launch-merchant',
          shopName: 'Disposable Launch Merchant'
        }
      });
    });
  } finally {
    app.locals.merchantOnboardingPool = previous.merchantOnboardingPool;
    app.locals.ownerAuthPool = previous.ownerAuthPool;
    app.locals.bookingPool = previous.bookingPool;
    app.locals.publicBaseUrl = previous.publicBaseUrl;
    app.locals.qrCode = previous.qrCode;
    if (pool) await pool.end().catch(() => {});
    if (setup) await setup.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await Promise.race([
      postgresExit,
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
