'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const customerHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const cartApi = require('../public/customer-multi-service-cart');
const categoryFlowApi = require('../public/customer-category-flow');
const i18n = require('../public/shared-i18n');
const shopContext = require('../public/customer-shop-context');
const bookingCalendar = require('../public/customer-booking-calendar');

const MOCK_SERVICES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    categoryId: 'cat-hair',
    name: '女士剪发',
    price: 68,
    priceIsFrom: false,
    durationMinutes: 45,
    description: '专业总监剪裁'
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    categoryId: 'cat-hair',
    name: '染发护理',
    price: 188,
    priceIsFrom: true,
    durationMinutes: 90,
    description: '植物精油染发'
  }
];

const createCustomerContext = (customConfig = {}) => {
  const elements = new Map();
  const makeElement = (tag = 'div') => {
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      innerHTML: '',
      textContent: '',
      disabled: false,
      lang: '',
      placeholder: '',
      options: [],
      dataset: {},
      hidden: false,
      style: {},
      children: [],
      className: '',
      attributes: new Map(),
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); el.className = [...this._classes].join(' '); },
        remove(c) { this._classes.delete(c); el.className = [...this._classes].join(' '); },
        toggle(c, force) {
          if (force === undefined) {
            if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c);
          } else if (force) this._classes.add(c); else this._classes.delete(c);
          el.className = [...this._classes].join(' ');
        },
        contains(c) { return this._classes.has(c); }
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k); },
      appendChild(child) {
        this.children.push(child);
        if (this.tagName === 'SELECT') this.options.push(child);
        return child;
      },
      scrollIntoView() {},
      listeners: new Map(),
      addEventListener(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(fn);
      },
      async trigger(event, e = {}) {
        const list = this.listeners.get(event) || [];
        for (const fn of list) await fn(e);
        if (event === 'click' && typeof this.onclick === 'function') await this.onclick(e);
        if (event === 'change' && typeof this.onchange === 'function') await this.onchange(e);
      }
    };
    return el;
  };

  const knownIds = [
    'date', 'dateDisplay', 'service', 'times', 'message', 'languageZh', 'languageEn',
    'shopBrandName', 'shopBrandBadge', 'shopBrandLogoPlaceholder', 'submitBtn',
    'customerName', 'phone', 'email', 'categoryStep', 'categoryGrid', 'bookingStep',
    'contactStep', 'cartPanel', 'cartItems', 'cartTotals', 'confirmationSummary',
    'serviceCards', 'servicesLoading', 'servicesEmpty', 'servicesError',
    'scheduleSection', 'nextStepBtn', 'addAnotherBtn', 'bookForMyself', 'bookForSomeoneElse',
    'recipientFields', 'recipientName', 'recipientPhone', 'recipientEmail',
    'bookerCountryCode', 'recipientCountryCode', 'previousMonth', 'nextMonth',
    'calendarTitle', 'calendarGrid', 'nextAvailableDates', 'cartModuleRecovery',
    'cartRecoveryMessage', 'cartRecoveryReloadBtn', 'memberEntry'
  ];

  for (const id of knownIds) {
    elements.set(id, makeElement(id === 'service' || id.includes('CountryCode') ? 'select' : 'div'));
  }

  elements.get('bookerCountryCode').value = '+65';
  elements.get('recipientCountryCode').value = '+65';

  const fetchCalls = [];
  let reloadCalled = 0;
  const mockLocation = {
    hostname: 'localhost',
    pathname: '/',
    search: '?shop=demo-shop',
    reload: () => { reloadCalled++; }
  };

  const hasExplicitCartApi = 'cartApi' in customConfig;
  const effectiveCartApi = hasExplicitCartApi ? customConfig.cartApi : cartApi;

  const sandbox = {
    console,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: async (url, opts) => {
      fetchCalls.push(String(url));
      if (customConfig.fetch) {
        const customRes = await customConfig.fetch(url, opts);
        if (customRes !== undefined) return customRes;
      }
      if (String(url).includes('/api/booking/context')) {
        return { ok: true, json: async () => ({ success: true, data: { shopSlug: 'demo-shop', shopName: 'Demo Shop' } }) };
      }
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    },
    globalThis: {
      ggI18n: i18n,
      ggCustomerShopContext: shopContext,
      ggCustomerCategoryFlow: categoryFlowApi,
      ...(effectiveCartApi !== undefined ? { ggCustomerMultiServiceCart: effectiveCartApi } : {}),
      ggCustomerBookingCalendar: bookingCalendar,
      location: mockLocation
    },
    location: mockLocation,
    window: { location: mockLocation },
    localStorage: { getItem: () => 'zh-CN', setItem() {} },
    navigator: { languages: ['zh-CN'] },
    document: {
      title: '',
      documentElement: { lang: 'zh-CN' },
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      querySelectorAll: () => [],
      createElement: tag => makeElement(tag)
    }
  };

  const context = vm.createContext(sandbox);
  const scripts = [...customerHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const scriptContent = scripts.at(-1)[1];

  let initError = null;
  try {
    vm.runInContext(scriptContent, context);
  } catch (err) {
    initError = err;
  }

  return {
    context,
    elements,
    fetchCalls,
    getReloadCalled: () => reloadCalled,
    initError
  };
};

