'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const bcrypt = require('bcryptjs');

const {
  INVITATION_STATES,
  MerchantOnboardingError,
  getInvitationStatus,
  consumeMerchantInvitation
} = require('../lib/merchant-onboarding');
const { provisionMerchantInTransaction } = require('../lib/merchant-provisioning');
const { generateToken, hashToken } = require('../lib/invitation-token');
const { createOwnerAuth } = require('../lib/owner-auth');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const ROOT = path.resolve(__dirname, '..');
const invitationMigration = fs.readFileSync(
  path.join(ROOT, 'migrations/099_merchant_onboarding_invitation_schema.sql'),
  'utf8'
);
const defaultsPreflight = fs.readFileSync(
  path.join(ROOT, 'migrations/101_merchant_business_defaults_preflight_readonly.sql'),
  'utf8'
);
const defaultsMigration = fs.readFileSync(
  path.join(ROOT, 'migrations/102_merchant_business_defaults_schema.sql'),
  'utf8'
);
const defaultsVerification = fs.readFileSync(
  path.join(ROOT, 'migrations/103_merchant_business_defaults_verification_readonly.sql'),
  'utf8'
);
const defaultsRollback = fs.readFileSync(
  path.join(ROOT, 'migrations/rollback/102_merchant_business_defaults_rollback.sql'),
  'utf8'
);

const payloadFor = (token, suffix) => ({
  token,
  businessName: `Merchant ${suffix}`,
  slug: `merchant-${suffix}`,
  locationName: `Location ${suffix}`,
  country: 'SG',
  address: `${suffix} Test Street`,
  postalCode: '123456',
  timezone: 'Asia/Singapore',
  currencyCode: 'SGD',
  locale: 'en',
  ownerDisplayName: `Owner ${suffix}`,
  ownerLoginIdentifier: `owner-${suffix}`,
  password: `Secure-${suffix}-Password-2026!`,
  passwordConfirmation: `Secure-${suffix}-Password-2026!`
});

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

