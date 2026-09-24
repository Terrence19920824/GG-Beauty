'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contact = require('../lib/merchant-contact');
const { OWNER_MERCHANT_CONTACT_WRITE_ROLES } = require('../server');

test('merchant contact validates only supported normalized public fields', () => {
  assert.deepEqual(contact.validateSettings({ contactPhone: '+65 8123 4567' }).values, { public_contact_phone: '+6581234567' });
  assert.equal(contact.validateSettings({ whatsAppPhone: 'not-a-phone' }).error, 'INVALID_MERCHANT_PHONE');
  assert.equal(contact.validateSettings({ shopId: 'attacker' }).error, 'INVALID_MERCHANT_CONTACT_SETTINGS');
});

test('public presentation only exposes intended contact fields and a WhatsApp deep link', () => {
  assert.deepEqual(contact.publicPresentation({ shop_name: 'Shop', public_contact_phone: '+6512345678', public_whatsapp_phone: '+6581234567' }), {
    shopName: 'Shop', contactPhone: '+6512345678', whatsAppUrl: 'https://wa.me/6581234567'
  });
});

test('owner, manager, and admin can write merchant contact while front desk is rejected by the role allow-list', () => {
  for (const role of ['owner', 'manager', 'admin']) assert.ok(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes(role));
  assert.equal(OWNER_MERCHANT_CONTACT_WRITE_ROLES.includes('front_desk'), false);
});

test('PWA book route validates its path parameter and serves the public booking document without exposing a filesystem path', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/book\/:shopSlug'/);
  assert.match(server, /res\.sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\)/);
  assert.match(server, /return res\.status\(404\)\.end\(\)/);
  assert.doesNotMatch(server, /res\.sendFile\([^\n]*req\.params/);
});

test('rollback first and second runs are safe while configured contact data remains fail-closed', () => {
  const rollback = fs.readFileSync(path.join(__dirname, '..', 'migrations/rollback/055_merchant_contact_schema.sql'), 'utf8');
  assert.match(rollback, /contact_columns_exist BOOLEAN/);
  assert.match(rollback, /IF contact_columns_exist THEN[\s\S]*EXECUTE 'SELECT EXISTS/);
  assert.match(rollback, /COALESCE\(has_configured_contact, FALSE\)/);
  assert.match(rollback, /DROP COLUMN IF EXISTS public_contact_phone/);
  assert.match(rollback, /DROP COLUMN IF EXISTS public_whatsapp_phone/);
});

test('merchant contact migrations require E.164 values with one escaped plus and verify those exact constraints', () => {
  const migrations = path.join(__dirname, '..', 'migrations');
  const schema = fs.readFileSync(path.join(migrations, '055_merchant_contact_schema.sql'), 'utf8');
  const verification = fs.readFileSync(path.join(migrations, '056_merchant_contact_verification_readonly.sql'), 'utf8');
  const expectedPattern = '^\\+[1-9][0-9]{6,14}$';
  const incorrectDoubleEscapedPattern = '^\\\\+[1-9][0-9]{6,14}$';
  const e164Phone = /^\+[1-9][0-9]{6,14}$/;

  assert.equal(e164Phone.test('+6581234567'), true);
  assert.equal(schema.includes("'" + expectedPattern + "'"), true);
  assert.equal(schema.includes("'" + incorrectDoubleEscapedPattern + "'"), false);
  assert.equal(verification.includes("position('" + expectedPattern + "' in pg_get_constraintdef(oid)) > 0"), true);
  assert.equal(verification.includes("'" + expectedPattern + "'"), true);
  assert.equal(verification.includes("'" + incorrectDoubleEscapedPattern + "'"), false);
});

test('PWA and merchant contact surfaces are present without introducing self-service rescheduling', () => {
  const root = path.join(__dirname, '..');
  const booking = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const member = fs.readFileSync(path.join(root, 'public/member.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const memberUi = fs.readFileSync(path.join(root, 'public/customer-member-ui.js'), 'utf8');
  const bar = fs.readFileSync(path.join(root, 'public/merchant-contact-bar.js'), 'utf8');
  const staticManifest = fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/customer-shared.css'), 'utf8');
  const migrations = ['054_merchant_contact_preflight_readonly.sql', '055_merchant_contact_schema.sql', '056_merchant_contact_verification_readonly.sql'].map(file => fs.readFileSync(path.join(root, 'migrations', file), 'utf8')).join('\n');
  const rollback = fs.readFileSync(path.join(root, 'migrations/rollback/055_merchant_contact_schema.sql'), 'utf8');
  assert.match(booking, /id="pwaManifest" rel="manifest"/);
  assert.match(server, /start_url: `\/book\/\$\{encodeURIComponent\(shopSlug\)\}\?pwa=1`/);
  assert.match(booking, /manifest\.webmanifest\?shop=\$\{encodeURIComponent\(customerShopSlug\)\}/);
  assert.match(memberUi, /manifest\.webmanifest\?shop=\$\{encodeURIComponent\(candidate\)\}/);
  assert.doesNotMatch(staticManifest, /"start_url":"\/\?pwa=1"/);
  assert.match(booking, /apple-mobile-web-app-capable/);
  assert.match(booking, /merchantContactBar/);
  assert.match(member, /merchantContactBar/);
  assert.match(admin, /merchantContactPhone/);
  assert.match(server, /app\.patch\('\/api\/owner\/merchant-contact'/);
  assert.match(server, /requireOwnerAuth, requireOwnerRole\(OWNER_MERCHANT_CONTACT_WRITE_ROLES\)/);
  assert.match(server, /setPublicBookingNoCacheHeaders\(res\);/);
  assert.match(css, /merchant-contact-action[^}]*min-height:44px/);
  assert.equal((booking.match(/id="merchantContactBar"/g) || []).length, 1);
  assert.match(bar, /merchantContactAria/);
  assert.match(admin, /data-i18n="merchantContactSettings"/);
  assert.match(migrations, /ADD COLUMN IF NOT EXISTS/);
  assert.match(migrations, /pg_constraint/);
  assert.match(rollback, /information_schema\.columns/);
  assert.doesNotMatch(booking, /reschedule|改期/i);
});
