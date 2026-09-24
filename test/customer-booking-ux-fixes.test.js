'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../public/shared-i18n');
const categoryFlow = require('../public/customer-category-flow');
const cartApi = require('../public/customer-multi-service-cart');
const shopContext = require('../public/customer-shop-context');
const bookingCalendar = require('../public/customer-booking-calendar');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

const createCustomerContext = async ({
  locale = 'zh-CN',
  categories = [],
  services = [],
  submitResponse = { success: true }
} = {}) => {
  const elements = new Map();
  const makeElement = (tag = 'div') => {
    let textContent = '';
    let innerHTML = '';
    let className = '';
    const children = [];
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      disabled: false,
      hidden: false,
      lang: '',
      href: '',
      style: {},
      dataset: {},
      children,
      options: [],
      get className() { return className; },
      set className(val) { className = String(val); },
      classList: {
        contains(c) { return className.split(/\s+/).filter(Boolean).includes(c); },
        add(c) {
          const set = new Set(className.split(/\s+/).filter(Boolean));
          set.add(c);
          className = Array.from(set).join(' ');
        },
        remove(c) {
          const set = new Set(className.split(/\s+/).filter(Boolean));
          set.delete(c);
          className = Array.from(set).join(' ');
        },
        toggle(c, force) {
          const set = new Set(className.split(/\s+/).filter(Boolean));
          const shouldAdd = force !== undefined ? Boolean(force) : !set.has(c);
          if (shouldAdd) set.add(c);
          else set.delete(c);
          className = Array.from(set).join(' ');
        }
      },
      get textContent() {
        if (children.length > 0) return children.map(c => c.textContent).join('');
        return textContent;
      },
      set textContent(val) {
        textContent = String(val);
        innerHTML = String(val);
        children.length = 0;
      },
      get innerHTML() { return innerHTML; },
      set innerHTML(val) {
        innerHTML = String(val);
        if (innerHTML === '') children.length = 0;
      },
      appendChild(child) {
        children.push(child);
        if (child.tagName === 'OPTION') el.options.push(child);
      },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      async click() {
        for (const fn of listeners.get('click') || []) {
          await fn({ target: el });
        }
      },
      setAttribute(k, v) { el.dataset[k] = v; },
      getAttribute(k) { return el.dataset[k]; },
      querySelectorAll() {
        return [];
      },
      scrollCalls: [],
      scrollIntoView(options) {
        el.scrollCalls.push(options);
      }
    };
    return el;
  };

  const fetchUrls = [];
  const postBodies = [];
  const storage = new Map([['gg_beauty_locale', locale]]);

  const contextObj = {
    console,
    encodeURIComponent,
    decodeURIComponent,
    URLSearchParams,
    URL,
    setTimeout: (fn, ms) => setTimeout(fn, ms !== undefined ? ms : 0),
    clearTimeout: id => clearTimeout(id),
    AbortController: globalThis.AbortController,
    fetch: async (url, opts = {}) => {
      const urlStr = String(url);
      fetchUrls.push(urlStr);
      if (opts.body) postBodies.push(JSON.parse(opts.body));

      if (urlStr.includes('/api/booking/context')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { shopSlug: 'test-shop', shopName: 'Test Shop' } }) };
      }
      if (urlStr.includes('/api/booking/service-categories')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: categories }) };
      }
      if (urlStr.includes('/api/services-db')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: services }) };
      }
      if (urlStr.includes('/api/new-db')) {
        return { ok: true, status: 200, json: async () => submitResponse };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    },
    globalThis: {
      ggI18n: i18n,
      ggCustomerShopContext: shopContext,
      ggCustomerCategoryFlow: categoryFlow,
      ggCustomerMultiServiceCart: cartApi,
      ggCustomerBookingCalendar: bookingCalendar,
      URLSearchParams,
      location: { hostname: 'localhost', pathname: '/', search: '?shop=test-shop' }
    },
    localStorage: {
      getItem: k => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v))
    },
    navigator: { languages: [locale] },
    document: {
      title: '',
      documentElement: { lang: locale },
      getElementById: id => {
        if (!elements.has(id)) {
          const el = makeElement();
          elements.set(id, el);
          contextObj[id] = el;
        }
        return elements.get(id);
      },
      querySelectorAll: () => [],
      createElement: tag => makeElement(tag)
    }
  };

  const elementIds = [
    'date', 'dateDisplay', 'service', 'times', 'message', 'languageZh', 'languageEn',
    'shopBrandName', 'submitBtn', 'customerName', 'phone', 'email', 'categoryStep',
    'categoryGrid', 'bookingStep', 'contactStep', 'cartPanel', 'cartItems', 'cartTotals',
    'confirmationSummary', 'addServiceBtn', 'addAnotherBtn', 'bookForMyself', 'bookForSomeoneElse',
    'recipientFields', 'recipientName', 'recipientPhone', 'recipientEmail',
    'bookerCountryCode', 'recipientCountryCode', 'previousMonth', 'nextMonth',
    'calendarTitle', 'calendarGrid', 'nextAvailableDates', 'serviceCards', 'servicesLoading',
    'servicesEmpty', 'servicesError', 'servicesRetryContainer', 'servicesRetryBtn',
    'staffSection', 'staffItemsList', 'memberEntry', 'servicesErrorText'
  ];

  for (const id of elementIds) {
    const el = makeElement();
    if (['contactStep', 'servicesLoading', 'servicesEmpty', 'servicesError', 'servicesRetryContainer'].includes(id)) {
      el.hidden = true;
    }
    elements.set(id, el);
    contextObj[id] = el;
  }

  const context = vm.createContext(contextObj);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const customerScript = scripts.at(-1)[1];
  vm.runInContext(customerScript, context);
  await new Promise(resolve => setTimeout(resolve, 80));

  return { context, elements, fetchUrls, postBodies };
};

