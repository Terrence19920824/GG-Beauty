'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

let Client;
try {
  Client = require('pg').Client;
} catch (_) {
  try {
    Client = require('/Users/guoguanguan/Desktop/GG-Beauty/node_modules/pg').Client;
  } catch (_) {}
}

const contact = require('../lib/merchant-contact');
const { OWNER_MERCHANT_CONTACT_WRITE_ROLES } = require('../server');
const i18n = require('../public/shared-i18n');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

test('1. merchant contact validates only supported normalized public fields', () => {
  assert.deepEqual(contact.validateSettings({ contactPhone: '+65 8123 4567' }).values, { public_contact_phone: '+6581234567' });
  assert.equal(contact.validateSettings({ whatsAppPhone: 'not-a-phone' }).error, 'INVALID_MERCHANT_PHONE');
  assert.equal(contact.validateSettings({ shopId: 'attacker' }).error, 'INVALID_MERCHANT_CONTACT_SETTINGS');

  // Address validation
  const validAddr = contact.validateSettings({ address: '123 Orchard Road, #02-01' });
  assert.equal(validAddr.values.public_address, '123 Orchard Road, #02-01');

  const overlongAddr = 'A'.repeat(256);
  assert.equal(contact.validateSettings({ address: overlongAddr }).error, 'INVALID_MERCHANT_ADDRESS');

  // Postal code validation
  const validPostal = contact.validateSettings({ postalCode: '238888' });
  assert.equal(validPostal.values.public_postal_code, '238888');

  const overlongPostal = '12345678901234567';
  assert.equal(contact.validateSettings({ postalCode: overlongPostal }).error, 'INVALID_MERCHANT_POSTAL_CODE');

  // Map URL validation
  const validMap = contact.validateSettings({ mapUrl: 'https://maps.google.com/?q=Orchard' });
  assert.equal(validMap.values.public_map_url, 'https://maps.google.com/?q=Orchard');

  assert.equal(contact.validateSettings({ mapUrl: 'http://insecure.com' }).error, 'INVALID_MERCHANT_MAP_URL');
  assert.equal(contact.validateSettings({ mapUrl: 'javascript:alert(1)' }).error, 'INVALID_MERCHANT_MAP_URL');
  assert.equal(contact.validateSettings({ mapUrl: 'not-a-url' }).error, 'INVALID_MERCHANT_MAP_URL');

  // Show address boolean
  const showTrue = contact.validateSettings({ showAddress: true });
  assert.equal(showTrue.values.show_public_address, true);

  const showFalse = contact.validateSettings({ showAddress: false });
  assert.equal(showFalse.values.show_public_address, false);
});

test('2. public presentation exposes intended contact fields, address, and map link', () => {
  const fullRow = {
    shop_name: 'Shop',
    public_contact_phone: '+6512345678',
    public_whatsapp_phone: '+6581234567',
    public_address: '123 Orchard Road, #02-01',
    public_postal_code: '238888',
    public_map_url: 'https://maps.google.com/?q=Orchard',
    show_public_address: true
  };

  assert.deepEqual(contact.publicPresentation(fullRow), {
    shopName: 'Shop',
    contactPhone: '+6512345678',
    whatsAppUrl: 'https://wa.me/6581234567',
    address: '123 Orchard Road, #02-01',
    postalCode: '238888',
    mapUrl: 'https://maps.google.com/?q=Orchard',
    showAddress: true
  });

  // When show_public_address is false -> address, postalCode, mapUrl are wiped to null
  const hiddenRow = {
    ...fullRow,
    show_public_address: false
  };

  assert.deepEqual(contact.publicPresentation(hiddenRow), {
    shopName: 'Shop',
    contactPhone: '+6512345678',
    whatsAppUrl: 'https://wa.me/6581234567',
    address: null,
    postalCode: null,
    mapUrl: null,
    showAddress: false
  });

  // When address fields are empty/null
  const emptyAddrRow = {
    shop_name: 'Shop',
    public_contact_phone: null,
    public_whatsapp_phone: null,
    public_address: null,
    public_postal_code: null,
    public_map_url: null,
    show_public_address: true
  };

  assert.deepEqual(contact.publicPresentation(emptyAddrRow), {
    shopName: 'Shop',
    contactPhone: null,
    whatsAppUrl: null,
    address: null,
    postalCode: null,
    mapUrl: null,
    showAddress: true
  });
});

