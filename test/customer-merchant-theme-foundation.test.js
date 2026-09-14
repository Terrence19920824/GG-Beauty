'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const theme = require('../public/customer-theme');

const root = path.join(__dirname, '..');
const bookingHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const memberHtml = fs.readFileSync(path.join(root, 'public/member.html'), 'utf8');
const memberUi = fs.readFileSync(path.join(root, 'public/customer-member-ui.js'), 'utf8');

test('theme foundation defines complete tokens with GG-Beauty baseline visual defaults', () => {
  const d = theme.DEFAULT_THEME;
  assert.equal(d.shopSlug, 'gg-beauty');
  assert.equal(d.brandName, 'GG-Beauty');
  assert.equal(d.logoText, 'GG');
  assert.equal(d.primaryColor, '#111111');
  assert.equal(d.primaryHover, '#2b2b2b');
  assert.equal(d.primaryContrast, '#ffffff');
  assert.equal(d.accentColor, '#111111');
  assert.equal(d.backgroundColor, '#f6f6f6');
  assert.equal(d.surfaceColor, '#ffffff');
  assert.equal(d.surfaceSubtle, '#eeeeee');
  assert.equal(d.textColor, '#222222');
  assert.equal(d.textMuted, '#777777');
  assert.equal(d.borderColor, '#dddddd');
  assert.equal(d.cardGradientStart, '#050505');
  assert.equal(d.cardGradientEnd, '#252525');
  assert.equal(d.cardTextColor, '#ffffff');
  assert.equal(d.cardMutedColor, '#bbbbbb');
});

test('theme token normalization sanitizes invalid colors, scripts, and derives logo initials', () => {
  // Invalid/malicious color values must fallback safely to base
  assert.equal(theme.isValidColor('#111'), true);
  assert.equal(theme.isValidColor('#112233'), true);
  assert.equal(theme.isValidColor('rgb(255, 0, 128)'), true);
  assert.equal(theme.isValidColor('red; background: url(evil.com)'), false);
  assert.equal(theme.isValidColor('<script>'), false);

  const normalized = theme.normalizeThemeTokens({
    brandName: '  Lotus Wellness & Spa  ',
    primaryColor: 'invalid-color-injection; color:red',
    backgroundColor: '#ffffff',
    logoText: 'LOTUS', // Should be capped to 4 chars
    logoUrl: 'javascript:alert(1)' // Dangerous URL scheme rejected
  });

  assert.equal(normalized.brandName, 'Lotus Wellness & Spa');
  assert.equal(normalized.primaryColor, theme.DEFAULT_THEME.primaryColor); // fell back
  assert.equal(normalized.backgroundColor, '#ffffff');
  assert.equal(normalized.logoText, 'LOTU');
  assert.equal(normalized.logoUrl, ''); // sanitized to empty

  // Initials derivation
  assert.equal(theme.deriveInitials('GG-Beauty'), 'GG');
  assert.equal(theme.deriveInitials('Lotus Spa'), 'LS');
  assert.equal(theme.deriveInitials('Aura'), 'AU');
});

test('shop themes are strictly scoped and isolated between merchants', () => {
  theme.clearRegistry();

  theme.registerShopTheme('merchant-rose', {
    brandName: 'Rose Boutique',
    primaryColor: '#b76e79',
    backgroundColor: '#faf7f7'
  });

  theme.registerShopTheme('merchant-emerald', {
    brandName: 'Emerald Salon',
    primaryColor: '#1b493f',
    backgroundColor: '#f4f7f5'
  });

  const rose = theme.resolveTheme('merchant-rose');
  const emerald = theme.resolveTheme('merchant-emerald');
  const defaultGg = theme.resolveTheme('gg-beauty');
  const unknown = theme.resolveTheme('unregistered-shop', { shopName: 'Custom Shop' });

  // Verify Rose
  assert.equal(rose.shopSlug, 'merchant-rose');
  assert.equal(rose.brandName, 'Rose Boutique');
  assert.equal(rose.primaryColor, '#b76e79');
  assert.equal(rose.backgroundColor, '#faf7f7');

  // Verify Emerald is isolated from Rose
  assert.equal(emerald.shopSlug, 'merchant-emerald');
  assert.equal(emerald.brandName, 'Emerald Salon');
  assert.equal(emerald.primaryColor, '#1b493f');
  assert.equal(emerald.backgroundColor, '#f4f7f5');

  // Verify default GG-Beauty is intact
  assert.equal(defaultGg.shopSlug, 'gg-beauty');
  assert.equal(defaultGg.primaryColor, '#111111');
  assert.equal(defaultGg.backgroundColor, '#f6f6f6');

  // Verify unknown shop resolves cleanly with its provided shopName
  assert.equal(unknown.shopSlug, 'unregistered-shop');
  assert.equal(unknown.brandName, 'Custom Shop');
  assert.equal(unknown.logoText, 'CS');
  assert.equal(unknown.primaryColor, '#111111');
});