// 1. 预约成功后按钮变成“预约成功”并禁用，且页面滚动到成功提示区域
test('1. 预约成功后按钮变成“预约成功” / “Booking Confirmed” 并禁用，且页面滚动到提示区域', async () => {
  const service = { id: 'srv-1', name: '精致剪发', price: 80, durationMinutes: 60, categoryId: 'cat-1' };
  const categories = [{ categoryId: 'cat-1', name: '美发' }];

  // 中文环境测试
  const zhHarness = await createCustomerContext({
    locale: 'zh-CN',
    categories,
    services: [service],
    submitResponse: { success: true }
  });

  const zhCtx = zhHarness.context;
  const zhElements = zhHarness.elements;

  // 模拟顾客购物车与时段选择
  const cartWithService = cartApi.add(cartApi.create(), service);
  vm.runInContext(`cart = ${JSON.stringify(cartWithService)}; selectedSlot = { startAt: '2026-10-01T10:00:00.000Z', time: '10:00' };`, zhCtx);

  zhElements.get('customerName').value = '张三';
  zhElements.get('phone').value = '91234567';
  zhElements.get('date').value = '2026-10-01';

  const zhSubmitBtn = zhElements.get('submitBtn');
  const zhMessageBox = zhElements.get('message');

  // 点击确认预约
  await zhSubmitBtn.click();
  await new Promise(r => setTimeout(r, 50));

  // 验证：按钮文字变成“预约成功”，按钮禁用
  assert.equal(zhSubmitBtn.disabled, true);
  assert.equal(zhSubmitBtn.textContent, '预约成功');

  // 验证：成功提示区域明显，并且保留日期、时间、服务项目
  assert.equal(zhMessageBox.className, 'message success');
  assert.match(zhMessageBox.children[0].textContent, /预约成功！/);
  assert.match(zhMessageBox.children[1].textContent, /10:00/);
  assert.match(zhMessageBox.children[2].textContent, /精致剪发/);

  // 验证：页面滚动到成功提示区域
  assert.ok(zhMessageBox.scrollCalls.length > 0);
  assert.equal(zhMessageBox.scrollCalls[0]?.behavior, 'smooth');
  assert.equal(zhMessageBox.scrollCalls[0]?.block, 'nearest');

  // 英文环境测试
  const enHarness = await createCustomerContext({
    locale: 'en',
    categories,
    services: [service],
    submitResponse: { success: true }
  });

  const enCtx = enHarness.context;
  const enElements = enHarness.elements;

  vm.runInContext(`cart = ${JSON.stringify(cartWithService)}; selectedSlot = { startAt: '2026-10-01T10:00:00.000Z', time: '10:00' };`, enCtx);

  enElements.get('customerName').value = 'John Doe';
  enElements.get('phone').value = '91234567';
  enElements.get('date').value = '2026-10-01';

  const enSubmitBtn = enElements.get('submitBtn');
  const enMessageBox = enElements.get('message');

  await enSubmitBtn.click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(enSubmitBtn.disabled, true);
  assert.equal(enSubmitBtn.textContent, 'Booking Confirmed');
  assert.equal(enMessageBox.className, 'message success');
  assert.ok(enMessageBox.scrollCalls.length > 0);
});

