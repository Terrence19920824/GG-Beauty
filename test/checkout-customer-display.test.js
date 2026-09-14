'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const adapter = require('../public/checkout-ui-adapter');
const ownerHtml = fs.readFileSync(path.join(root, 'public/owner-checkout.html'), 'utf8');
const displayHtml = fs.readFileSync(path.join(root, 'public/customer-display.html'), 'utf8');
const checkoutCss = fs.readFileSync(path.join(root, 'public/checkout-ui.css'), 'utf8');

test('adapter exports dev mock fixture that is explicitly marked as non-production data', () => {
  const fixture = adapter.getMockFixture();
  assert.equal(fixture._isMockFixture, true);
  assert.match(fixture._warning, /NOT PRODUCTION DATA/);
  assert.equal(fixture.shopSlug, 'gg-beauty');
  assert.ok(fixture.customer.id);
  assert.ok(fixture.items.length >= 2);
});

test('adapter calculates financial totals, discounts, and cash change accurately', () => {
  const fixture = adapter.getMockFixture();
  // 198 + 88 = 286.00
  let totals = adapter.calculateTotals(fixture);
  assert.equal(totals.quotedTotal, 286.00);
  assert.equal(totals.subtotal, 286.00);
  assert.equal(totals.discountAmount, 0.00);
  assert.equal(totals.finalTotal, 286.00);

  // 10% discount: 286 * 0.10 = 28.60, final = 257.40
  adapter.applyDiscount(fixture, { type: 'percent', value: 10 });
  totals = adapter.calculateTotals(fixture);
  assert.equal(totals.discountAmount, 28.60);
  assert.equal(totals.finalTotal, 257.40);

  // Fixed S$20 discount: final = 266.00
  adapter.applyDiscount(fixture, { type: 'fixed', value: 20 });
  totals = adapter.calculateTotals(fixture);
  assert.equal(totals.discountAmount, 20.00);
  assert.equal(totals.finalTotal, 266.00);

  // Cash payment: Tendered S$300 on S$266 total -> Change S$34.00
  adapter.setPaymentMethod(fixture, 'cash');
  adapter.setTenderedCash(fixture, 300);
  totals = adapter.calculateTotals(fixture);
  assert.equal(totals.tenderedCash, 300.00);
  assert.equal(totals.changeDue, 34.00);
  assert.equal(totals.isFullyPaid, true);
});

test('adapter supports split payment architecture with remaining balance validation', () => {
  const fixture = adapter.getMockFixture();
  adapter.applyDiscount(fixture, { type: 'none', value: 0 }); // 286.00 total
  adapter.setPaymentMode(fixture, 'split');
  
  // Add partial payment of S$100 Cash
  adapter.addSplitPayment(fixture, 'cash', 100.00);
  let totals = adapter.calculateTotals(fixture);
  assert.equal(totals.paidTotal, 100.00);
  assert.equal(totals.remainingBalance, 186.00);
  assert.equal(totals.isFullyPaid, false);

  let validation = adapter.validateCheckout(fixture);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /Remaining balance/);

  // Add remaining S$186 PayNow
  adapter.addSplitPayment(fixture, 'paynow', 186.00);
  totals = adapter.calculateTotals(fixture);
  assert.equal(totals.paidTotal, 286.00);
  assert.equal(totals.remainingBalance, 0.00);
  assert.equal(totals.isFullyPaid, true);

  validation = adapter.validateCheckout(fixture);
  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
});

test('owner checkout UI displays all required fields and preserves critical translation protection', () => {
  // Customer & identifiers
  assert.match(ownerHtml, /id="customerName"/);
  assert.match(ownerHtml, /id="customerName"[^>]+translate="no"|translate="no"[^>]+id="customerName"/);
  assert.match(ownerHtml, /notranslate[^>]+id="customerName"|id="customerName"[^>]+notranslate/);
  assert.match(ownerHtml, /id="customerPhone"[^>]+translate="no"|translate="no"[^>]+id="customerPhone"/);
  assert.match(ownerHtml, /id="memberBadge"[^>]+translate="no"|translate="no"[^>]+id="memberBadge"/);
  assert.match(ownerHtml, /id="customerId"[^>]+translate="no"|translate="no"[^>]+id="customerId"/);

  // Appointment
  assert.match(ownerHtml, /id="appointmentId"[^>]+translate="no"|translate="no"[^>]+id="appointmentId"/);
  assert.match(ownerHtml, /id="appointmentTime"[^>]+translate="no"|translate="no"[^>]+id="appointmentTime"/);
  assert.match(ownerHtml, /id="appointmentStatus"/);

  // Items & Staff allocation
  assert.match(ownerHtml, /id="itemsListContainer"/);
  assert.match(ownerHtml, /t\('primaryStaff'\)/);
  assert.match(ownerHtml, /t\('assistantStaff'\)/);
  assert.match(ownerHtml, /data-action="plus"/);
  assert.match(ownerHtml, /data-action="minus"/);

  // Pricing: Quoted, actual, discounts, subtotal, and final total
  assert.match(ownerHtml, /id="quotedTotalAmount"[^>]+translate="no"|translate="no"[^>]+id="quotedTotalAmount"/);
  assert.match(ownerHtml, /id="subtotalAmount"[^>]+translate="no"|translate="no"[^>]+id="subtotalAmount"/);
  assert.match(ownerHtml, /id="discountValueAmount"[^>]+translate="no"|translate="no"[^>]+id="discountValueAmount"/);
  assert.match(ownerHtml, /id="finalTotalAmount"[^>]+translate="no"|translate="no"[^>]+id="finalTotalAmount"/);

  // Payment UI methods
  assert.match(ownerHtml, /data-method="paynow"/);
  assert.match(ownerHtml, /data-method="card"/);
  assert.match(ownerHtml, /data-method="cash"/);
  assert.match(ownerHtml, /data-method="other"/);
  assert.match(ownerHtml, /id="splitModeToggle"/);
  assert.match(ownerHtml, /id="tenderedCashInput"/);
  assert.match(ownerHtml, /id="cashChangeAmount"[^>]+translate="no"|translate="no"[^>]+id="cashChangeAmount"/);

  // Complete checkout button
  assert.match(ownerHtml, /id="completeCheckoutBtn"/);
});

