'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const myBookingsJs = fs.readFileSync(path.join(root, 'public/customer-my-bookings.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const i18n = require('../public/shared-i18n');
const shopContext = require('../public/customer-shop-context');

test('9. customer My Bookings has no "gg-beauty" fallback', () => {
  assert.doesNotMatch(
    myBookingsJs,
    /['"]gg-beauty['"]/,
    'public/customer-my-bookings.js must not contain hardcoded "gg-beauty" fallback'
  );
});

test('10. missing merchant context fails gracefully without querying backend', async () => {
  const elements = {
    shopBrandHeading: { textContent: '' },
    backLink: { href: '' },
    phoneLookupForm: { hidden: false },
    bookingLookupHelp: { textContent: '' },
    queryMessage: { className: '', textContent: '' },
    queryBtn: { disabled: false, addEventListener: () => {} },
    queryPhone: { value: '91234567', addEventListener: () => {} },
    countryCode: { value: '+65', innerHTML: '', appendChild: () => {} },
    bookingsSection: { hidden: false, innerHTML: '' },
    languageZh: { disabled: false, addEventListener: () => {} },
    languageEn: { disabled: false, addEventListener: () => {} },
    languageSwitchBtn: { setAttribute: () => {}, addEventListener: () => {} }
  };

  let fetchCalls = [];

  const mockWindow = {
    document: {
      readyState: 'loading',
      documentElement: { lang: 'zh-CN' },
      getElementById: id => elements[id] || null,
      querySelectorAll: () => [],
      createElement: () => ({ value: '', textContent: '', selected: false }),
      addEventListener: () => {}
    },
    location: {
      pathname: '/my-bookings.html',
      search: '',
      hostname: 'localhost'
    },
    localStorage: {
      getItem: () => 'zh-CN',
      setItem: () => {}
    },
    URLSearchParams,
    URL,
    Intl,
    JSON,
    Date,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: false };
    },
    ggI18n: i18n,
    ggCustomerShopContext: shopContext
  };

  const context = vm.createContext(mockWindow);
  vm.runInContext(myBookingsJs, context);

  // Trigger init manually in context
  await mockWindow.ggCustomerMyBookings.init();

  // Assertions for missing shop context state:
  assert.equal(elements.shopBrandHeading.textContent, '', 'Brand heading must be empty');
  assert.equal(elements.phoneLookupForm.hidden, true, 'Phone lookup form must be hidden when shop context is missing');
  assert.equal(elements.backLink.href, '/', 'Back link must default to root');
  assert.equal(elements.queryMessage.className, 'message error');
  assert.ok(
    elements.queryMessage.textContent.includes('未指定店铺'),
    'Query message must show shop context missing error'
  );
  assert.ok(
    elements.bookingLookupHelp.textContent.includes('未指定店铺'),
    'Help text must reflect missing shop context'
  );

  // Zero fetch requests should have been made
  assert.equal(fetchCalls.length, 0, 'Must NOT query backend when shop context is missing');

  // Attempting executeQuery manually without shop context must be blocked
  await mockWindow.ggCustomerMyBookings.executeQuery();
  assert.equal(fetchCalls.length, 0, 'executeQuery must reject without network request when shop context is missing');
});

test('11. Shop A and another tenant cannot cross-route through fallback', async () => {
  const elements = {
    shopBrandHeading: { textContent: '' },
    backLink: { href: '' },
    phoneLookupForm: { hidden: false },
    bookingLookupHelp: { textContent: '' },
    queryMessage: { className: '', textContent: '' },
    queryBtn: { disabled: false, addEventListener: () => {} },
    queryPhone: { value: '98765432', addEventListener: () => {} },
    countryCode: { value: '+65', innerHTML: '', appendChild: () => {} },
    bookingsSection: { hidden: false, innerHTML: '' },
    languageZh: { disabled: false, addEventListener: () => {} },
    languageEn: { disabled: false, addEventListener: () => {} },
    languageSwitchBtn: { setAttribute: () => {}, addEventListener: () => {} }
  };

  let fetchCalls = [];

  const mockWindow = {
    document: {
      readyState: 'loading',
      documentElement: { lang: 'zh-CN' },
      getElementById: id => elements[id] || null,
      querySelectorAll: () => [],
      createElement: () => ({ value: '', textContent: '', selected: false }),
      addEventListener: () => {}
    },
    location: {
      pathname: '/my-bookings.html',
      search: '?shop=shop-b',
      hostname: 'localhost'
    },
    localStorage: {
      getItem: () => 'zh-CN',
      setItem: () => {}
    },
    URLSearchParams,
    URL,
    Intl,
    JSON,
    Date,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { authenticated: false, appointments: [] }
        })
      };
    },
    ggI18n: i18n,
    ggCustomerShopContext: shopContext
  };

  const context = vm.createContext(mockWindow);
  vm.runInContext(myBookingsJs, context);

  await mockWindow.ggCustomerMyBookings.init();

  // Tenant shop-b correctly established
  assert.equal(elements.shopBrandHeading.textContent, 'shop-b', 'Brand heading must match shop-b');
  assert.equal(elements.phoneLookupForm.hidden, false, 'Form must be active for valid shop');
  assert.equal(elements.backLink.href, '/?shop=shop-b', 'Back link must preserve shop-b');

  // Verify fetch payload sent shop-b and never gg-beauty
  assert.equal(fetchCalls.length, 1, 'Initial session check must be made');
  const sessionCheckBody = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sessionCheckBody.shopSlug, 'shop-b', 'Request body must be scoped to shop-b');
  assert.notEqual(sessionCheckBody.shopSlug, 'gg-beauty', 'Must NOT leak to gg-beauty');

  // Execute query with phone
  await mockWindow.ggCustomerMyBookings.executeQuery();
  assert.equal(fetchCalls.length, 2);
  const queryBody = JSON.parse(fetchCalls[1].opts.body);
  assert.equal(queryBody.shopSlug, 'shop-b');
  assert.equal(queryBody.phone, '98765432');
});

test('Customer booking flow preserves merchant context in links to my-bookings', () => {
  assert.match(
    indexHtml,
    /myBookingsEntry\.href = `\/my-bookings\.html\?shop=\$\{encodeURIComponent\(customerShopSlug\)\}`/,
    'Navigation link from booking page to my-bookings must preserve shopSlug'
  );
  assert.match(
    indexHtml,
    /myBookingsBtn\.href = `\/my-bookings\.html\?shop=\$\{encodeURIComponent\(customerShopSlug\)\}/,
    'Post-booking success button must preserve shopSlug in my-bookings link'
  );
});

test('Bilingual purity for shopContextMissing string', () => {
  const zh = i18n.t('shopContextMissing', 'zh-CN');
  const en = i18n.t('shopContextMissing', 'en');

  assert.ok(zh && zh.length > 0);
  assert.ok(en && en.length > 0);

  // Chinese string must NOT contain English alphabet letters
  assert.doesNotMatch(zh, /[a-zA-Z]/, 'Chinese translation must not leak English letters');

  // English string must NOT contain Chinese characters
  assert.doesNotMatch(en, /[\u3400-\u9fff]/, 'English translation must not leak Chinese characters');
});