// 2. 提交失败后按钮恢复为“确认预约” / “Confirm Booking”
test('2. 提交失败后按钮恢复为“确认预约” / “Confirm Booking” 且保持可点击状态', async () => {
  const service = { id: 'srv-1', name: '精致剪发', price: 80, durationMinutes: 60, categoryId: 'cat-1' };
  const categories = [{ categoryId: 'cat-1', name: '美发' }];

  // 中文环境测试
  const zhHarness = await createCustomerContext({
    locale: 'zh-CN',
    categories,
    services: [service],
    submitResponse: { success: false, message: 'Time slot booked' }
  });

  const zhCtx = zhHarness.context;
  const zhElements = zhHarness.elements;

  const cartWithService = cartApi.add(cartApi.create(), service);
  vm.runInContext(`cart = ${JSON.stringify(cartWithService)}; selectedSlot = { startAt: '2026-10-01T10:00:00.000Z', time: '10:00' };`, zhCtx);

  zhElements.get('customerName').value = '李四';
  zhElements.get('phone').value = '98765432';
  zhElements.get('date').value = '2026-10-01';

  const zhSubmitBtn = zhElements.get('submitBtn');
  const zhMessageBox = zhElements.get('message');

  await zhSubmitBtn.click();
  await new Promise(r => setTimeout(r, 50));

  // 提交失败：按钮恢复可点击，文字恢复“确认预约”
  assert.equal(zhSubmitBtn.disabled, false);
  assert.equal(zhSubmitBtn.textContent, '确认预约');
  assert.equal(zhMessageBox.className, 'message error');
  assert.equal(zhMessageBox.textContent, '预约失败');

  // 英文环境测试
  const enHarness = await createCustomerContext({
    locale: 'en',
    categories,
    services: [service],
    submitResponse: { success: false }
  });

  const enCtx = enHarness.context;
  const enElements = enHarness.elements;

  vm.runInContext(`cart = ${JSON.stringify(cartWithService)}; selectedSlot = { startAt: '2026-10-01T10:00:00.000Z', time: '10:00' };`, enCtx);

  enElements.get('customerName').value = 'Jane Doe';
  enElements.get('phone').value = '98765432';
  enElements.get('date').value = '2026-10-01';

  const enSubmitBtn = enElements.get('submitBtn');
  const enMessageBox = enElements.get('message');

  await enSubmitBtn.click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(enSubmitBtn.disabled, false);
  assert.equal(enSubmitBtn.textContent, 'Confirm Booking');
  assert.equal(enMessageBox.className, 'message error');
  assert.equal(enMessageBox.textContent, 'Booking failed');
});

// 3. 1 个分类时不显示“选择服务分类”，直接显示服务项目
test('3. 1 个分类时不显示“选择服务分类”，直接显示服务项目', async () => {
  const singleCategory = [{ categoryId: 'cat-single', name: '单消分类', iconKey: 'beauty' }];
  const services = [
    { id: 'srv-1', name: '核心项目A', price: 99, durationMinutes: 60, categoryId: 'cat-single' },
    { id: 'srv-2', name: '核心项目B', price: 199, durationMinutes: 90, categoryId: 'cat-single' }
  ];

  const harness = await createCustomerContext({
    categories: singleCategory,
    services
  });

  const elements = harness.elements;
  const categoryStep = elements.get('categoryStep');
  const bookingStep = elements.get('bookingStep');
  const serviceCards = elements.get('serviceCards');

  // 1 个分类时：categoryStep 必须隐藏
  assert.equal(categoryStep.hidden, true);

  // 直接展示服务列表
  assert.equal(bookingStep.hidden, false);
  assert.equal(serviceCards.hidden, false);
  assert.equal(serviceCards.children.length, 2);
  assert.equal(serviceCards.children[0].dataset.serviceId, 'srv-1');
  assert.equal(serviceCards.children[1].dataset.serviceId, 'srv-2');
});

