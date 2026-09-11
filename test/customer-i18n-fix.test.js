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
    options: [], dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild(child) { this.options.push(child); }
  });
  for (const id of ['date', 'dateDisplay', 'service', 'times', 'message', 'languageZh', 'languageEn', 'submitBtn', 'customerName', 'phone', 'email', 'categoryStep', 'categoryGrid', 'bookingStep', 'contactStep', 'cartPanel', 'cartItems', 'cartTotals', 'confirmationSummary', 'addServiceBtn', 'addAnotherBtn', 'bookForMyself', 'bookForSomeoneElse', 'recipientFields', 'recipientName', 'recipientPhone', 'recipientEmail', 'bookerCountryCode', 'recipientCountryCode']) {
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
  assert.match(customerHtml, /email,\s*bookingFor,[\s\S]*date,\s*startAt: selectedSlot\.startAt/);
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

test('recipient choice and draft survive locale switching without an availability refetch', async () => {
  const page = createCustomerContext();
  vm.runInContext(`
    bookingFor = 'someone_else';
    document.getElementById('recipientName').value = 'Recipient B';
    document.getElementById('recipientPhone').value = '9123 4567';
    document.getElementById('recipientEmail').value = 'b@example.invalid';
    recipientCountryCode.value = '+65';
    dateInput.value = '2030-01-07';
    selectedSlot = { time: '10:00', startAt: '2030-01-07T02:00:00Z' };
    cart = [{ clientItemKey: 'stable', categoryId: 'beauty', serviceId: 'facial', staffSelectionType: 'specific', staffId: 'staff-a' }];
  `, page.context);
  await vm.runInContext("setLocale('en')", page.context);
  await vm.runInContext("setLocale('zh-CN')", page.context);
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify({
    bookingFor, name: document.getElementById('recipientName').value, phone: document.getElementById('recipientPhone').value,
    email: document.getElementById('recipientEmail').value, country: recipientCountryCode.value,
    date: dateInput.value, slot: selectedSlot, cart: cart[0]
  })`, page.context)), {
    bookingFor: 'someone_else', name: 'Recipient B', phone: '9123 4567',
    email: 'b@example.invalid', country: '+65', date: '2030-01-07',
    slot: { time: '10:00', startAt: '2030-01-07T02:00:00Z' },
    cart: { clientItemKey: 'stable', categoryId: 'beauty', serviceId: 'facial', staffSelectionType: 'specific', staffId: 'staff-a' }
  });
  assert.equal(page.fetchUrls.some(url => url.includes('available-times')), false);
});

test('recipient fields toggle without clearing their draft and Singapore is the default', () => {
  const page = createCustomerContext();
  vm.runInContext(`
    document.getElementById('recipientName').value = 'Recipient B';
    bookingFor = 'someone_else'; renderRecipientChoice();
  `, page.context);
  assert.equal(page.elements.get('recipientFields').hidden, false);
  vm.runInContext(`bookingFor = 'myself'; renderRecipientChoice();`, page.context);
  assert.equal(page.elements.get('recipientFields').hidden, true);
  vm.runInContext(`bookingFor = 'someone_else'; renderRecipientChoice();`, page.context);
  assert.equal(page.elements.get('recipientName').value, 'Recipient B');
  assert.equal(page.elements.get('bookerCountryCode').value, '+65');
  assert.equal(page.elements.get('recipientCountryCode').value, '+65');
});

test('recipient UI is bilingual, has explicit country selection, and sends no customer id', () => {
  for (const key of ['bookingRecipient', 'bookForMyself', 'bookForSomeoneElse', 'recipientDetails', 'recipientName', 'countryRegion', 'recipientPhone', 'recipientEmail']) {
    assert.notEqual(i18n.t(key, 'zh-CN'), key);
    assert.notEqual(i18n.t(key, 'en'), key);
  }
  assert.match(customerHtml, /\['\+65', 'countrySingapore'\]/);
  assert.match(customerHtml, /\['\+60', 'countryMalaysia'\]/);
  assert.match(customerHtml, /bookingFor,\s*\.\.\.\(recipient \? \{ recipient \}/);
  assert.doesNotMatch(customerHtml, /customerId\s*:/);
});