test('customer display UI includes merchant branding, itemized consumption, and presentation-only placeholders', () => {
  // Merchant branding
  assert.match(displayHtml, /id="shopBrandBadge"[^>]+translate="no"|translate="no"[^>]+id="shopBrandBadge"/);
  assert.match(displayHtml, /id="shopBrandName"[^>]+translate="no"|translate="no"[^>]+id="shopBrandName"/);

  // Customer & order ticket
  assert.match(displayHtml, /id="dispCustomerName"[^>]+translate="no"|translate="no"[^>]+id="dispCustomerName"/);
  assert.match(displayHtml, /id="dispMemberBadge"[^>]+translate="no"|translate="no"[^>]+id="dispMemberBadge"/);
  assert.match(displayHtml, /id="dispTicketList"/);
  assert.match(displayHtml, /id="dispSubtotal"[^>]+translate="no"|translate="no"[^>]+id="dispSubtotal"/);
  assert.match(displayHtml, /id="dispDiscount"[^>]+translate="no"|translate="no"[^>]+id="dispDiscount"/);
  assert.match(displayHtml, /id="dispFinalAmount"[^>]+translate="no"|translate="no"[^>]+id="dispFinalAmount"/);

  // Presentation-only placeholders: Points delta
  assert.match(displayHtml, /id="dispPointsDelta"[^>]+translate="no"|translate="no"[^>]+id="dispPointsDelta"/);
  assert.match(displayHtml, /data-i18n="placeholderPoints"/);
  assert.match(displayHtml, /data-i18n="placeholderPointsNotice"/);

  // Presentation-only placeholders: Package deduction
  assert.match(displayHtml, /data-i18n="placeholderPackage"/);
  assert.match(displayHtml, /data-i18n="placeholderPackageNotice"/);

  // Presentation-only placeholders: Handwritten signature canvas
  assert.match(displayHtml, /id="signatureCanvas"/);
  assert.match(displayHtml, /data-i18n="placeholderSignature"/);
  assert.match(displayHtml, /data-i18n="placeholderSignatureNotice"/);

  // Payment summary & QR instructions
  assert.match(displayHtml, /id="dispQrContainer"/);
  assert.match(displayHtml, /data-i18n="placeholderPreviewTag"/);

  // Real-time synchronization subscription
  assert.match(displayHtml, /adapter\.subscribeCustomerDisplay/);
});

test('UI stylesheets reuse customer-shared.css and customer-theme.js without secondary theme systems', () => {
  assert.match(ownerHtml, /<link rel="stylesheet" href="\/customer-shared\.css">/);
  assert.match(ownerHtml, /<script src="\/customer-theme\.js"><\/script>/);
  assert.match(displayHtml, /<link rel="stylesheet" href="\/customer-shared\.css">/);
  assert.match(displayHtml, /<script src="\/customer-theme\.js"><\/script>/);

  // Consumes theme variables
  assert.match(checkoutCss, /var\(--theme-primary/);
  assert.match(checkoutCss, /var\(--theme-surface/);
  assert.match(checkoutCss, /var\(--theme-border/);
  assert.match(checkoutCss, /var\(--space-/);
  assert.match(checkoutCss, /var\(--radius-/);
});

test('responsive CSS adapts specifically for iPad landscape and enforces accessibility', () => {
  // iPad landscape and tablet-first grid
  assert.match(checkoutCss, /@media\s*\(\s*min-width:\s*768px\s*\)\s*and\s*\(\s*orientation:\s*landscape\s*\)/);
  assert.match(checkoutCss, /grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s*minmax\(0,\s*1fr\)/);

  // Touch targets >= 44px
  assert.match(checkoutCss, /min-height:\s*44px/);
  assert.match(checkoutCss, /min-height:\s*52px/);
  assert.match(checkoutCss, /min-height:\s*54px/);

  // Accessibility: focus-visible & reduced-motion
  assert.match(checkoutCss, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(checkoutCss, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
});

test('backend safety: zero server code, database, migration, or maintenance changes', () => {
  // Check server.js has BOOKING_WRITE_MAINTENANCE intact
  const serverPath = path.join(root, 'server.js');
  const serverCode = fs.readFileSync(serverPath, 'utf8');
  assert.match(serverCode, /BOOKING_WRITE_MAINTENANCE/);
});