// 4. 2 个或以上分类时显示两列分类方块
test('4. 2 个或以上分类时显示“选择服务分类”，并用两列方块网格展示', async () => {
  const twoCategories = [
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' },
    { categoryId: 'cat-spa', name: 'SPA水疗', iconKey: 'body-wellness' }
  ];
  const services = [
    { id: 'srv-1', name: '剪发', price: 68, durationMinutes: 45, categoryId: 'cat-hair' },
    { id: 'srv-2', name: '精油SPA', price: 268, durationMinutes: 90, categoryId: 'cat-spa' }
  ];

  const harness = await createCustomerContext({
    categories: twoCategories,
    services
  });

  const elements = harness.elements;
  const categoryStep = elements.get('categoryStep');
  const categoryGrid = elements.get('categoryGrid');

  // 2 个分类时：categoryStep 可见
  assert.equal(categoryStep.hidden, false);

  // categoryGrid 包含分类方块
  assert.equal(categoryGrid.children.length, 2);
  const card1 = categoryGrid.children[0];
  const card2 = categoryGrid.children[1];

  // 每个方块显示图标 + 分类名
  assert.match(card1.className, /category-card/);
  assert.equal(card1.children[0].className, 'category-icon');
  assert.equal(card1.children[1].className, 'category-name notranslate');
  assert.equal(card1.children[1].textContent, '美发');

  // 当前选中分类有 selected 类名
  assert.match(card1.className, /selected/);

  // CSS 验证：确保是 repeat(2, minmax(0, 1fr)) 网格，且无 horizontal overflow 覆盖
  assert.match(html, /\.category-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(html, /\.category-grid\s*\{[^}]*overflow-x:\s*auto/);

  // 选中态黑底白字样式验证
  assert.match(html, /\.category-card\.selected\s*\{[^}]*background:\s*var\(--theme-primary,\s*#111\)/);
  assert.match(html, /\.category-card\.selected\s*\{[^}]*color:\s*var\(--theme-primary-contrast,\s*#fff\)/);
});

// 5. 中英文文案完整无缺失、无混杂
test('5. 中英文文案完整无缺失、无混杂', () => {
  // 中文文案验证
  assert.equal(i18n.t('bookAppointment', 'zh-CN'), '确认预约');
  assert.equal(i18n.t('bookingConfirmed', 'zh-CN'), '预约成功');
  assert.equal(i18n.t('chooseServiceCategory', 'zh-CN'), '选择服务分类');
  assert.equal(i18n.t('bookingSuccess', 'zh-CN'), '预约成功！');
  assert.equal(i18n.t('bookingFailed', 'zh-CN'), '预约失败');

  // 中文不能包含英文字母
  assert.doesNotMatch(i18n.t('bookAppointment', 'zh-CN'), /[a-zA-Z]/);
  assert.doesNotMatch(i18n.t('bookingConfirmed', 'zh-CN'), /[a-zA-Z]/);
  assert.doesNotMatch(i18n.t('chooseServiceCategory', 'zh-CN'), /[a-zA-Z]/);

  // 英文文案验证
  assert.equal(i18n.t('bookAppointment', 'en'), 'Confirm Booking');
  assert.equal(i18n.t('bookingConfirmed', 'en'), 'Booking Confirmed');
  assert.equal(i18n.t('chooseServiceCategory', 'en'), 'Choose a Service Category');
  assert.equal(i18n.t('bookingSuccess', 'en'), 'Appointment booked!');
  assert.equal(i18n.t('bookingFailed', 'en'), 'Booking failed');

  // 英文不能包含中文字符
  assert.doesNotMatch(i18n.t('bookAppointment', 'en'), /[\u3400-\u9fff]/);
  assert.doesNotMatch(i18n.t('bookingConfirmed', 'en'), /[\u3400-\u9fff]/);
  assert.doesNotMatch(i18n.t('chooseServiceCategory', 'en'), /[\u3400-\u9fff]/);
});
