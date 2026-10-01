'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const {
  provisionMerchant,
  validateProvisioningInput,
  MerchantProvisioningError
} = require('../lib/merchant-provisioning');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

test('Merchant Provisioning Service - Complete Suite', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-provision-test-'));
  const data = path.join(temp, 'data');
  const port = 55100 + Math.floor(Math.random() * 800);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port), '-k', temp], { stdio: 'ignore' });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  const connectionString = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Client({ connectionString });
      try {
        await candidate.connect();
        db = candidate;
        break;
      } catch (error) {
        await candidate.end().catch(() => {});
        if (attempt === 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(db, 'local PostgreSQL test server must accept a connection');
    db.on('error', () => {});

    // Build realistic schema
    await db.query(`
      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        tenant_mode TEXT NOT NULL DEFAULT 'live' CONSTRAINT shops_tenant_mode_check CHECK (tenant_mode IN ('demo', 'test', 'live')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE public.locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        name TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(shop_id, id)
      );

      CREATE TABLE public.shop_customer_settings (
        shop_id UUID PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
        default_phone_country_code TEXT NOT NULL DEFAULT '+65',
        member_code_prefix TEXT NOT NULL DEFAULT 'MEM-',
        member_code_width SMALLINT NOT NULL DEFAULT 6,
        dob_requirement TEXT NOT NULL DEFAULT 'optional',
        membership_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        points_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        stored_value_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        packages_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_free_membership BOOLEAN NOT NULL DEFAULT TRUE,
        public_contact_phone TEXT,
        public_whatsapp_phone TEXT,
        public_address TEXT,
        public_postal_code TEXT,
        public_business_hours TEXT,
        public_display_name TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE public.shop_member_code_counters (
        shop_id UUID PRIMARY KEY REFERENCES public.shops(id) ON DELETE RESTRICT,
        next_value BIGINT NOT NULL DEFAULT 1
      );

      CREATE TABLE public.membership_tiers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        tier_code TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        price_minor INTEGER NOT NULL DEFAULT 0,
        validity_type TEXT NOT NULL DEFAULT 'permanent',
        UNIQUE (shop_id, tier_code)
      );

      CREATE OR REPLACE FUNCTION public.provision_shop_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.shop_customer_settings(shop_id) VALUES(NEW.id) ON CONFLICT (shop_id) DO NOTHING;
        INSERT INTO public.shop_member_code_counters(shop_id,next_value) VALUES(NEW.id,1) ON CONFLICT (shop_id) DO NOTHING;
        INSERT INTO public.membership_tiers(shop_id, tier_code, name, is_default, is_active, price_minor, validity_type)
          VALUES(NEW.id, 'ordinary', '普通会员', true, true, 0, 'permanent')
          ON CONFLICT (shop_id, tier_code) DO NOTHING;
        RETURN NEW;
      END $$;

      CREATE TRIGGER shops_provision_customer_identity AFTER INSERT ON public.shops
      FOR EACH ROW EXECUTE FUNCTION public.provision_shop_customer_identity();

      CREATE TABLE public.service_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        canonical_name TEXT NOT NULL,
        icon_key TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(shop_id, id),
        UNIQUE(shop_id, canonical_name)
      );

      CREATE TABLE public.service_category_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        category_id UUID NOT NULL,
        locale TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(shop_id, category_id, locale),
        FOREIGN KEY (shop_id, category_id) REFERENCES public.service_categories(shop_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE public.owner_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        login_identifier TEXT NOT NULL,
        login_identifier_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        session_version INTEGER NOT NULL DEFAULT 1,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE public.owner_shop_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id UUID NOT NULL REFERENCES public.owner_accounts(id) ON DELETE RESTRICT,
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'admin', 'front_desk')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (owner_account_id, shop_id)
      );
    `);

    // Insert an existing baseline merchant (representative of Shop A)
    const existingShopResult = await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('existing-shop', 'Existing Demo Shop', 'demo')
      RETURNING id
    `);
    const existingShopId = existingShopResult.rows[0].id;

    // ----------------------------------------------------
    // Test 1: Successful merchant provisioning creates complete valid merchant
    // ----------------------------------------------------
    const result1 = await provisionMerchant(db, {
      name: 'Alpha Wellness',
      slug: 'alpha-wellness',
      tenantMode: 'live',
      location: {
        name: 'Orchard Flagship',
        timezone: 'Asia/Singapore'
      },
      categories: [
        { canonicalName: 'Massage', nameZh: '推拿按摩', nameEn: 'Massage', iconKey: 'massage' },
        { canonicalName: 'Foot Care', nameZh: '足疗保健', nameEn: 'Foot Care', iconKey: 'foot' }
      ],
      owner: {
        loginIdentifier: 'alpha-owner',
        displayName: 'Alpha Founder',
        password: 'SuperSecurePassword2026!'
      }
    });

    assert.equal(result1.success, true);
    assert.equal(result1.shop.slug, 'alpha-wellness');
    assert.equal(result1.shop.tenantMode, 'live');
    assert.equal(result1.categories.length, 2);
    assert.equal(result1.owner.loginIdentifier, 'alpha-owner');
    assert.equal(result1.owner.role, 'owner');

    // ----------------------------------------------------
    // Test 2: Unique shop UUID created
    // ----------------------------------------------------
    assert.ok(result1.shop.id);
    assert.match(result1.shop.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(result1.shop.id, existingShopId);

    // ----------------------------------------------------
    // Test 3: Unique slug enforced
    // ----------------------------------------------------
    await assert.rejects(
      provisionMerchant(db, {
        name: 'Alpha Duplicate',
        slug: 'alpha-wellness'
      }),
      err => err instanceof MerchantProvisioningError && err.code === 'DUPLICATE_SLUG'
    );

    // ----------------------------------------------------
    // Test 4: Initial location belongs to correct shop
    // ----------------------------------------------------
    assert.equal(result1.location.shopId, result1.shop.id);
    const locInDb = await db.query('SELECT * FROM public.locations WHERE id = $1', [result1.location.id]);
    assert.equal(locInDb.rows.length, 1);
    assert.equal(locInDb.rows[0].shop_id, result1.shop.id);
    assert.equal(locInDb.rows[0].name, 'Orchard Flagship');
    assert.equal(locInDb.rows[0].timezone, 'Asia/Singapore');

    // ----------------------------------------------------
    // Test 5: Initial categories belong to correct shop
    // ----------------------------------------------------
    const catInDb = await db.query(
      'SELECT id, canonical_name FROM public.service_categories WHERE shop_id = $1 ORDER BY sort_order',
      [result1.shop.id]
    );
    assert.equal(catInDb.rows.length, 2);
    assert.deepEqual(catInDb.rows.map(r => r.canonical_name), ['Massage', 'Foot Care']);

    // Check translations
    const transInDb = await db.query(
      'SELECT locale, name FROM public.service_category_translations WHERE shop_id = $1 ORDER BY locale',
      [result1.shop.id]
    );
    assert.equal(transInDb.rows.length, 4);

    // ----------------------------------------------------
    // Test 6: Owner membership belongs to correct shop
    // ----------------------------------------------------
    const membershipInDb = await db.query(
      'SELECT owner_account_id, shop_id, role FROM public.owner_shop_memberships WHERE id = $1',
      [result1.owner.membershipId]
    );
    assert.equal(membershipInDb.rows.length, 1);
    assert.equal(membershipInDb.rows[0].shop_id, result1.shop.id);
    assert.equal(membershipInDb.rows[0].role, 'owner');

    // ----------------------------------------------------
    // Test 7: Password is hashed and never logged / returned
    // ----------------------------------------------------
    assert.equal(result1.owner.password, undefined);
    assert.equal(result1.owner.password_hash, undefined);
    assert.equal(result1.owner.passwordHash, undefined);
    const accountInDb = await db.query(
      'SELECT password_hash FROM public.owner_accounts WHERE id = $1',
      [result1.owner.accountId]
    );
    assert.ok(accountInDb.rows[0].password_hash);
    assert.notEqual(accountInDb.rows[0].password_hash, 'SuperSecurePassword2026!');
    const hashMatches = await bcrypt.compare('SuperSecurePassword2026!', accountInDb.rows[0].password_hash);
    assert.equal(hashMatches, true);

    // ----------------------------------------------------
    // Test 8: Duplicate slug fails safely without partial rows
    // ----------------------------------------------------
    const beforeCount = await db.query('SELECT count(*) FROM public.shops');
    await assert.rejects(
      provisionMerchant(db, {
        name: 'Another Duplicate',
        slug: 'alpha-wellness',
        categories: [{ canonicalName: 'Test' }]
      }),
      err => err.code === 'DUPLICATE_SLUG'
    );
    const afterCount = await db.query('SELECT count(*) FROM public.shops');
    assert.equal(beforeCount.rows[0].count, afterCount.rows[0].count);

    // ----------------------------------------------------
    // Test 9: Invalid required inputs fail safely
    // ----------------------------------------------------
    await assert.rejects(
      provisionMerchant(db, { name: '', slug: 'valid-slug' }),
      err => err.code === 'INVALID_MERCHANT_NAME'
    );
    await assert.rejects(
      provisionMerchant(db, { name: 'Valid', slug: 'INVALID SLUG!' }),
      err => err.code === 'INVALID_SLUG'
    );
    await assert.rejects(
      provisionMerchant(db, { name: 'Valid', slug: 'valid-slug', tenantMode: 'unknown' }),
      err => err.code === 'INVALID_TENANT_MODE'
    );
    await assert.rejects(
      provisionMerchant(db, { name: 'Valid', slug: 'valid-slug', location: { timezone: 'Invalid/Zone' } }),
      err => err.code === 'INVALID_TIMEZONE'
    );
    await assert.rejects(
      provisionMerchant(db, {
        name: 'Valid',
        slug: 'valid-slug',
        owner: { loginIdentifier: 'adm', displayName: 'Adm', password: 'short' }
      }),
      err => err.code === 'PASSWORD_TOO_SHORT'
    );

    // ----------------------------------------------------
    // Test 10: Mid-provision failure rolls back the entire new merchant transaction
    // ----------------------------------------------------
    // Trigger an error during category translation or duplicate category canonical name in input
    await assert.rejects(
      provisionMerchant(db, {
        name: 'Rollback Shop',
        slug: 'rollback-shop',
        categories: [
          { canonicalName: 'DupCat' },
          { canonicalName: 'DupCat' } // Will cause unique(shop_id, canonical_name) violation
        ]
      })
    );

    // Verify zero rows for 'rollback-shop' exist in shops, locations, settings, etc.
    const rolledBackShop = await db.query("SELECT id FROM public.shops WHERE slug = 'rollback-shop'");
    assert.equal(rolledBackShop.rows.length, 0);

    // ----------------------------------------------------
    // Test 11: Existing merchant is not modified
    // ----------------------------------------------------
    const existingShopAfter = await db.query('SELECT * FROM public.shops WHERE id = $1', [existingShopId]);
    assert.equal(existingShopAfter.rows[0].name, 'Existing Demo Shop');
    assert.equal(existingShopAfter.rows[0].tenant_mode, 'demo');

    // ----------------------------------------------------
    // Test 12: Demo/test/live classification validates correctly
    // ----------------------------------------------------
    const demoShop = await provisionMerchant(db, {
      name: 'Demo Beauty',
      slug: 'demo-beauty',
      tenantMode: 'demo'
    });
    assert.equal(demoShop.shop.tenantMode, 'demo');

    const testShop = await provisionMerchant(db, {
      name: 'Test Grooming',
      slug: 'test-grooming',
      tenantMode: 'test'
    });
    assert.equal(testShop.shop.tenantMode, 'test');

    // ----------------------------------------------------
    // Test 13: Dynamic categories are respected; Hair/Beauty are NOT global defaults
    // ----------------------------------------------------
    // 13a. Shop with Hair only
    const hairShop = await provisionMerchant(db, {
      name: 'Barber Pro',
      slug: 'barber-pro',
      categories: [{ canonicalName: 'Hair', nameZh: '美发' }]
    });
    assert.equal(hairShop.categories.length, 1);
    assert.equal(hairShop.categories[0].canonicalName, 'Hair');

    // 13b. Shop with zero initial categories
    const emptyShop = await provisionMerchant(db, {
      name: 'Blank Canvas',
      slug: 'blank-canvas'
    });
    assert.equal(emptyShop.categories.length, 0);

    // ----------------------------------------------------
    // Test 14: No cross-tenant resource is attached to the new merchant
    // ----------------------------------------------------
    const crossCatCheck = await db.query(
      `SELECT count(*) FROM public.service_categories WHERE shop_id = $1`,
      [emptyShop.shop.id]
    );
    assert.equal(crossCatCheck.rows[0].count, '0');

    const crossLocCheck = await db.query(
      `SELECT shop_id FROM public.locations WHERE id = $1`,
      [hairShop.location.id]
    );
    assert.equal(crossLocCheck.rows[0].shop_id, hairShop.shop.id);
    assert.notEqual(crossLocCheck.rows[0].shop_id, result1.shop.id);
  } finally {
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGINT');
    const forceKill = setTimeout(() => {
      postgres.kill('SIGKILL');
    }, 3000);
    await exited;
    clearTimeout(forceKill);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
