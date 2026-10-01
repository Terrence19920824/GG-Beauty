'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../public/shared-i18n');
const onboardingUi = require('../public/merchant-onboarding');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/onboarding.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/merchant-onboarding.js'), 'utf8');
const preflight = fs.readFileSync(
  path.join(root, 'migrations/101_merchant_business_defaults_preflight_readonly.sql'),
  'utf8'
);
const schema = fs.readFileSync(
  path.join(root, 'migrations/102_merchant_business_defaults_schema.sql'),
  'utf8'
);
const verification = fs.readFileSync(
  path.join(root, 'migrations/103_merchant_business_defaults_verification_readonly.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'migrations/rollback/102_merchant_business_defaults_rollback.sql'),
  'utf8'
);

test('merchant onboarding UI exposes all required secure states and fields', () => {
  for (const field of [
    'businessName', 'slug', 'locationName', 'country', 'address', 'postalCode',
    'timezone', 'currencyCode', 'locale', 'ownerDisplayName',
    'ownerLoginIdentifier', 'password', 'passwordConfirmation'
  ]) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
  assert.match(html, /type="password"[^>]+autocomplete="new-password"[^>]+minlength="16"[^>]+maxlength="72"/);
  assert.match(html, /class="password-toggle"/);
  assert.match(html, /@media \(max-width: 620px\)/);
  assert.match(html, /button, input, select \{ min-height: 44px; \}/);
  assert.match(js, /if \(submitting\) return;/);
  assert.match(js, /elements\.submit\.disabled = true/);
  assert.match(js, /elements\.password\.value !== elements\.passwordConfirmation\.value/);
  assert.match(js, /new TextEncoder\(\)\.encode\(elements\.password\.value\)\.length/);
  assert.match(js, /pwBytes > 72/);
  assert.deepEqual(Object.keys(onboardingUi.STATE_KEYS).sort(), [
    'ALREADY_CONSUMED', 'EXPIRED', 'INVALID', 'REVOKED'
  ]);
  assert.equal(onboardingUi.errorKeyForCode('DUPLICATE_SLUG'), 'onboardingDuplicateSlug');
  assert.equal(onboardingUi.errorKeyForCode('INVALID_COUNTRY'), 'onboardingInvalidCountry');
  assert.equal(onboardingUi.errorKeyForCode('PASSWORD_TOO_LONG'), 'onboardingPasswordTooLong');
  assert.equal(onboardingUi.errorKeyForCode('PASSWORD_TOO_SHORT'), 'onboardingPasswordTooShort');
  assert.equal(onboardingUi.errorKeyForCode('UNKNOWN'), 'onboardingSafeError');
});

test('onboarding UI uses shared zh/en i18n without user-facing strings in its JS', () => {
  assert.match(html, /src="\/shared-i18n\.js"/);
  for (const key of [
    'onboardingTitle', 'onboardingIntro', 'onboardingBusinessSection',
    'onboardingLocationSection', 'onboardingCountry', 'onboardingCountrySG',
    'onboardingCountryMY', 'onboardingCountryID', 'onboardingCountryCN',
    'onboardingInvalidCountry', 'onboardingPasswordTooShort', 'onboardingPasswordTooLong',
    'onboardingOwnerSection', 'onboardingPasswordHelp',
    'onboardingInvalidTitle', 'onboardingExpiredTitle', 'onboardingRevokedTitle',
    'onboardingConsumedTitle', 'onboardingSuccessTitle', 'onboardingSafeError'
  ]) {
    assert.notEqual(i18n.t(key, 'zh-CN'), key);
    assert.notEqual(i18n.t(key, 'en'), key);
    assert.match(html + js, new RegExp(key));
  }
  assert.doesNotMatch(js, /[\u3400-\u9fff]/);
  assert.match(js, /i18n\.getStoredLocale/);
  assert.match(js, /i18n\.setLocale/);
  assert.match(js, /document\.documentElement\.lang = locale/);
});

test('raw invitation token is kept out of storage, URL history, and response rendering', () => {
  assert.match(js, /url\.searchParams\.get\('token'\)/);
  assert.match(js, /history\.replaceState\(null, '', url\.pathname\)/);
  assert.doesNotMatch(js, /localStorage\.(?:setItem|getItem)[^\n]*(?:token|password)/i);
  assert.doesNotMatch(js, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(html, /name="token"|id="token"/);
  assert.match(html, /meta name="referrer" content="no-referrer"/);
});

test('merchant currency and locale migration is additive and rollback fails closed on onboarding history', () => {
  assert.match(preflight, /BEGIN TRANSACTION READ ONLY/i);
  assert.doesNotMatch(preflight, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS country_code TEXT NULL/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS currency_code TEXT NULL/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS default_locale TEXT NULL/);
  assert.match(schema, /country_code ~ '\^\[A-Z\]\{2\}\$'/);
  assert.match(schema, /currency_code ~ '\^\[A-Z\]\{3\}\$'/);
  assert.doesNotMatch(schema, /DEFAULT\s+'(?:SGD|Asia\/Singapore|zh-CN|en|SG)'/i);
  assert.match(verification, /BEGIN TRANSACTION READ ONLY/i);
  assert.doesNotMatch(verification, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(verification, /c\.convalidated = TRUE/);
  assert.match(verification, /pg_get_constraintdef/);
  assert.match(rollback, /LOCK TABLE public\.merchant_onboarding_invitations IN SHARE MODE/i);
  assert.match(rollback, /LOCK TABLE public\.shop_customer_settings IN SHARE MODE/i);
  assert.match(rollback, /status = 'consumed'/);
  assert.match(rollback, /resulting_shop_id IS NOT NULL/);
  assert.match(rollback, /onboarding history exists; use forward repair instead/i);
  assert.match(rollback, /shop_customer_settings contains populated business defaults/i);
  assert.doesNotMatch(rollback, /\b(?:DELETE\s+FROM|TRUNCATE)\b/i);
});
