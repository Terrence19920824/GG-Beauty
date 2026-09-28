'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const contact = require('../lib/merchant-contact');
const categoryFlow = require('../public/customer-category-flow');
const i18n = require('../public/shared-i18n');
const { app, OWNER_MERCHANT_CONTACT_WRITE_ROLES } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || (fs.existsSync('/opt/homebrew/bin/initdb') ? '/opt/homebrew/bin' : '/opt/homebrew/opt/postgresql@17/bin');
const readSql = filename => fs.readFileSync(path.join(ROOT, 'migrations', filename), 'utf8');

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

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

// -----------------------------------------------------------------------------
// 1. i18n Key Fix & Translations
// -----------------------------------------------------------------------------
test('1. i18n: membershipModule translates to 会员 in zh-CN and Membership in en', () => {
  assert.equal(i18n.t('membershipModule', 'zh-CN'), '会员');
  assert.equal(i18n.t('membershipModule', 'en'), 'Membership');
  assert.notEqual(i18n.t('membershipModule', 'zh-CN'), 'membershipModule');
  assert.notEqual(i18n.t('membershipModule', 'en'), 'membershipModule');
});

test('2. i18n: business profile and announcement keys defined in zh-CN and en', () => {
  const keys = [
    'merchantDisplayName',
    'merchantDisplayNameHelp',
    'businessHours',
    'businessHoursHelp',
    'website',
    'instagram',
    'customerAnnouncement',
    'customerAnnouncementToggle',
    'showMore',
    'showLess'
  ];

  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.ok(zh, `Missing zh-CN translation for ${key}`);
    assert.ok(en, `Missing en translation for ${key}`);
    assert.notEqual(zh, key);
    assert.notEqual(en, key);
    // en has no Chinese
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/);
  }
});

// -----------------------------------------------------------------------------
// 2. Display Name Fallback & Overrides
// -----------------------------------------------------------------------------
test('3. display-name resolves public_display_name when present, otherwise falls back to shops.name', () => {
  // Case A: public_display_name is null -> falls back to shop_name
  const rowWithNull = {
    shop_name: 'Authoritative Shop Name',
    public_display_name: null
  };
  const presA = contact.publicPresentation(rowWithNull);
  assert.equal(presA.displayName, 'Authoritative Shop Name');
  assert.equal(presA.shopName, 'Authoritative Shop Name');

  // Case B: public_display_name is empty / whitespace -> falls back to shop_name
  const rowWithEmpty = {
    shop_name: 'Authoritative Shop Name',
    public_display_name: '   '
  };
  const presB = contact.publicPresentation(rowWithEmpty);
  assert.equal(presB.displayName, 'Authoritative Shop Name');

  // Case C: public_display_name is custom string -> overrides displayName, keeps shopName authoritative
  const rowWithCustom = {
    shop_name: 'Authoritative Shop Name',
    public_display_name: 'GG Glamour Studio'
  };
  const presC = contact.publicPresentation(rowWithCustom);
  assert.equal(presC.displayName, 'GG Glamour Studio');
  assert.equal(presC.shopName, 'Authoritative Shop Name');
});

// -----------------------------------------------------------------------------
// 3. Announcement Visibility & Safety
// -----------------------------------------------------------------------------
test('4. customer announcement visibility rules: default OFF, empty text hidden, enabled+text active', () => {
  // Default OFF -> inactive, empty text
  const rowOff = {
    shop_name: 'Shop',
    customer_announcement_enabled: false,
    customer_announcement_text: 'Important holiday update'
  };
  const presOff = contact.publicPresentation(rowOff);
  assert.deepEqual(presOff.announcement, { active: false, text: '' });

  // ON but empty text -> inactive, empty text
  const rowOnEmpty = {
    shop_name: 'Shop',
    customer_announcement_enabled: true,
    customer_announcement_text: '   '
  };
  const presOnEmpty = contact.publicPresentation(rowOnEmpty);
  assert.deepEqual(presOnEmpty.announcement, { active: false, text: '' });

  // ON with valid text -> active
  const rowOnText = {
    shop_name: 'Shop',
    customer_announcement_enabled: true,
    customer_announcement_text: 'We are closed on Monday for renovations.'
  };
  const presOnText = contact.publicPresentation(rowOnText);
  assert.deepEqual(presOnText.announcement, {
    active: true,
    text: 'We are closed on Monday for renovations.'
  });
});