test('1. 静态资源版本：index.html 中 script 引用带版本 query（?v=2.0.0）', () => {
  assert.match(customerHtml, /<script\s+src="\/customer-multi-service-cart\.js\?v=2\.0\.0"><\/script>/);
});

test('2. 契约自检失败提示：当 CustomerMultiServiceCart 为 undefined 时，显示非敏感更新提示与刷新按钮，不抛未捕获 TypeError', async () => {
  const page = createCustomerContext({ cartApi: undefined });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(page.initError, null);
  const recoveryEl = page.elements.get('cartModuleRecovery');
  const msgEl = page.elements.get('cartRecoveryMessage');
  const btnEl = page.elements.get('cartRecoveryReloadBtn');
  assert.equal(recoveryEl.hidden, false);
  assert.equal(msgEl.textContent, i18n.t('cartModuleOutdated', 'zh-CN'));
  assert.equal(btnEl.textContent, i18n.t('reloadPage', 'zh-CN'));
  assert.equal(page.elements.get('categoryStep').hidden, true);
  assert.equal(page.elements.get('bookingStep').hidden, true);
  assert.equal(page.elements.get('submitBtn').disabled, true);
});

test('3. 旧版本模块拒绝：当 apiVersion === "1.0.0" 时，触发安全恢复态，禁用预约，不向顾客展示技术细节', async () => {
  const legacyApi = {
    ...cartApi,
    apiVersion: '1.0.0'
  };
  const page = createCustomerContext({ cartApi: legacyApi });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(page.initError, null);
  const recoveryEl = page.elements.get('cartModuleRecovery');
  const msgEl = page.elements.get('cartRecoveryMessage');
  assert.equal(recoveryEl.hidden, false);
  assert.doesNotMatch(msgEl.textContent, /apiVersion/i);
  assert.doesNotMatch(msgEl.textContent, /TypeError/i);
  assert.doesNotMatch(msgEl.textContent, /CustomerMultiServiceCart/i);
  assert.equal(msgEl.textContent, i18n.t('cartModuleOutdated', 'zh-CN'));
  assert.equal(page.elements.get('submitBtn').disabled, true);
});

test('4. 刷新按钮点击行为：点击执行 location.reload()，多次点击不出现无限死循环', async () => {
  const page = createCustomerContext({ cartApi: undefined });
  await new Promise(r => setTimeout(r, 20));
  const btnEl = page.elements.get('cartRecoveryReloadBtn');
  assert.equal(page.getReloadCalled(), 0);
  await btnEl.trigger('click');
  assert.equal(page.getReloadCalled(), 1);
  assert.equal(btnEl.disabled, true);
  if (!btnEl.disabled) {
    await btnEl.trigger('click');
  }
  assert.equal(page.getReloadCalled(), 1);
});

