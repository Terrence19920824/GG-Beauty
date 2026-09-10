'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const i18n = require('../public/shared-i18n');
const shopContext = require('../public/customer-shop-context');
const categoryFlow = require('../public/customer-category-flow');

const customerHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

const createCustomerContext = () => {
  const elements = new Map();
  const makeElement = () => ({
    value: '', innerHTML: '', textContent: '', disabled: false, lang: '',
    options: [], dataset: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, appendChild(child) { this.options.push(child); }
  });
  for (const id of ['date', 'dateDisplay', 'service', 'times', 'message', 'languageZh', 'languageEn', 'submitBtn', 'customerName', 'phone', 'email', 'categoryStep', 'categoryGrid', 'bookingStep', 'contactStep', 'cartPanel', 'cartItems', 'cartTotals', 'confirmationSummary', 'addServiceBtn', 'addAnotherBtn']) {
    elements.set(id, makeElement());
  }
  const fetchUrls = [];
  const context = vm.createContext({
    console,
    encodeURIComponent,
    fetch: async url => {
      fetchUrls.push(String(url));
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    },
    globalThis: {
      ggI18n: i18n,
      ggCustomerShopContext: shopContext,
      ggCustomerCategoryFlow: categoryFlow,
      ggCustomerMultiServiceCart: require('../public/customer-multi-service-cart'),
      location: { hostname: 'localhost', pathname: '/', search: '' }
    },
    localStorage: { getItem: () => 'zh-CN', setItem() {} },
    navigator: { languages: ['zh-CN'] },
    document: {
      documentElement: { lang: 'zh-CN' },
      getElementById: id => elements.get(id),
      querySelectorAll: () => [],
      createElement: () => makeElement()
    }
  });
  const scripts = [...customerHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.at(-1)[1], context);
  return { context, elements, fetchUrls };
};

test('customer appointment date uses locale-aware shared formatting', () => {
  assert.equal(i18n.formatDate('2026-09-09', 'zh-CN'), '2026年9月9日');
  assert.equal(i18n.formatDate('2026-09-09', 'en'), 'Sep 9, 2026');
  assert.equal(i18n.formatDate('invalid', 'en'), '');
  assert.match(customerHtml, /localeApi\.formatDate\(dateInput\.value, currentLocale\)/);
  assert.match(customerHtml, /localeApi\.formatDate\(date, currentLocale\)/);
});

test('customer empty-time message comes from the bilingual shared dictionary', () => {
  assert.equal(i18n.t('noTimes', 'zh-CN'), '当天暂无可预约时间');
  assert.equal(i18n.t('noTimes', 'en'), 'No available times on this date.');
  assert.match(customerHtml, /customerT\('noTimes'\)/);
  assert.doesNotMatch(customerHtml, /当天暂无可预约时间/);
});

test('customer date presentation preserves canonical ISO booking value', () => {
  assert.match(customerHtml, /email,\s*date,\s*startAt: selectedSlot\.startAt/);
  assert.doesNotMatch(customerHtml, /date:\s*localeApi\.formatDate/);
});

test('existing Chinese empty availability rerenders immediately in English without availability refetch', async () => {
  const page = createCustomerContext();
  page.elements.get('date').value = '2026-09-09';
  vm.runInContext('renderTimes([])', page.context);
  assert.match(page.elements.get('times').innerHTML, /当天暂无可预约时间/);
  await vm.runInContext("setLocale('en')", page.context);
  assert.match(page.elements.get('times').innerHTML, /No available times on this date\./);
  assert.equal(page.fetchUrls.some(url => url.includes('/api/available-times-db')), false);
});

test('existing English empty availability rerenders immediately in Chinese without availability refetch', async () => {
  const page = createCustomerContext();
  page.elements.get('date').value = '2026-09-09';
  await vm.runInContext("setLocale('en')", page.context);
  vm.runInContext('renderTimes([])', page.context);
  assert.match(page.elements.get('times').innerHTML, /No available times on this date\./);
  await vm.runInContext("setLocale('zh-CN')", page.context);
  assert.match(page.elements.get('times').innerHTML, /当天暂无可预约时间/);
  assert.equal(page.fetchUrls.some(url => url.includes('/api/available-times-db')), false);
});

test('initial choose-date state rerenders immediately in both directions without availability refetch', async () => {
  const page = createCustomerContext();
  vm.runInContext('clearStaleTime()', page.context);
  assert.match(page.elements.get('times').innerHTML, /请先选择日期/);

  const toEnglish = vm.runInContext("setLocale('en')", page.context);
  assert.match(page.elements.get('times').innerHTML, /Choose a date first/);
  await toEnglish;

  const toChinese = vm.runInContext("setLocale('zh-CN')", page.context);
  assert.match(page.elements.get('times').innerHTML, /请先选择日期/);
  await toChinese;
  assert.equal(page.fetchUrls.some(url => url.includes('available-times')), false);
});

test('choose-date locale rerender preserves cart and per-item staff identity', async () => {
  const page = createCustomerContext();
  vm.runInContext(`
    cart = [{
      clientItemKey: 'cart-stable',
      categoryId: 'category-stable',
      serviceId: 'service-stable',
      staffSelectionType: 'specific',
      staffId: 'staff-stable'
    }];
    clearStaleTime();
  `, page.context);
  await vm.runInContext("setLocale('en')", page.context);
  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(cart[0])', page.context)),
    {
      clientItemKey: 'cart-stable',
      categoryId: 'category-stable',
      serviceId: 'service-stable',
      staffSelectionType: 'specific',
      staffId: 'staff-stable'
    }
  );
});