test('5. announcement and business profile field validation and URL security', () => {
  // Website URL validation
  assert.ok(contact.validateSettings({ websiteUrl: 'https://example.com' }).values.public_website_url);
  assert.ok(contact.validateSettings({ websiteUrl: 'http://example.com' }).values.public_website_url);
  assert.equal(contact.validateSettings({ websiteUrl: 'javascript:alert(1)' }).error, 'INVALID_MERCHANT_WEBSITE_URL');
  assert.equal(contact.validateSettings({ websiteUrl: 'data:text/html,bad' }).error, 'INVALID_MERCHANT_WEBSITE_URL');
  assert.equal(contact.validateSettings({ websiteUrl: 'file:///etc/passwd' }).error, 'INVALID_MERCHANT_WEBSITE_URL');
  assert.equal(contact.validateSettings({ websiteUrl: 'not-a-url' }).error, 'INVALID_MERCHANT_WEBSITE_URL');
  assert.equal(contact.validateSettings({ websiteUrl: 'https://' + 'a'.repeat(500) }).error, 'INVALID_MERCHANT_WEBSITE_URL');

  // Instagram URL validation
  assert.ok(contact.validateSettings({ instagramUrl: 'https://instagram.com/myshop' }).values.public_instagram_url);
  assert.equal(contact.validateSettings({ instagramUrl: 'javascript:alert(1)' }).error, 'INVALID_MERCHANT_INSTAGRAM_URL');
  assert.equal(contact.validateSettings({ instagramUrl: 'data:text/html,bad' }).error, 'INVALID_MERCHANT_INSTAGRAM_URL');
  assert.equal(contact.validateSettings({ instagramUrl: 'not-a-url' }).error, 'INVALID_MERCHANT_INSTAGRAM_URL');

  // Display Name bounds
  assert.equal(contact.validateSettings({ displayName: 'Valid Shop' }).values.public_display_name, 'Valid Shop');
  assert.equal(contact.validateSettings({ displayName: 'A'.repeat(256) }).error, 'INVALID_MERCHANT_DISPLAY_NAME');

  // Business Hours bounds
  assert.equal(contact.validateSettings({ businessHours: 'Mon-Sun 10am-8pm' }).values.public_business_hours, 'Mon-Sun 10am-8pm');
  assert.equal(contact.validateSettings({ businessHours: 'H'.repeat(1001) }).error, 'INVALID_MERCHANT_BUSINESS_HOURS');

  // Announcement bounds
  assert.equal(contact.validateSettings({ announcementText: 'Announcement' }).values.customer_announcement_text, 'Announcement');
  assert.equal(contact.validateSettings({ announcementText: 'T'.repeat(1001) }).error, 'INVALID_CUSTOMER_ANNOUNCEMENT_TEXT');
  assert.equal(contact.validateSettings({ announcementEnabled: true }).values.customer_announcement_enabled, true);
  assert.equal(contact.validateSettings({ announcementEnabled: false }).values.customer_announcement_enabled, false);

  // Reject unexpected keys (including browser-chosen shopId)
  assert.equal(contact.validateSettings({ shopId: 'fake-tenant' }).error, 'INVALID_MERCHANT_CONTACT_SETTINGS');
  assert.equal(contact.validateSettings({ shop_id: 'fake-tenant' }).error, 'INVALID_MERCHANT_CONTACT_SETTINGS');
});