test('merchant invitation consumption is single-use, atomic, tenant-safe, and secret-safe', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-onboarding-consume-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const init = spawnSync(
    path.join(PG_BIN, 'initdb'),
    ['-D', data, '-A', 'trust', '--no-locale'],
    { encoding: 'utf8' }
  );
  assert.equal(init.status, 0, init.stderr);

  const port = 57000 + Math.floor(Math.random() * 1000);
  const postgres = spawn(
    path.join(PG_BIN, 'postgres'),
    ['-D', data, '-k', socket, '-p', String(port)],
    { stdio: 'ignore' }
  );
  const postgresExit = new Promise(resolve => postgres.once('exit', resolve));
  const config = { host: socket, port, database: 'postgres', user: os.userInfo().username };
  let setup;
  let pool;

  const createInvitation = async ({ status = 'pending', expired = false } = {}) => {
    const token = generateToken();
    const result = await pool.query(
      `INSERT INTO public.merchant_onboarding_invitations (
         token_hash, status, expires_at,
         consumed_at, revoked_at
       ) VALUES (
         $1, $2,
         CASE WHEN $3 THEN NOW() - INTERVAL '1 hour' ELSE NOW() + INTERVAL '1 day' END,
         CASE WHEN $2 = 'consumed' THEN NOW() ELSE NULL END,
         CASE WHEN $2 = 'revoked' THEN NOW() ELSE NULL END
       ) RETURNING id`,
      [hashToken(token), status, expired]
    );
    return { token, id: result.rows[0].id };
  };

  try {
    setup = await connectWhenReady(config, postgres);
    await setup.query(`
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
        name TEXT,
        timezone TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, id)
      );
      CREATE TABLE public.shop_customer_settings (
        shop_id UUID PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
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
        id UUID PRIMARY KEY,
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        canonical_name TEXT NOT NULL,
        icon_key TEXT,
        sort_order INTEGER NOT NULL,
        is_active BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (shop_id, id),
        UNIQUE (shop_id, canonical_name)
      );
      CREATE TABLE public.service_category_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        category_id UUID NOT NULL,
        locale TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (shop_id, category_id, locale),
        FOREIGN KEY (shop_id, category_id)
          REFERENCES public.service_categories(shop_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE public.owner_accounts (
        id UUID PRIMARY KEY,
        login_identifier TEXT NOT NULL,
        login_identifier_normalized TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL,
        session_version INTEGER NOT NULL,
        failed_login_attempts INTEGER NOT NULL,
        locked_until TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT owner_accounts_login_identifier_normalized_key
          UNIQUE (login_identifier_normalized)
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
    `);
    await setup.query(invitationMigration);
    await setup.query(defaultsPreflight);
    await setup.query(defaultsMigration);
    await setup.query(defaultsVerification);
    await setup.end();
    setup = null;

    pool = new Pool({ ...config, max: 12 });
    const baseline = await pool.query(
      `INSERT INTO public.shops (slug, name, tenant_mode)
       VALUES ('shop-a-demo', 'Shop A Demo', 'demo')
       RETURNING id`
    );
    const shopAId = baseline.rows[0].id;

    await t.test('valid invitation creates complete tenant with self-set bcrypt password', async () => {
      const invitation = await createInvitation();
      const payload = payloadFor(invitation.token, 'success');
      const captured = [];
      const wrappedPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (sql, params = []) => {
              captured.push({ sql, params });
              return client.query(sql, params);
            },
            release: () => client.release()
          };
        }
      };

      const result = await consumeMerchantInvitation(wrappedPool, payload, {
        consumedIp: '127.0.0.1'
      });
      assert.equal(result.success, true);
      assert.equal(result.shop.slug, 'merchant-success');
      assert.equal(result.owner.role, 'owner');
      assert.equal(result.loginPath, '/admin.html');
      assert.equal(JSON.stringify(result).includes(payload.password), false);
      assert.equal(JSON.stringify(result).includes(invitation.token), false);

      for (const query of captured) {
        assert.equal(query.sql.includes(invitation.token), false);
        assert.equal(query.sql.includes(payload.password), false);
        for (const parameter of query.params) {
          assert.notEqual(parameter, invitation.token);
          assert.notEqual(parameter, payload.password);
        }
      }
      const lookup = captured.find(query => /merchant_onboarding_invitations/.test(query.sql));
      assert.equal(lookup.params[0], hashToken(invitation.token));

      const rows = await pool.query(
        `SELECT shop.id, shop.slug, shop.tenant_mode,
                location.shop_id, location.timezone,
                settings.public_address, settings.country_code, settings.default_phone_country_code,
                settings.currency_code, settings.default_locale,
                account.password_hash, membership.role,
                invitation.status AS invitation_status,
                invitation.resulting_shop_id, invitation.consumed_ip
         FROM public.shops shop
         JOIN public.locations location ON location.shop_id = shop.id
         JOIN public.shop_customer_settings settings ON settings.shop_id = shop.id
         JOIN public.owner_shop_memberships membership ON membership.shop_id = shop.id
         JOIN public.owner_accounts account ON account.id = membership.owner_account_id
         JOIN public.merchant_onboarding_invitations invitation
           ON invitation.resulting_shop_id = shop.id
         WHERE shop.slug = 'merchant-success'`
      );
      assert.equal(rows.rows.length, 1);
      const row = rows.rows[0];
      assert.equal(row.id, row.shop_id);
      assert.equal(row.tenant_mode, 'live');
      assert.equal(row.timezone, 'Asia/Singapore');
      assert.equal(row.public_address, 'success Test Street');
      assert.equal(row.country_code, 'SG');
      assert.equal(row.default_phone_country_code, '+65');
      assert.equal(row.currency_code, 'SGD');
      assert.equal(row.default_locale, 'en');
      assert.equal(row.role, 'owner');
      assert.equal(row.invitation_status, 'consumed');
      assert.equal(row.resulting_shop_id, row.id);
      assert.equal(row.consumed_ip, '127.0.0.1');
      assert.notEqual(row.password_hash, payload.password);
      assert.match(row.password_hash, /^\$2[aby]\$12\$/);
      assert.equal(await bcrypt.compare(payload.password, row.password_hash), true);
      assert.equal(
        (await pool.query('SELECT COUNT(*)::integer AS count FROM public.owner_sessions')).rows[0].count,
        0,
        'onboarding must not create an automatic Owner session'
      );

      const ownerAuth = createOwnerAuth({
        pool,
        bcrypt,
        crypto,
        isSameOriginRequest: () => true,
        safeErrorCode: error => error && error.code || 'unknown_error'
      });
      const loginResponse = {
        statusCode: 200,
        headers: {},
        payload: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(value) { this.payload = value; return this; }
      };
      await ownerAuth.login({
        body: {
          loginIdentifier: payload.ownerLoginIdentifier,
          password: payload.password,
          shopSlug: payload.slug
        },
        headers: {}
      }, loginResponse);
      assert.equal(loginResponse.statusCode, 200);
      assert.equal(loginResponse.payload.success, true);
      assert.equal(loginResponse.payload.data.activeShop.slug, payload.slug);
      assert.equal(loginResponse.payload.data.membership.role, 'owner');
      assert.match(loginResponse.headers['Set-Cookie'], /HttpOnly/);

      await assert.rejects(
        consumeMerchantInvitation(pool, payload),
        error => error instanceof MerchantOnboardingError &&
          error.code === 'INVITATION_ALREADY_CONSUMED'
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.shops WHERE slug = 'merchant-success'"))
          .rows[0].count,
        1
      );
    });

    await t.test('concurrent submissions create at most one merchant and owner', async () => {
      const invitation = await createInvitation();
      const payload = payloadFor(invitation.token, 'concurrent');
      const results = await Promise.allSettled([
        consumeMerchantInvitation(pool, payload),
        consumeMerchantInvitation(pool, payload)
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected');
      assert.equal(rejected.reason.code, 'INVITATION_ALREADY_CONSUMED');
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.shops WHERE slug = 'merchant-concurrent'"))
          .rows[0].count,
        1
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.owner_accounts WHERE login_identifier_normalized = 'owner-concurrent'"))
          .rows[0].count,
        1
      );
    });

    await t.test('invalid, expired, revoked, and consumed states fail without provisioning', async () => {
      assert.deepEqual(await getInvitationStatus(pool, 'not-a-token'), {
        state: INVITATION_STATES.INVALID
      });
      const unknownToken = generateToken();
      assert.equal(
        (await getInvitationStatus(pool, unknownToken)).state,
        INVITATION_STATES.INVALID
      );
      await assert.rejects(
        consumeMerchantInvitation(pool, payloadFor(unknownToken, 'invalid-token')),
        error => error.code === 'INVITATION_INVALID'
      );

      for (const fixture of [
        { options: { expired: true }, state: 'EXPIRED', code: 'INVITATION_EXPIRED' },
        { options: { status: 'revoked' }, state: 'REVOKED', code: 'INVITATION_REVOKED' },
        { options: { status: 'consumed' }, state: 'ALREADY_CONSUMED', code: 'INVITATION_ALREADY_CONSUMED' }
      ]) {
        const invitation = await createInvitation(fixture.options);
        assert.equal((await getInvitationStatus(pool, invitation.token)).state, fixture.state);
        await assert.rejects(
          consumeMerchantInvitation(pool, payloadFor(invitation.token, fixture.state.toLowerCase().replaceAll('_', '-'))),
          error => error.code === fixture.code
        );
      }
    });

    await t.test('duplicate slug and duplicate owner login roll back the invitation and tenant', async () => {
      const slugInvitation = await createInvitation();
      const slugPayload = payloadFor(slugInvitation.token, 'duplicate-slug');
      slugPayload.slug = 'shop-a-demo';
      await assert.rejects(
        consumeMerchantInvitation(pool, slugPayload),
        error => error.code === 'DUPLICATE_SLUG'
      );
      assert.equal(
        (await pool.query('SELECT status FROM public.merchant_onboarding_invitations WHERE id = $1', [slugInvitation.id])).rows[0].status,
        'pending'
      );

      await pool.query(
        `INSERT INTO public.owner_accounts (
           id, login_identifier, login_identifier_normalized, password_hash,
           display_name, is_active, session_version, failed_login_attempts,
           password_changed_at, created_at, updated_at
         ) VALUES (gen_random_uuid(), 'taken-owner', 'taken-owner', $1,
                   'Existing Owner', TRUE, 1, 0, NOW(), NOW(), NOW())`,
        [await bcrypt.hash('Existing-Owner-Password-2026!', 12)]
      );
      const ownerInvitation = await createInvitation();
      const ownerPayload = payloadFor(ownerInvitation.token, 'duplicate-owner');
      ownerPayload.ownerLoginIdentifier = 'TAKEN-OWNER';
      await assert.rejects(
        consumeMerchantInvitation(pool, ownerPayload),
        error => error.code === 'DUPLICATE_OWNER_LOGIN'
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.shops WHERE slug = 'merchant-duplicate-owner'"))
          .rows[0].count,
        0
      );
      assert.equal(
        (await pool.query('SELECT status FROM public.merchant_onboarding_invitations WHERE id = $1', [ownerInvitation.id])).rows[0].status,
        'pending'
      );
    });

    await t.test('failure after provisioning and owner insert failure leave no partial tenant', async () => {
      const afterProvisionInvitation = await createInvitation();
      const afterProvisionPayload = payloadFor(afterProvisionInvitation.token, 'forced-rollback');
      await assert.rejects(
        consumeMerchantInvitation(pool, afterProvisionPayload, {
          provisionInTransaction: async (...args) => {
            await provisionMerchantInTransaction(...args);
            throw Object.assign(new Error('forced failure'), { code: 'TEST_FORCED_FAILURE' });
          }
        }),
        error => error.code === 'ONBOARDING_FAILED'
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.shops WHERE slug = 'merchant-forced-rollback'"))
          .rows[0].count,
        0
      );
      assert.equal(
        (await pool.query('SELECT status FROM public.merchant_onboarding_invitations WHERE id = $1', [afterProvisionInvitation.id])).rows[0].status,
        'pending'
      );

      await pool.query(`
        CREATE FUNCTION public.reject_test_owner() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.login_identifier_normalized = 'owner-owner-failure' THEN
            RAISE EXCEPTION 'forced owner insert failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER owner_insert_failure BEFORE INSERT ON public.owner_accounts
          FOR EACH ROW EXECUTE FUNCTION public.reject_test_owner();
      `);
      const ownerFailureInvitation = await createInvitation();
      await assert.rejects(
        consumeMerchantInvitation(pool, payloadFor(ownerFailureInvitation.token, 'owner-failure')),
        error => error.code === 'ONBOARDING_FAILED'
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM public.shops WHERE slug = 'merchant-owner-failure'"))
          .rows[0].count,
        0
      );
      assert.equal(
        (await pool.query('SELECT status FROM public.merchant_onboarding_invitations WHERE id = $1', [ownerFailureInvitation.id])).rows[0].status,
        'pending'
      );
    });

    await t.test('existing Shop A demo tenant remains unchanged', async () => {
      const shopA = await pool.query(
        'SELECT id, slug, name, tenant_mode FROM public.shops WHERE id = $1',
        [shopAId]
      );
      assert.deepEqual(shopA.rows, [{
        id: shopAId,
        slug: 'shop-a-demo',
        name: 'Shop A Demo',
        tenant_mode: 'demo'
      }]);
    });

    await t.test('country determines default_phone_country_code (MY -> +60)', async () => {
      const invitation = await createInvitation();
      const payload = payloadFor(invitation.token, 'country-my');
      payload.country = 'MY';
      payload.currencyCode = 'MYR';
      const result = await consumeMerchantInvitation(pool, payload);
      assert.equal(result.success, true);
      const row = (await pool.query(
        `SELECT settings.country_code, settings.default_phone_country_code, settings.currency_code
         FROM public.shop_customer_settings settings
         JOIN public.shops shop ON shop.id = settings.shop_id
         WHERE shop.slug = $1`,
        [payload.slug]
      )).rows[0];
      assert.equal(row.country_code, 'MY');
      assert.equal(row.default_phone_country_code, '+60');
      assert.equal(row.currency_code, 'MYR');
    });

    await t.test('password 72-byte boundary and character length enforced end-to-end', async () => {
      const pw72Invitation = await createInvitation();
      const pw72Payload = payloadFor(pw72Invitation.token, 'pw-72');
      const pw72 = 'P'.repeat(72);
      pw72Payload.password = pw72;
      pw72Payload.passwordConfirmation = pw72;
      const pw72Result = await consumeMerchantInvitation(pool, pw72Payload);
      assert.equal(pw72Result.success, true);
      const row = (await pool.query(
        `SELECT account.password_hash
         FROM public.owner_accounts account
         JOIN public.owner_shop_memberships m ON m.owner_account_id = account.id
         JOIN public.shops shop ON shop.id = m.shop_id
         WHERE shop.slug = $1`,
        [pw72Payload.slug]
      )).rows[0];
      assert.equal(await bcrypt.compare(pw72, row.password_hash), true);

      const pw73Invitation = await createInvitation();
      const pw73Payload = payloadFor(pw73Invitation.token, 'pw-73');
      pw73Payload.password = 'P'.repeat(73);
      pw73Payload.passwordConfirmation = 'P'.repeat(73);
      await assert.rejects(
        consumeMerchantInvitation(pool, pw73Payload),
        error => error.code === 'PASSWORD_TOO_LONG'
      );

      const multibyteOverInvitation = await createInvitation();
      const multibytePayload = payloadFor(multibyteOverInvitation.token, 'pw-mb');
      multibytePayload.password = '密'.repeat(25);
      multibytePayload.passwordConfirmation = '密'.repeat(25);
      await assert.rejects(
        consumeMerchantInvitation(pool, multibytePayload),
        error => error.code === 'PASSWORD_TOO_LONG'
      );
    });

    await t.test('authoritative business defaults validation rejects invalid inputs', async () => {
      const inv = await createInvitation();
      const basePayload = payloadFor(inv.token, 'bad-defaults');

      await assert.rejects(
        consumeMerchantInvitation(pool, { ...basePayload, country: 'ZZ' }),
        error => error.code === 'INVALID_COUNTRY'
      );
      await assert.rejects(
        consumeMerchantInvitation(pool, { ...basePayload, currencyCode: 'AAA' }),
        error => error.code === 'INVALID_CURRENCY_CODE'
      );
      await assert.rejects(
        consumeMerchantInvitation(pool, { ...basePayload, locale: 'fr' }),
        error => error.code === 'INVALID_LOCALE'
      );
      await assert.rejects(
        consumeMerchantInvitation(pool, { ...basePayload, timezone: 'Fake/Timezone' }),
        error => error.code === 'INVALID_TIMEZONE'
      );
    });

    await t.test('currency/locale rollback fails closed after onboarding history exists', async () => {
      const client = await pool.connect();
      try {
        await assert.rejects(
          client.query(defaultsRollback),
          /onboarding history exists; use forward repair instead/i
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const columns = await pool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'shop_customer_settings'
           AND column_name IN ('country_code', 'currency_code', 'default_locale')
         ORDER BY column_name`
      );
      assert.deepEqual(columns.rows, [
        { column_name: 'country_code' },
        { column_name: 'currency_code' },
        { column_name: 'default_locale' }
      ]);
    });

    await t.test('rollback succeeds in clean state and fails closed on populated settings without onboarding', async () => {
      const adminClient = await pool.connect();
      try {
        await adminClient.query('CREATE DATABASE test_rollback_clean');
      } finally {
        adminClient.release();
      }

      const cleanClient = new Client({ ...config, database: 'test_rollback_clean' });
      await cleanClient.connect();
      try {
        await cleanClient.query(`
          CREATE TABLE public.shops (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            tenant_mode TEXT NOT NULL DEFAULT 'live'
          );
          CREATE TABLE public.shop_customer_settings (
            shop_id UUID PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
            default_phone_country_code TEXT NOT NULL DEFAULT '+65'
          );
        `);
        await cleanClient.query(invitationMigration);
        await cleanClient.query(defaultsPreflight);
        await cleanClient.query(defaultsMigration);
        await cleanClient.query(defaultsVerification);

        // A. Clean rollback succeeds
        await cleanClient.query(defaultsRollback);
        const colsAfterClean = await cleanClient.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'shop_customer_settings'
             AND column_name IN ('country_code', 'currency_code', 'default_locale')`
        );
        assert.equal(colsAfterClean.rows.length, 0);

        // B. Re-apply schema and insert populated setting (no onboarding history)
        await cleanClient.query(defaultsMigration);
        await cleanClient.query(`
          INSERT INTO public.shops (id, slug, name, tenant_mode)
          VALUES ('00000000-0000-0000-0000-000000000001', 'shop-clean', 'Clean Shop', 'live');
          INSERT INTO public.shop_customer_settings (shop_id, country_code, currency_code, default_locale)
          VALUES ('00000000-0000-0000-0000-000000000001', 'SG', 'SGD', 'en');
        `);

        // Rollback must fail closed
        await assert.rejects(
          cleanClient.query(defaultsRollback),
          /shop_customer_settings contains populated business defaults/i
        );
        await cleanClient.query('ROLLBACK');

        const colsAfterGuarded = await cleanClient.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'shop_customer_settings'
             AND column_name IN ('country_code', 'currency_code', 'default_locale')
           ORDER BY column_name`
        );
        assert.deepEqual(colsAfterGuarded.rows, [
          { column_name: 'country_code' },
          { column_name: 'currency_code' },
          { column_name: 'default_locale' }
        ]);
      } finally {
        await cleanClient.end().catch(() => {});
      }
    });

    await t.test('Migration 103 verification passes for valid constraints and rejects weakened / tautological variants', async () => {
      const verifyClient = await pool.connect();
      try {
        // 1. Valid constraints -> PASS
        await verifyClient.query(defaultsVerification);

        const targetConstraints = [
          {
            name: 'shop_customer_settings_country_code_check',
            valid: "country_code IS NULL OR country_code ~ '^[A-Z]{2}$'",
            errorMatch: /country constraint missing, not validated, or definition drifted/i
          },
          {
            name: 'shop_customer_settings_currency_code_check',
            valid: "currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'",
            errorMatch: /currency constraint missing, not validated, or definition drifted/i
          },
          {
            name: 'shop_customer_settings_default_locale_check',
            valid: "default_locale IS NULL OR default_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'",
            errorMatch: /locale constraint missing, not validated, or definition drifted/i
          }
        ];

        for (const { name, valid, errorMatch } of targetConstraints) {
          const adversarialVariants = [
            'TRUE',
            `${valid} OR TRUE`,
            `${valid} OR (1 = 1)`
          ];

          for (const variant of adversarialVariants) {
            await verifyClient.query(`
              ALTER TABLE public.shop_customer_settings
                DROP CONSTRAINT IF EXISTS ${name};
              ALTER TABLE public.shop_customer_settings
                ADD CONSTRAINT ${name} CHECK (${variant});
            `);

            await assert.rejects(
              verifyClient.query(defaultsVerification),
              errorMatch,
              `Migration 103 must fail when ${name} is weakened with: ${variant}`
            );
            await verifyClient.query('ROLLBACK').catch(() => {});
          }

          // Restore valid constraint
          await verifyClient.query(`
            ALTER TABLE public.shop_customer_settings
              DROP CONSTRAINT IF EXISTS ${name};
            ALTER TABLE public.shop_customer_settings
              ADD CONSTRAINT ${name} CHECK (${valid});
          `);
        }

        // Verify that after restoring all valid constraints, Migration 103 passes again
        await verifyClient.query(defaultsVerification);
      } finally {
        verifyClient.release();
      }
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (setup) await setup.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await postgresExit;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