test('5. 乱序日期排期丢弃：先发 Jan 7（延迟到），后发 Jan 8（先到），Jan 7 响应返回时必须被丢弃，页面仍显示 Jan 8 的时间', async () => {
  let resolveJan7;
  let resolveJan8;
  const pJan7 = new Promise(r => { resolveJan7 = r; });
  const pJan8 = new Promise(r => { resolveJan8 = r; });

  const customFetch = async (url, opts) => {
    if (url.includes('multi-service-available-times')) {
      const body = JSON.parse(opts.body);
      if (body.date === '2026-01-07') {
        return pJan7;
      }
      if (body.date === '2026-01-08') {
        return pJan8;
      }
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);

  // Request 1: Jan 7
  page.elements.get('date').value = '2026-01-07';
  const callJan7 = vm.runInContext('loadAvailableTimes()', page.context);

  // Request 2: Jan 8
  page.elements.get('date').value = '2026-01-08';
  const callJan8 = vm.runInContext('loadAvailableTimes()', page.context);

  // Fast response for Jan 8 arrives first
  resolveJan8({
    ok: true,
    json: async () => ({ success: true, data: [{ time: '14:00', startAt: '2026-01-08T14:00:00+08:00' }] })
  });
  await callJan8;

  const timesBox = page.elements.get('times');
  assert.equal(timesBox.children.length, 1);
  assert.equal(timesBox.children[0].textContent, '14:00');

  // Slow response for Jan 7 arrives later
  resolveJan7({
    ok: true,
    json: async () => ({ success: true, data: [{ time: '09:00', startAt: '2026-01-07T09:00:00+08:00' }] })
  });
  await callJan7;

  // Stale Jan 7 was discarded; Jan 8 times remain
  assert.equal(timesBox.children.length, 1);
  assert.equal(timesBox.children[0].textContent, '14:00');
});

test('6. 乱序日历月份丢弃：同理，旧月份延迟响应不覆盖新月份', async () => {
  let resolveMonth1;
  let resolveMonth2;
  const pMonth1 = new Promise(r => { resolveMonth1 = r; });
  const pMonth2 = new Promise(r => { resolveMonth2 = r; });

  const customFetch = async (url, opts) => {
    if (url.includes('multi-service-available-dates')) {
      const body = JSON.parse(opts.body);
      if (body.startDate.startsWith('2026-01')) return pMonth1;
      if (body.startDate.startsWith('2026-02')) return pMonth2;
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);

  // Month 1 call
  vm.runInContext("calendarMonth = '2026-01';", page.context);
  const callM1 = vm.runInContext('loadAvailableDates()', page.context);

  // Month 2 call
  vm.runInContext("calendarMonth = '2026-02';", page.context);
  const callM2 = vm.runInContext('loadAvailableDates()', page.context);

  // Month 2 resolves first
  resolveMonth2({
    ok: true,
    json: async () => ({ success: true, data: [{ date: '2026-02-15', hasAvailability: true }] })
  });
  await callM2;

  let availMap = vm.runInContext('calendarAvailability', page.context);
  assert.equal(availMap.has('2026-02-15'), true);

  // Month 1 resolves later
  resolveMonth1({
    ok: true,
    json: async () => ({ success: true, data: [{ date: '2026-01-15', hasAvailability: true }] })
  });
  await callM1;

  // Stale Month 1 was discarded; only Month 2 remains in calendarAvailability
  availMap = vm.runInContext('calendarAvailability', page.context);
  assert.equal(availMap.has('2026-01-15'), false);
  assert.equal(availMap.has('2026-02-15'), true);
});

test('7. 跨商家排期丢弃：shopSlug 改变后，原商家的排期响应必须被丢弃', async () => {
  let resolveTimes;
  const pTimes = new Promise(r => { resolveTimes = r; });
  const customFetch = async url => {
    if (url.includes('multi-service-available-times')) return pTimes;
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'shop-a';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  page.elements.get('date').value = '2026-01-08';

  const callTimes = vm.runInContext('loadAvailableTimes()', page.context);

  // Customer navigates to shop-b while request is in flight
  vm.runInContext("customerShopSlug = 'shop-b';", page.context);

  resolveTimes({
    ok: true,
    json: async () => ({ success: true, data: [{ time: '10:00', startAt: '2026-01-08T10:00:00+08:00' }] })
  });
  await callTimes;

  // shop-a response discarded, timesBox did not render 10:00
  const timesBox = page.elements.get('times');
  assert.equal(timesBox.children.some(c => c.textContent === '10:00'), false);
});

test('8. 跨购物车排期丢弃：添加或删除服务导致 items 指纹改变后，旧指纹的时间响应必须被丢弃', async () => {
  let resolveTimes;
  const pTimes = new Promise(r => { resolveTimes = r; });
  const customFetch = async url => {
    if (url.includes('multi-service-available-times')) return pTimes;
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  page.elements.get('date').value = '2026-01-08';

  const callTimes = vm.runInContext('loadAvailableTimes()', page.context);

  // User adds another service while request is in flight
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[1])});`, page.context);

  resolveTimes({
    ok: true,
    json: async () => ({ success: true, data: [{ time: '11:00', startAt: '2026-01-08T11:00:00+08:00' }] })
  });
  await callTimes;

  // Stale 1-item fingerprint response discarded
  const timesBox = page.elements.get('times');
  assert.equal(timesBox.children.some(c => c.textContent === '11:00'), false);
});

test('9. 清空后员工响应不复活幽灵项目：项目被移除后到达的 staff-options 响应，严禁将卡片插回 DOM', async () => {
  let resolveStaff;
  const pStaff = new Promise(r => { resolveStaff = r; });
  const customFetch = async url => {
    if (url.includes('staff-options')) return pStaff;
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);

  // Start rendering cart which fetches staff options
  const renderPromise = vm.runInContext('renderCart()', page.context);

  // While in flight, user clears cart
  vm.runInContext('cart = cartApi.create();', page.context);
  const clearPromise = vm.runInContext('renderCart()', page.context);

  // Staff options resolves later
  resolveStaff({
    ok: true,
    json: async () => ({ success: true, data: [{ staffId: 'staff-1', displayName: 'Amy' }] })
  });

  await renderPromise;
  await clearPromise;

  const cartItems = page.elements.get('cartItems');
  assert.equal(cartItems.children.length, 0);
  assert.equal(page.elements.get('cartPanel').hidden, true);
});

test('10. 清空后排期区完全隐藏：全部删除后 scheduleSection 必须 hidden，下一步按钮禁用', async () => {
  const page = createCustomerContext();
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);

  await vm.runInContext('renderCart()', page.context);
  const scheduleSection = page.elements.get('scheduleSection');
  const nextStepBtn = page.elements.get('nextStepBtn');

  // Empty cart
  vm.runInContext('cart = cartApi.create();', page.context);
  await vm.runInContext('renderCart()', page.context);

  assert.equal(scheduleSection.hidden, true);
  assert.equal(nextStepBtn.disabled, true);
  assert.equal(page.elements.get('contactStep').hidden, true);
});

test('11. 清空后日期时间完全清理：全部删除后 selectedDate 与 selectedSlot 均为 null/空', async () => {
  const page = createCustomerContext();
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  page.elements.get('date').value = '2026-01-08';
  vm.runInContext("selectedSlot = { time: '10:00' };", page.context);

  // Clear cart and refresh availability
  vm.runInContext('cart = cartApi.create();', page.context);
  await vm.runInContext('refreshAvailabilityAfterCartChange()', page.context);

  assert.equal(page.elements.get('date').value, '');
  assert.equal(vm.runInContext('selectedSlot', page.context), null);
  const availMap = vm.runInContext('calendarAvailability', page.context);
  assert.equal(availMap.size, 0);
});

test('12. 清空后重新选项目时日历缓存完整：新选项目触发全新的可用日期与可用时间查询', async () => {
  const requestedDatesBodies = [];
  const customFetch = async (url, opts) => {
    if (url.includes('multi-service-available-dates')) {
      requestedDatesBodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ success: true, data: [{ date: '2026-01-09', hasAvailability: true }] }) };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);

  // Add first service
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  await vm.runInContext('refreshAvailabilityAfterCartChange()', page.context);
  assert.equal(requestedDatesBodies.length, 1);
  assert.equal(requestedDatesBodies[0].items[0].serviceId, MOCK_SERVICES[0].id);

  // Clear cart
  vm.runInContext('cart = cartApi.create();', page.context);
  await vm.runInContext('refreshAvailabilityAfterCartChange()', page.context);

  // Re-add second service
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[1])});`, page.context);
  await vm.runInContext('refreshAvailabilityAfterCartChange()', page.context);
  assert.equal(requestedDatesBodies.length, 2);
  assert.equal(requestedDatesBodies[1].items[0].serviceId, MOCK_SERVICES[1].id);
});