// -----------------------------------------------------------------------------
// 4. Single-Category / Specialist-Shop Auto-Entry
// -----------------------------------------------------------------------------
test('6. specialist shop / single category auto-entry behavior in customer category flow', () => {
  // Case A: 0 effective categories (0 categories, 0 services) -> empty state
  const stateEmpty = categoryFlow.deriveTabsState([], '', []);
  assert.equal(stateEmpty.isEmpty, true);
  assert.equal(stateEmpty.showTabs, false);
  assert.equal(stateEmpty.selectedCategoryId, '');

  // Case B: 1 category with services, no orphan services -> auto-select it, hide category selector
  const stateSingle = categoryFlow.deriveTabsState(
    [{ categoryId: 'nails', name: 'Nails' }],
    '',
    [{ id: 's1', categoryId: 'nails', name: 'Manicure' }]
  );
  assert.equal(stateSingle.isEmpty, false);
  assert.equal(stateSingle.showTabs, false); // Hidden category selector!
  assert.equal(stateSingle.showCategoryCards, false);
  assert.equal(stateSingle.selectedCategoryId, 'nails'); // Auto-selected!
  assert.equal(stateSingle.showBookingStep, true);

  // Case C: 2 categories with services -> show category selector
  const stateMulti = categoryFlow.deriveTabsState(
    [
      { categoryId: 'nails', name: 'Nails' },
      { categoryId: 'hair', name: 'Hair' }
    ],
    '',
    [
      { id: 's1', categoryId: 'nails', name: 'Manicure' },
      { id: 's2', categoryId: 'hair', name: 'Haircut' }
    ]
  );
  assert.equal(stateMulti.isEmpty, false);
  assert.equal(stateMulti.showTabs, true); // Category selector shown!
  assert.equal(stateMulti.showCategoryCards, true);
  assert.equal(stateMulti.selectedCategoryId, 'nails');

  // Case D: 1 category + orphan services -> synthetic Other counts as effective category -> 2 effective categories -> show tabs!
  const stateWithOrphan = categoryFlow.deriveTabsState(
    [{ categoryId: 'nails', name: 'Nails' }],
    '',
    [
      { id: 's1', categoryId: 'nails', name: 'Manicure' },
      { id: 's2', categoryId: null, name: 'General Consultation' }
    ]
  );
  assert.equal(stateWithOrphan.hasOrphanServices, true);
  assert.equal(stateWithOrphan.categories.length, 2);
  assert.equal(stateWithOrphan.showTabs, true);
});

// -----------------------------------------------------------------------------
// 5. Customer Home UI Structure & Contact Card Cleanup
// -----------------------------------------------------------------------------
test('7. customer homepage order: header -> language -> account -> announcement -> booking -> bottom contact card', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  const headerIdx = indexHtml.indexOf('<div class="header">');
  const langIdx = indexHtml.indexOf('class="language-switch"');
  const memberIdx = indexHtml.indexOf('id="memberEntry"');
  const announcementIdx = indexHtml.indexOf('id="customerAnnouncement"');
  const categoryStepIdx = indexHtml.indexOf('id="categoryStep"');
  const bookingStepIdx = indexHtml.indexOf('id="bookingStep"');
  const contactStepIdx = indexHtml.indexOf('id="contactStep"');
  const merchantContactBarIdx = indexHtml.indexOf('id="merchantContactBar"');

  assert.ok(headerIdx > 0, 'Header must exist');
  assert.ok(headerIdx < langIdx, 'Header contains language switch');
  assert.ok(langIdx < memberIdx, 'Language switch before memberEntry');
  assert.ok(memberIdx < announcementIdx, 'Member/Bookings entry before announcement');
  assert.ok(announcementIdx < categoryStepIdx, 'Announcement before categoryStep');
  assert.ok(categoryStepIdx < bookingStepIdx, 'CategoryStep before bookingStep');
  assert.ok(bookingStepIdx < contactStepIdx, 'BookingStep before contactStep');
  assert.ok(contactStepIdx < merchantContactBarIdx, 'MerchantContactBar must be at BOTTOM below booking flow');
});

test('8. bottom merchant contact bar contains NO duplicate My Account, My Bookings, or Booking links', () => {
  const barSource = fs.readFileSync(path.join(ROOT, 'public/merchant-contact-bar.js'), 'utf8');

  assert.doesNotMatch(barSource, /membershipEntry/, 'Bottom contact card must not have duplicate My Account link');
  assert.doesNotMatch(barSource, /myBookings/, 'Bottom contact card must not have duplicate My Bookings link');
  assert.doesNotMatch(barSource, /merchantBooking/, 'Bottom contact card must not have duplicate Booking link');
});

// -----------------------------------------------------------------------------
// 6. Security: Tenant Isolation and Role Gating
// -----------------------------------------------------------------------------
test('9. owner merchant contact write rejects front_desk role and enforces role allow-list', () => {
  for (const role of ['owner', 'manager', 'admin']) {
    assert.ok(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes(role));
  }
  assert.equal(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes('front_desk'), false);
  assert.equal(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes('customer'), false);
  assert.equal(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes('staff'), false);
});

