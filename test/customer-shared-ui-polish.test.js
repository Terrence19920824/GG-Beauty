'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sharedCss = fs.readFileSync(path.join(root, 'public/customer-shared.css'), 'utf8');
const bookingHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const memberHtml = fs.readFileSync(path.join(root, 'public/member.html'), 'utf8');
const memberUi = fs.readFileSync(path.join(root, 'public/customer-member-ui.js'), 'utf8');
const theme = require('../public/customer-theme');

test('shared customer UI defines comprehensive spacing, radius, shadow and motion tokens', () => {
  // Spacing tokens
  for (const space of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8']) {
    assert.match(sharedCss, new RegExp(`${space}:`));
  }
  // Radius tokens
  for (const radius of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill']) {
    assert.match(sharedCss, new RegExp(`${radius}:`));
  }
  // Shadows and focus
  assert.match(sharedCss, /--shadow-md:/);
  assert.match(sharedCss, /--shadow-focus:/);
  // Status colors
  assert.match(sharedCss, /--color-success:/);
  assert.match(sharedCss, /--color-error:/);
  // Motion tokens
  assert.match(sharedCss, /--transition-fast:/);
});

test('accessibility foundation enforces visible focus ring and reduced motion support', () => {
  assert.match(sharedCss, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(sharedCss, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  assert.match(sharedCss, /animation-duration:\s*0\.001ms/);
});

test('reusable component classes exist for cards, inputs, buttons, chips, empty, loading and status messages', () => {
  // Card & surface
  assert.match(sharedCss, /\.customer-card/);
  assert.match(sharedCss, /box-shadow:\s*var\(--shadow-md\)/);

  // Input & focus
  assert.match(sharedCss, /input:focus/);
  assert.match(sharedCss, /box-shadow:\s*var\(--shadow-focus\)/);

  // Button primary & secondary
  assert.match(sharedCss, /\.customer-btn/);
  assert.match(sharedCss, /\.customer-btn-secondary|\.secondary/);
  assert.match(sharedCss, /button:disabled/);

  // Chips & Badges
  assert.match(sharedCss, /\.customer-badge/);
  assert.match(sharedCss, /\.brand-badge/);

  // Empty state
  assert.match(sharedCss, /\.empty-state/);
  assert.match(sharedCss, /\.empty-state-icon/);
  assert.match(sharedCss, /\.empty-state-text/);

  // Loading state
  assert.match(sharedCss, /\.loading-state/);
  assert.match(sharedCss, /\.loading-spinner/);

  // Status messages
  assert.match(sharedCss, /\.message\.error/);
  assert.match(sharedCss, /\.message\.success/);
});

test('responsive rules provide mobile-first shell and compact adaptations', () => {
  assert.match(sharedCss, /\.customer-page-shell/);
  assert.match(sharedCss, /max-width:\s*520px/);
  assert.match(sharedCss, /@media\s*\(\s*max-width:\s*380px\s*\)/);
  assert.match(sharedCss, /@media\s*\(\s*min-width:\s*521px\s*\)/);
});

test('customer booking page integrates shared UI stylesheet while preserving theme and business contracts', () => {
  // Stylesheet linked
  assert.match(bookingHtml, /<link rel="stylesheet" href="\/customer-shared\.css">/);

  // Theme foundation script retained
  assert.match(bookingHtml, /<script src="\/customer-theme\.js"><\/script>/);

  // Critical business contracts preserved
  assert.match(bookingHtml, /id="shopBrandName"[^>]+translate="no"[^>]*class="notranslate"/);
  assert.match(bookingHtml, /shopBrandName\.textContent = result\.data\.shopName \|\| customerShopSlug/);
  assert.match(bookingHtml, /id="cartTotals"[^>]+translate="no"/);

  // Brand logo capability preserved
  assert.match(bookingHtml, /id="shopBrandBadge"/);
  assert.match(bookingHtml, /id="shopBrandLogoPlaceholder"/);

  // Bilingual language switch preserved
  assert.match(bookingHtml, />中<\/button><span class="language-divider">｜<\/span><button[^>]*>E<\/button>/);
  assert.match(bookingHtml, /backdrop-filter:blur\(9px\)/);
});

test('customer member page integrates shared UI stylesheet while preserving theme and VIP contracts', () => {
  // Stylesheet linked
  assert.match(memberHtml, /<link rel="stylesheet" href="\/customer-shared\.css">/);

  // Theme foundation script retained
  assert.match(memberHtml, /<script src="\/customer-theme\.js"><\/script>/);

  // VIP card & translation contracts preserved
  assert.match(memberHtml, /class="member-card"/);
  assert.match(memberHtml, /class="logo notranslate"/);
  assert.match(memberHtml, /data-member-theme="premium-black"/);
  for (const id of ['shopName', 'memberName', 'memberCode', 'memberVerifiedPhone']) {
    assert.match(memberHtml, new RegExp(`id="${id}"[^>]+translate="no"`));
  }

  // Member UI integration preserved
  assert.match(memberUi, /root\.ggCustomerTheme\.resolveTheme/);
  assert.match(memberUi, /root\.ggCustomerTheme\.applyTheme/);
  assert.match(memberUi, /panel\.dataset\.shop=state\.shopSlug/);
});

test('shared UI tokens harmonize seamlessly with customer-theme.js tokens', () => {
  const d = theme.DEFAULT_THEME;
  // customer-theme provides theme variables that customer-shared.css consumes
  const cssVars = theme.toCssVariables(d);
  assert.equal(cssVars['--theme-primary'], '#111111');
  assert.equal(cssVars['--theme-bg'], '#f6f6f6');
  assert.equal(cssVars['--theme-surface'], '#ffffff');

  // Multi-merchant isolation still functions identically
  const custom = theme.resolveTheme('merchant-custom', { overrides: { primaryColor: '#2563eb' } });
  assert.equal(custom.primaryColor, '#2563eb');
  assert.equal(theme.resolveTheme('gg-beauty').primaryColor, '#111111');
});