test('13. XSS防御 - 服务名称：<img src=x onerror=alert(1)> 作为服务名称时，必须按纯文本转义/textContent 插入，不执行任何 JS', () => {
  const page = createCustomerContext();
  const maliciousService = {
    id: 'xss-1',
    categoryId: 'cat-hair',
    name: '<img src=x onerror=alert(1)>',
    price: 99,
    priceIsFrom: false,
    durationMinutes: 30,
    description: 'normal desc'
  };

  vm.runInContext(`availableServices = [${JSON.stringify(maliciousService)}];`, page.context);
  vm.runInContext("selectedCategoryId = 'cat-hair';", page.context);
  vm.runInContext('renderServices()', page.context);

  const serviceCards = page.elements.get('serviceCards');
  assert.equal(serviceCards.children.length, 1);
  const card = serviceCards.children[0];
  const topRow = card.children[0];
  const nameSpan = topRow.children[0];
  assert.equal(nameSpan.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(nameSpan.innerHTML, '');
});

test('14. XSS防御 - 分类名称：包含 <script> 的分类名必须为 textContent', () => {
  const page = createCustomerContext();
  const maliciousCat = {
    categoryId: 'cat-xss',
    name: '<script>alert("xss")</script>',
    iconKey: 'sparkles'
  };

  vm.runInContext(`availableCategories = [${JSON.stringify(maliciousCat)}];`, page.context);
  vm.runInContext('renderCategories()', page.context);

  const categoryGrid = page.elements.get('categoryGrid');
  assert.equal(categoryGrid.children.length, 1);
  const catBtn = categoryGrid.children[0];
  const nameSpan = catBtn.children[1];
  assert.equal(nameSpan.textContent, '<script>alert("xss")</script>');
  assert.equal(nameSpan.innerHTML, '');
});

test('15. XSS防御 - 服务描述：包含 HTML payload 的 description 必须为 textContent', () => {
  const page = createCustomerContext();
  const maliciousService = {
    id: 'xss-2',
    categoryId: 'cat-hair',
    name: 'Normal Name',
    price: 50,
    priceIsFrom: false,
    durationMinutes: 30,
    description: '<b onmouseover=alert(1)>Malicious Description</b>'
  };

  vm.runInContext(`availableServices = [${JSON.stringify(maliciousService)}];`, page.context);
  vm.runInContext("selectedCategoryId = 'cat-hair';", page.context);
  vm.runInContext('renderServices()', page.context);

  const serviceCards = page.elements.get('serviceCards');
  const card = serviceCards.children[0];
  const descRow = card.children[2];
  assert.equal(descRow.textContent, '<b onmouseover=alert(1)>Malicious Description</b>');
  assert.equal(descRow.innerHTML, '');
});

test('16. XSS防御 - 成功提示：包含恶意服务名的预约成功提示，不得使用 innerHTML 拼接服务名', async () => {
  assert.doesNotMatch(customerHtml, /messageBox\.innerHTML\s*=\s*`[\s\S]*?cart\.map/);

  const page = createCustomerContext({
    fetch: async url => {
      if (url.includes('/api/new-db')) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      return undefined;
    }
  });
  await new Promise(r => setTimeout(r, 20));

  const maliciousService = {
    id: 'xss-success',
    name: '<svg onload=alert("pwned")>',
    price: 100,
    priceIsFrom: false,
    durationMinutes: 45
  };

  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = [${JSON.stringify(maliciousService)}];`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(maliciousService)});`, page.context);
  page.elements.get('customerName').value = 'Alice';
  page.elements.get('phone').value = '91234567';
  page.elements.get('date').value = '2026-01-08';
  vm.runInContext("selectedSlot = { time: '14:00', startAt: '2026-01-08T14:00:00+08:00' };", page.context);

  await page.elements.get('submitBtn').trigger('click');

  const msgBox = page.elements.get('message');
  assert.equal(msgBox.className, 'message success');
  const servicesNode = msgBox.children[2];
  assert.ok(servicesNode);
  assert.equal(servicesNode.textContent, '<svg onload=alert("pwned")>');
  assert.equal(servicesNode.innerHTML, '');
});

test('17. 无 dead imageUrl：代码中不存在对 service.imageUrl 拼进 HTML 属性的逻辑', () => {
  assert.doesNotMatch(customerHtml, /service\.imageUrl/i);
  assert.doesNotMatch(customerHtml, /img.*src.*imageUrl/i);
  const cartJs = fs.readFileSync(path.join(root, 'public/customer-multi-service-cart.js'), 'utf8');
  assert.doesNotMatch(cartJs, /imageUrl/i);
});

test('18. 错误脱敏 - 排期失败：服务端返回 500 / 数据库错误信息时，页面仅展示 availabilityFailed 固定双语文本，不含原始堆栈', async () => {
  const customFetch = async url => {
    if (url.includes('multi-service-available-times')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, message: 'FATAL: PostgreSQL connection pool exhausted at /app/server.js:412' })
      };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  page.elements.get('date').value = '2026-01-08';

  await vm.runInContext('loadAvailableTimes()', page.context);

  const timesBox = page.elements.get('times');
  assert.equal(timesBox.children.length, 1);
  assert.equal(timesBox.children[0].className, 'error');
  assert.equal(timesBox.children[0].textContent, i18n.t('availabilityFailed', 'zh-CN'));
  assert.doesNotMatch(timesBox.children[0].textContent, /PostgreSQL/);
  assert.doesNotMatch(timesBox.children[0].textContent, /connection pool/);
  assert.doesNotMatch(timesBox.children[0].textContent, /server\.js/);
});

test('19. 错误脱敏 - 提交失败：服务端返回异常或 TypeError 时，页面仅展示 bookingFailed 固定双语文本', async () => {
  const customFetch = async url => {
    if (url.includes('/api/new-db')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, message: 'TypeError: Cannot read properties of undefined (reading id)' })
      };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  page.elements.get('customerName').value = 'Alice';
  page.elements.get('phone').value = '91234567';
  page.elements.get('date').value = '2026-01-08';
  vm.runInContext("selectedSlot = { time: '14:00', startAt: '2026-01-08T14:00:00+08:00' };", page.context);

  await page.elements.get('submitBtn').trigger('click');

  const msgBox = page.elements.get('message');
  assert.equal(msgBox.className, 'message error');
  assert.equal(msgBox.textContent, i18n.t('bookingFailed', 'zh-CN'));
  assert.doesNotMatch(msgBox.textContent, /TypeError/);
  assert.doesNotMatch(msgBox.textContent, /undefined/);
});

test('20. 错误脱敏 - 加载服务失败：服务端返回错误时，仅展示 loadServicesFailed 固定双语文本', async () => {
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, message: 'SQL Error: relation services does not exist' })
      };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);

  await vm.runInContext('loadServices()', page.context);

  const errorEl = page.elements.get('servicesError');
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, i18n.t('loadServicesFailed', 'zh-CN'));
  assert.doesNotMatch(errorEl.textContent, /SQL Error/);
  assert.doesNotMatch(errorEl.textContent, /relation/);
});

test('21. 中英文切换目录无缝刷新：语言切换时重新加载目录，已选项目如果仍合法必须被保留', async () => {
  let requestedLocale = '';
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      const u = new URL(url, 'http://localhost');
      requestedLocale = u.searchParams.get('locale');
      const name0 = requestedLocale === 'en' ? 'Women Haircut' : '女士剪发';
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: [{ ...MOCK_SERVICES[0], name: name0 }]
        })
      };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  assert.equal(vm.runInContext('cart.length', page.context), 1);

  await vm.runInContext("setLocale('en')", page.context);
  assert.equal(vm.runInContext('currentLocale', page.context), 'en');
  // Service was retained across locale switch
  assert.equal(vm.runInContext('cart.length', page.context), 1);
  assert.equal(vm.runInContext('cart[0].serviceId', page.context), MOCK_SERVICES[0].id);

  // When catalogue is loaded with en, service is retained
  await vm.runInContext('loadServices()', page.context);
  assert.equal(requestedLocale, 'en');
  assert.equal(vm.runInContext('cart.length', page.context), 1);
  assert.equal(vm.runInContext('cart[0].serviceId', page.context), MOCK_SERVICES[0].id);
});

test('22. 中英文切换已下架项目移除：语言切换后若新目录缺少某项目，该项目被安全移除并提示', async () => {
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    }
    return undefined;
  };

  const page = createCustomerContext({ fetch: customFetch });
  await new Promise(r => setTimeout(r, 20));
  vm.runInContext("customerShopSlug = 'test-shop';", page.context);
  vm.runInContext(`availableServices = ${JSON.stringify(MOCK_SERVICES)};`, page.context);
  vm.runInContext(`cart = cartApi.add(cart, ${JSON.stringify(MOCK_SERVICES[0])});`, page.context);
  assert.equal(vm.runInContext('cart.length', page.context), 1);

  await vm.runInContext('loadServices()', page.context);

  assert.equal(vm.runInContext('cart.length', page.context), 0);
  const msgBox = page.elements.get('message');
  assert.equal(msgBox.className, 'message error');
  assert.equal(msgBox.textContent, i18n.t('serviceUnavailableRetry', 'zh-CN'));
});

test('23. 无 preference 员工默认：默认 staff 选项必须为 no_preference', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  assert.equal(cart[0].staffSelectionType, 'no_preference');
  assert.equal(cart[0].staffId, null);
});

test('24. 指定员工跨服务独立：A 服务选特定员工，B 服务不受影响', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);

  cart = cartApi.updateStaff(cart, cart[0].clientItemKey, 'specific', 'staff-amy');
  assert.equal(cart[0].staffSelectionType, 'specific');
  assert.equal(cart[0].staffId, 'staff-amy');

  assert.equal(cart[1].staffSelectionType, 'no_preference');
  assert.equal(cart[1].staffId, null);
});

test('25. 多项目预约 payload 格式：请求 items 必须包含 serviceId 与 staffId（或 null）', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);
  cart = cartApi.updateStaff(cart, cart[0].clientItemKey, 'specific', 'staff-amy');

  const items = cartApi.requestItems(cart);
  assert.equal(items.length, 2);
  assert.equal(items[0].serviceId, MOCK_SERVICES[0].id);
  assert.equal(items[0].staffId, 'staff-amy');
  assert.equal(items[0].staffSelectionType, 'specific');
  assert.equal(items[1].serviceId, MOCK_SERVICES[1].id);
  assert.equal(items[1].staffSelectionType, 'no_preference');
  assert.equal(items[1].staffId, undefined);
});

test('26. 单项目预约 payload 格式：单个项目时依然以 items: [{...}] 规范发送', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);

  const items = cartApi.requestItems(cart);
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 1);
  assert.equal(items[0].serviceId, MOCK_SERVICES[0].id);
  assert.equal(items[0].staffSelectionType, 'no_preference');
});

test('27. 无敏感信息泄漏：localStorage / DOM / console 中不得泄露顾客未提交的其它隐私', () => {
  assert.doesNotMatch(customerHtml, /localStorage\.setItem\(['"]customerName/i);
  assert.doesNotMatch(customerHtml, /localStorage\.setItem\(['"]phone/i);
  assert.doesNotMatch(customerHtml, /localStorage\.setItem\(['"]email/i);
});

test('28. 中英文纯净性：任何新增文案必须 100% 纯中文（zh-CN）与 100% 纯英文（en），无中英混合', () => {
  const zhCartOutdated = i18n.t('cartModuleOutdated', 'zh-CN');
  const enCartOutdated = i18n.t('cartModuleOutdated', 'en');
  const zhReload = i18n.t('reloadPage', 'zh-CN');
  const enReload = i18n.t('reloadPage', 'en');

  // Pure Chinese check (no ASCII letters)
  assert.equal(/[a-zA-Z]/.test(zhCartOutdated), false);
  assert.equal(/[a-zA-Z]/.test(zhReload), false);

  // Pure English check (no Chinese characters)
  assert.equal(/[\u4e00-\u9fa5]/.test(enCartOutdated), false);
  assert.equal(/[\u4e00-\u9fa5]/.test(enReload), false);
});

test('29. 不访问生产：测试严格 mock，不产生任何外网与生产调用', () => {
  assert.doesNotMatch(customerHtml, /https?:\/\/(?!localhost)[^\s/'"]+\.(com|org|io|net)/i);
  const cartJs = fs.readFileSync(path.join(root, 'public/customer-multi-service-cart.js'), 'utf8');
  assert.doesNotMatch(cartJs, /https?:\/\/(?!localhost)[^\s/'"]+\.(com|org|io|net)/i);
});

test('30. 不写入数据库：测试为纯只读与逻辑核验，无写库 side-effect', () => {
  const cartJs = fs.readFileSync(path.join(root, 'public/customer-multi-service-cart.js'), 'utf8');
  assert.doesNotMatch(cartJs, /fetch\s*\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
  const cart = cartApi.create();
  assert.ok(Array.isArray(cart));
});