test('2b. auto map link fallback generates standard Google Maps search URL when mapUrl is omitted', () => {
  // 1. Prioritize explicit custom https mapUrl
  const explicitRow = {
    shop_name: 'Shop',
    public_address: '123 Orchard Road, #02-356',
    public_postal_code: '238888',
    public_map_url: 'https://maps.custom.com/place',
    show_public_address: true
  };
  assert.equal(contact.publicPresentation(explicitRow).mapUrl, 'https://maps.custom.com/place');

  // 2. Only address -> auto generate
  const onlyAddrRow = {
    shop_name: 'Shop',
    public_address: '123 Orchard Road',
    public_postal_code: null,
    public_map_url: null,
    show_public_address: true
  };
  assert.equal(
    contact.publicPresentation(onlyAddrRow).mapUrl,
    'https://www.google.com/maps/search/?api=1&query=123%20Orchard%20Road'
  );

  // 3. Only postalCode -> auto generate
  const onlyPostalRow = {
    shop_name: 'Shop',
    public_address: null,
    public_postal_code: '238888',
    public_map_url: '',
    show_public_address: true
  };
  assert.equal(
    contact.publicPresentation(onlyPostalRow).mapUrl,
    'https://www.google.com/maps/search/?api=1&query=238888'
  );

  // 4. Address + postalCode with unit number (#02-356) -> properly encoded
  const complexAddrRow = {
    shop_name: 'Shop',
    public_address: '123 Orchard Road, #02-356',
    public_postal_code: '238888',
    public_map_url: null,
    show_public_address: true
  };
  const expectedQuery = encodeURIComponent('123 Orchard Road, #02-356 238888');
  assert.ok(expectedQuery.includes('%2302-356'));
  assert.equal(
    contact.publicPresentation(complexAddrRow).mapUrl,
    `https://www.google.com/maps/search/?api=1&query=${expectedQuery}`
  );

  // 5. show_public_address=false -> mapUrl MUST be null even if address exists
  const hiddenWithAddrRow = {
    shop_name: 'Shop',
    public_address: '123 Orchard Road, #02-356',
    public_postal_code: '238888',
    public_map_url: null,
    show_public_address: false
  };
  assert.equal(contact.publicPresentation(hiddenWithAddrRow).mapUrl, null);
  assert.equal(contact.publicPresentation(hiddenWithAddrRow).address, null);

  // 6. Empty address and empty postal code -> mapUrl is null
  const noAddressRow = {
    shop_name: 'Shop',
    public_address: '   ',
    public_postal_code: '',
    public_map_url: '',
    show_public_address: true
  };
  assert.equal(contact.publicPresentation(noAddressRow).mapUrl, null);

  // 7. Directly verify buildAutoMapUrl helper
  assert.equal(contact.buildAutoMapUrl('123 Road', '12345'), 'https://www.google.com/maps/search/?api=1&query=123%20Road%2012345');
  assert.equal(contact.buildAutoMapUrl(null, null), null);
  assert.equal(contact.buildAutoMapUrl('', '  '), null);
});

test('3. owner, manager, and admin can write merchant contact while front desk is rejected by the role allow-list', () => {
  for (const role of ['owner', 'manager', 'admin']) assert.ok(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes(role));
  assert.equal(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes('front_desk'), false);
});

test('4. PWA book route validates its path parameter and serves the public booking document without exposing a filesystem path', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/book\/:shopSlug'/);
  assert.match(server, /res\.sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\)/);
  assert.match(server, /return res\.status\(404\)\.end\(\)/);
  assert.doesNotMatch(server, /res\.sendFile\([^\n]*req\.params/);
});

test('5. rollback first and second runs are safe while configured contact and address data remains fail-closed', () => {
  const rollback55 = fs.readFileSync(path.join(ROOT, 'migrations/rollback/055_merchant_contact_schema.sql'), 'utf8');
  assert.match(rollback55, /contact_columns_exist BOOLEAN/);
  assert.match(rollback55, /DROP COLUMN IF EXISTS public_contact_phone/);

  const rollback61 = fs.readFileSync(path.join(ROOT, 'migrations/rollback/061_merchant_address_rollback.sql'), 'utf8');
  assert.match(rollback61, /address_columns_exist BOOLEAN/);
  assert.match(rollback61, /has_configured_address BOOLEAN/);
  assert.match(rollback61, /DROP COLUMN IF EXISTS public_address/);
  assert.match(rollback61, /DROP COLUMN IF EXISTS public_postal_code/);
  assert.match(rollback61, /DROP COLUMN IF EXISTS public_map_url/);
  assert.match(rollback61, /DROP COLUMN IF EXISTS show_public_address/);
});