test('toCssVariables produces consistent theme tokens map for style consumption', () => {
  const custom = theme.normalizeThemeTokens({
    primaryColor: '#3b82f6',
    surfaceColor: '#ffffff',
    textColor: '#1e293b'
  });
  const vars = theme.toCssVariables(custom);

  assert.equal(vars['--theme-primary'], '#3b82f6');
  assert.equal(vars['--theme-surface'], '#ffffff');
  assert.equal(vars['--theme-text'], '#1e293b');
  assert.ok(vars['--theme-bg']);
  assert.ok(vars['--theme-border']);
  assert.ok(vars['--theme-card-start']);
  assert.ok(vars['--theme-card-end']);
});

test('applyTheme sets scoping attributes and CSS variables on target element', () => {
  const setProperties = new Map();
  const attributes = new Map();
  const fakeElement = {
    style: {
      setProperty: (key, val) => setProperties.set(key, val)
    },
    dataset: {},
    setAttribute: (key, val) => attributes.set(key, val)
  };

  const tokens = theme.resolveTheme('merchant-rose', {
    overrides: { primaryColor: '#e11d48', themeKey: 'rose-theme' }
  });
  theme.applyTheme(fakeElement, tokens);

  assert.equal(setProperties.get('--theme-primary'), '#e11d48');
  assert.equal(fakeElement.dataset.shop, 'merchant-rose');
  assert.equal(fakeElement.dataset.theme, 'rose-theme');
  assert.equal(fakeElement.dataset.themeApplied, 'true');
});

test('customer booking page (index.html) integrates theme mechanism while protecting critical business contracts', () => {
  // 1. Theme script is loaded
  assert.match(bookingHtml, /<script src="\/customer-theme\.js"><\/script>/);

  // 2. CSS variables are defined in :root with fallbacks
  assert.match(bookingHtml, /:root\s*\{[^}]*--theme-primary:\s*#111;/);
  assert.match(bookingHtml, /--theme-bg:\s*#f6f6f6;/);
  assert.match(bookingHtml, /--theme-surface:\s*#fff;/);
  assert.match(bookingHtml, /background:\s*var\(--theme-bg,\s*#f6f6f6\);/);

  // 3. Critical business contracts preserved
  assert.match(bookingHtml, /id="shopBrandName"[^>]+translate="no"[^>]*class="notranslate"/);
  assert.match(bookingHtml, /shopBrandName\.textContent = result\.data\.shopName \|\| customerShopSlug/);
  assert.match(bookingHtml, /id="cartTotals"[^>]+translate="no"/);

  // 4. Logo/hero placeholder capability
  assert.match(bookingHtml, /id="shopBrandBadge"/);
  assert.match(bookingHtml, /id="shopBrandLogoPlaceholder"/);

  // 5. Theme application hook in loadCustomerShopContext
  assert.match(bookingHtml, /globalThis\.ggCustomerTheme\.resolveTheme\(customerShopSlug/);
  assert.match(bookingHtml, /globalThis\.ggCustomerTheme\.applyTheme\(document\.documentElement/);

  // 6. Language switcher and backdrop blur preserved
  assert.match(bookingHtml, />中<\/button><span class="language-divider">｜<\/span><button[^>]*>E<\/button>/);
  assert.match(bookingHtml, /backdrop-filter:blur\(9px\)/);
});

test('customer member page (member.html & customer-member-ui.js) shares theme mechanism and maintains isolation', () => {
  // 1. Member HTML includes shared theme script
  assert.match(memberHtml, /<script src="\/customer-theme\.js"><\/script>/);

  // 2. Member HTML uses theme CSS variables for background, surface, buttons, and member card
  assert.match(memberHtml, /--theme-primary:#111/);
  assert.match(memberHtml, /--member-card-start:var\(--theme-card-start,#050505\)/);
  assert.match(memberHtml, /background:var\(--theme-bg,#f5f5f5\)/);
  assert.match(memberHtml, /background:var\(--theme-primary,#111\)/);

  // 3. Critical business translation and session attributes preserved
  for (const id of ['shopName', 'memberName', 'memberCode', 'memberVerifiedPhone']) {
    assert.match(memberHtml, new RegExp(`id="${id}"[^>]+translate="no"`));
  }
  assert.match(memberHtml, /data-member-theme="premium-black"/);
  assert.match(memberHtml, /class="logo notranslate"/);

  // 4. customer-member-ui.js hooks theme application in init and renderMember
  assert.match(memberUi, /root\.ggCustomerTheme\.resolveTheme/);
  assert.match(memberUi, /root\.ggCustomerTheme\.applyTheme/);
  assert.match(memberUi, /panel\.dataset\.shop=state\.shopSlug/);
});