// -----------------------------------------------------------------------------
// 7. PostgreSQL 17 Migration Lifecycle & Constraints Integration Test
// -----------------------------------------------------------------------------
test('10. PostgreSQL 17 Business Profile migration lifecycle (084, 085, 086, idempotency, data-safe rollback)', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    return t.skip('PostgreSQL 17 unavailable');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-biz-prof-'));
  const dataDir = path.join(tempDir, 'data');
  const socketDir = path.join(tempDir, 'socket');
  fs.mkdirSync(socketDir);
  const port = 59100 + Math.floor(Math.random() * 200);

  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', dataDir, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  let stderr = '';
  const pgProcess = spawn(path.join(PG_BIN, 'postgres'), ['-D', dataDir, '-k', socketDir, '-p', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  pgProcess.stderr.on('data', chunk => { stderr += chunk; });

  const connectionString = `postgresql://${os.userInfo().username}@localhost:${port}/postgres?host=${encodeURIComponent(socketDir)}`;
  let db;

  try {
    db = await waitForPostgres(connectionString, pgProcess, () => stderr);

    // Setup baseline prerequisites (shops and shop_customer_settings)
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
        public_whatsapp_phone text NULL,
        public_address text NULL,
        public_postal_code text NULL,
        public_map_url text NULL,
        show_public_address boolean NOT NULL DEFAULT true
      );
    `);

    const preflight = readSql('084_merchant_business_profile_preflight_readonly.sql');
    const schema = readSql('085_merchant_business_profile_schema.sql');
    const verification = readSql('086_merchant_business_profile_verification_readonly.sql');
    const rollback = readSql('rollback/085_merchant_business_profile_rollback.sql');

    // 1. Preflight succeeds on clean baseline
    await db.query(preflight);

    // 2. Schema executes and adds columns
    await db.query(schema);

    // 3. Verification succeeds
    await db.query(verification);

    // 4. Schema idempotency (running schema and verification again)
    await db.query(schema);
    await db.query(verification);

    // 5. Preflight blocks when columns exist
    await assert.rejects(
      db.query(preflight),
      /business profile columns already exist/
    );
    await db.query('ROLLBACK');

    // 6. Insert test shop and verify defaults & constraints
    const shopRes = await db.query("INSERT INTO public.shops (slug, name) VALUES ('test-salon', 'Test Salon') RETURNING id");
    const shopId = shopRes.rows[0].id;

    await db.query(
      `INSERT INTO public.shop_customer_settings (shop_id, public_display_name, public_business_hours, public_website_url, public_instagram_url, customer_announcement_text, customer_announcement_enabled)
       VALUES ($1, 'Test Display', '10am - 8pm', 'https://salon.com', 'https://instagram.com/salon', 'Welcome!', true)`,
      [shopId]
    );

    // Verify constraints:
    // a. Invalid website URL protocol
    await assert.rejects(
      db.query("UPDATE public.shop_customer_settings SET public_website_url = 'javascript:alert(1)' WHERE shop_id = $1", [shopId]),
      /shop_customer_settings_public_website_url_check/
    );

    // b. Invalid instagram URL protocol
    await assert.rejects(
      db.query("UPDATE public.shop_customer_settings SET public_instagram_url = 'ftp://invalid' WHERE shop_id = $1", [shopId]),
      /shop_customer_settings_public_instagram_url_check/
    );

    // c. Display name over 255 chars
    await assert.rejects(
      db.query("UPDATE public.shop_customer_settings SET public_display_name = $1 WHERE shop_id = $2", ['X'.repeat(256), shopId]),
      /shop_customer_settings_public_display_name_check/
    );

    // 7. Guarded Rollback: refuses to drop columns when configured data exists
    await assert.rejects(
      db.query(rollback),
      /Merchant business profile rollback blocked: clear or archive configured values first/
    );
    await db.query('ROLLBACK');

    // 8. Clear configured data to permit rollback
    await db.query(
      `UPDATE public.shop_customer_settings
       SET public_display_name = NULL,
           public_business_hours = NULL,
           public_website_url = NULL,
           public_instagram_url = NULL,
           customer_announcement_text = NULL,
           customer_announcement_enabled = false
       WHERE shop_id = $1`,
      [shopId]
    );

    // 9. Rollback executes cleanly
    await db.query(rollback);

    // Verify columns dropped
    const colCheck = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shop_customer_settings'
         AND column_name IN ('public_display_name', 'public_business_hours', 'public_website_url', 'public_instagram_url', 'customer_announcement_text', 'customer_announcement_enabled')`
    );
    assert.equal(colCheck.rows.length, 0);

    // 10. Post-rollback Preflight passes again
    await db.query(preflight);

  } finally {
    if (db) await db.end().catch(() => {});
    if (pgProcess) {
      await new Promise(resolve => {
        pgProcess.once('close', resolve);
        pgProcess.kill('SIGTERM');
        setTimeout(() => pgProcess.kill('SIGKILL'), 500);
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