test('6. i18n: all merchant address keys are defined in zh-CN and en with pure languages', () => {
  const keys = [
    'merchantAddress',
    'merchantPostalCode',
    'merchantMapUrl',
    'merchantMapUrlHelp',
    'merchantShowAddress',
    'openMap',
    'address'
  ];

  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `Missing zh-CN translation for: ${key}`);
    assert.ok(en, `Missing en translation for: ${key}`);
    assert.notStrictEqual(zh, key, `zh-CN translation for ${key} must not be identical to key`);
    assert.notStrictEqual(en, key, `en translation for ${key} must not be identical to key`);

    assert.doesNotMatch(zh.replace(/Google Maps/g, ''), /[a-zA-Z]{3,}/, `zh-CN translation for ${key} should not contain English words: "${zh}"`);
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en translation for ${key} should not contain Chinese characters: "${en}"`);
  }
});

test('7. PWA and merchant contact surfaces contain address fields and safe map links', () => {
  const booking = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const member = fs.readFileSync(path.join(ROOT, 'public/member.html'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const bar = fs.readFileSync(path.join(ROOT, 'public/merchant-contact-bar.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/customer-shared.css'), 'utf8');
  const adminSelfService = fs.readFileSync(path.join(ROOT, 'public/admin-self-service.js'), 'utf8');

  // Admin UI
  assert.match(admin, /id="merchantAddress"/);
  assert.match(admin, /id="merchantPostalCode"/);
  assert.match(admin, /id="merchantMapUrl"/);
  assert.match(admin, /data-i18n="merchantMapUrlHelp"/);
  assert.match(admin, /id="merchantShowAddress"/);
  assert.match(adminSelfService, /merchantAddress/);
  assert.match(adminSelfService, /merchantPostalCode/);
  assert.match(adminSelfService, /merchantMapUrl/);
  assert.match(adminSelfService, /merchantShowAddress/);

  // Customer UI Bar
  assert.match(bar, /merchant-contact-address/);
  assert.match(bar, /openMap/);
  assert.match(bar, /target = '_blank'/);
  assert.match(bar, /rel = 'noopener noreferrer'/);
  assert.match(bar, /google\.com\/maps\/search/);

  // CSS
  assert.match(css, /\.merchant-contact-address/);
  assert.match(css, /\.merchant-contact-action/);

  // Server endpoints include address
  assert.match(server, /settings\.public_address/);
  assert.match(server, /settings\.public_postal_code/);
  assert.match(server, /settings\.public_map_url/);
  assert.match(server, /settings\.show_public_address/);
});

test('8. PostgreSQL 17 merchant address migration lifecycle (060, 061, 062, idempotency, data-safe rollback)', { timeout: 120000 }, async t => {
  if (!Client) return t.skip('pg module unavailable');
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-merchant-address-'));
  const data = path.join(temp, 'data');
  const port = 57400 + Math.floor(Math.random() * 400);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
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

    // Create prerequisite tables
    await db.query(`
      CREATE TABLE public.shops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'active'
      );
      CREATE TABLE public.shop_customer_settings (
        shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
        public_contact_phone text NULL,
        public_whatsapp_phone text NULL
      );
    `);

    const preflight = fs.readFileSync(path.join(ROOT, 'migrations', '060_merchant_address_preflight_readonly.sql'), 'utf8');
    const schema = fs.readFileSync(path.join(ROOT, 'migrations', '061_merchant_address_schema.sql'), 'utf8');
    const verification = fs.readFileSync(path.join(ROOT, 'migrations', '062_merchant_address_verification_readonly.sql'), 'utf8');
    const rollback = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '061_merchant_address_rollback.sql'), 'utf8');

    // 1. Preflight
    await db.query(preflight);

    // 2. Schema
    await db.query(schema);

    // 3. Verification
    await db.query(verification);

    // 4. Schema Idempotency
    await db.query(schema);
    await db.query(verification);

    // Insert a shop and test constraints
    const insertShop = await db.query("INSERT INTO public.shops (slug, name) VALUES ('test-shop', 'Test Shop') RETURNING id");
    const shopId = insertShop.rows[0].id;

    await db.query(
      `INSERT INTO public.shop_customer_settings (shop_id, public_address, public_postal_code, public_map_url, show_public_address)
       VALUES ($1, '123 Orchard Road', '238888', 'https://maps.google.com/?q=Orchard', true)`,
      [shopId]
    );

    // Constraint violations test:
    // a. Map URL not https
    await assert.rejects(
      db.query("UPDATE public.shop_customer_settings SET public_map_url = 'http://insecure.com' WHERE shop_id = $1", [shopId]),
      /shop_customer_settings_public_map_url_check/
    );

    // b. Address over 255 chars
    await assert.rejects(
      db.query("UPDATE public.shop_customer_settings SET public_address = $1 WHERE shop_id = $2", ['X'.repeat(256), shopId]),
      /shop_customer_settings_public_address_check/
    );

    // 5. Data loss protection in rollback
    await assert.rejects(
      db.query(rollback),
      /Merchant address rollback blocked/
    );
    await db.query('ROLLBACK');

    // Clear configured address to permit rollback
    await db.query(
      "UPDATE public.shop_customer_settings SET public_address = NULL, public_postal_code = NULL, public_map_url = NULL WHERE shop_id = $1",
      [shopId]
    );

    // 6. Rollback execution
    await db.query(rollback);

    // Verify columns dropped
    const colCheck = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_customer_settings' AND column_name IN ('public_address','public_postal_code','public_map_url','show_public_address')"
    );
    assert.equal(colCheck.rows.length, 0);

    // 7. Post-rollback Preflight
    await db.query(preflight);

  } finally {
    if (db) await db.end().catch(() => {});
    if (postgres) {
      await new Promise((resolve) => {
        postgres.once('close', resolve);
        postgres.kill('SIGTERM');
        setTimeout(() => postgres.kill('SIGKILL'), 500);
      });
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
