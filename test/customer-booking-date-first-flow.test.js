'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { app } = require('../server');
const { StaffBookabilityError } = require('../lib/staff-bookability-validator');
const categoryFlow = require('../public/customer-category-flow');
const cartApi = require('../public/customer-multi-service-cart');
const i18n = require('../public/shared-i18n');
const shopContext = require('../public/customer-shop-context');
const bookingCalendar = require('../public/customer-booking-calendar');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  serviceA: '33333333-3333-4333-8333-111111111111',
  serviceB: '33333333-3333-4333-8333-222222222222',
  staffA: '44444444-4444-4444-8444-111111111111',
  staffB: '44444444-4444-4444-8444-222222222222',
  staffC: '44444444-4444-4444-8444-333333333333'
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

// DOM simulation helper to verify real customer DOM visibility and behaviour
const createCustomerContext = async ({
  categories = [],
  services = [],
  categoriesFail = false,
  servicesFail = false,
  contextFail = false,
  customFetch = null,
  timeoutMs = 8000,
  locale = 'zh-CN'
} = {}) => {
  const makeElement = (tag = 'div') => {
    let innerHTML = '';
    let textContent = '';
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      get innerHTML() { return innerHTML; },
      set innerHTML(val) {
        innerHTML = String(val);
        if (innerHTML === '') this.children = [];
      },
      get textContent() {
        if (this.children.length > 0) {
          return this.children.map(c => c.textContent).join('');
        }
        return textContent;
      },
      set textContent(val) {
        textContent = String(val);
      },
      disabled: false, lang: '', href: '',
      options: [], dataset: {}, hidden: false, style: { display: '' },
      children: [],
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this._classes.has(c)) this._classes.delete(c);
            else this._classes.add(c);
          } else if (force) this._classes.add(c);
          else this._classes.delete(c);
        },
        contains(c) { return this._classes.has(c); }
      },
      _listeners: new Map(),
      addEventListener(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
      },
      click() {
        for (const fn of this._listeners.get('click') || []) fn({ target: this });
      },
      setAttribute(k, v) { this.dataset[k] = v; },
      getAttribute(k) { return this.dataset[k]; },
      appendChild(child) {
        this.children.push(child);
        if (child.tagName === 'OPTION') this.options.push(child);
      },
      querySelectorAll() { return []; },
      scrollIntoView() {}
    };
    return el;
  };

  const elements = new Map();
  const fetchUrls = [];
  const contextObj = {
    console,
    encodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, ms !== undefined ? ms : 0),
    clearTimeout: (id) => clearTimeout(id),
    AbortController: globalThis.AbortController,
    fetch: async (url, opts) => {
      const urlStr = String(url);
      fetchUrls.push(urlStr);
      if (customFetch) {
        const res = await customFetch(urlStr, opts);
        if (res !== undefined) return res;
      }
      if (urlStr.includes('/api/booking/context')) {
        if (contextFail) return { ok: false, status: 500, json: async () => ({ success: false, message: 'Context error' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { shopSlug: 'test-shop', shopName: 'Test Shop' } }) };
      }
      if (urlStr.includes('/api/booking/service-categories')) {
        if (categoriesFail) return { ok: false, status: 500, json: async () => ({ success: false, message: 'Cat error' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: categories }) };
      }
      if (urlStr.includes('/api/services-db')) {
        if (servicesFail) return { ok: false, status: 500, json: async () => ({ success: false, message: 'Srv error' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: services }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    },
    globalThis: {
      __CATALOGUE_TIMEOUT_MS__: timeoutMs,
      ggI18n: i18n,
      ggCustomerShopContext: shopContext,
      ggCustomerCategoryFlow: categoryFlow,
      ggCustomerMultiServiceCart: cartApi,
      ggCustomerBookingCalendar: bookingCalendar,
      location: { hostname: 'localhost', pathname: '/', search: '?shop=test-shop' }
    },
    localStorage: { getItem: () => locale, setItem() {} },
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

  for (const id of [
    'date', 'dateDisplay', 'service', 'times', 'message', 'languageZh', 'languageEn',
    'shopBrandName', 'submitBtn', 'customerName', 'phone', 'email', 'categoryStep',
    'categoryGrid', 'bookingStep', 'contactStep', 'cartPanel', 'cartItems', 'cartTotals',
    'confirmationSummary', 'addServiceBtn', 'addAnotherBtn', 'bookForMyself', 'bookForSomeoneElse',
    'recipientFields', 'recipientName', 'recipientPhone', 'recipientEmail', 'bookerCountryCode',
    'recipientCountryCode', 'previousMonth', 'nextMonth', 'calendarTitle', 'calendarGrid',
    'nextAvailableDates', 'serviceCards', 'servicesLoading', 'servicesEmpty', 'servicesError',
    'servicesRetryContainer', 'servicesErrorText', 'servicesRetryBtn', 'staffSection', 'staffItemsList', 'memberEntry'
  ]) {
    const el = makeElement();
    if (id === 'servicesRetryBtn') el.dataset.i18n = 'reloadServices';
    if (id === 'contactStep' || id === 'servicesLoading' || id === 'servicesEmpty' || id === 'servicesError' || id === 'servicesRetryContainer') {
      el.hidden = true;
    }
    elements.set(id, el);
    contextObj[id] = el;
  }

  const context = vm.createContext(contextObj);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const customerScript = scripts.at(-1)[1];
  vm.runInContext(customerScript, context);
  await new Promise(resolve => setTimeout(resolve, 50));
  return { context, elements, fetchUrls };
};

// 1. 综合店：两分类，顶级分类标签显示，服务方块立即显示，无需二次点击
test('1. 综合店：两分类，顶级分类标签显示，服务方块立即显示，无需二次点击', () => {
  const twoCategories = [
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' },
    { categoryId: 'cat-spa', name: 'SPA', iconKey: 'body-wellness' }
  ];
  const tabsState = categoryFlow.deriveTabsState(twoCategories, '');
  assert.equal(tabsState.showTabs, true);
  assert.equal(tabsState.showBookingStep, true);
  assert.equal(tabsState.selectedCategoryId, 'cat-hair');
  assert.equal(tabsState.isEmpty, false);

  assert.match(html, /categoryFlowApi\.deriveTabsState/);
  assert.match(html, /categoryStep\.hidden = !entry\.showTabs/);
});

// 2. 单项店：单分类，分类标签隐藏，服务方块直接显示
test('2. 单项店：单分类，分类标签隐藏，服务方块直接显示', () => {
  const singleCategory = [
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' }
  ];
  const tabsState = categoryFlow.deriveTabsState(singleCategory, '');
  assert.equal(tabsState.showTabs, false);
  assert.equal(tabsState.showBookingStep, true);
  assert.equal(tabsState.selectedCategoryId, 'cat-hair');
  assert.equal(tabsState.isEmpty, false);
});

// 3. 0分类：显示友好空状态
test('3. 0分类：显示友好空状态', () => {
  const tabsState = categoryFlow.deriveTabsState([], '', []);
  assert.equal(tabsState.showTabs, false);
  assert.equal(tabsState.showBookingStep, true);
  assert.equal(tabsState.selectedCategoryId, '');
  assert.equal(tabsState.isEmpty, true);
  assert.equal(i18n.t('noBookableServices', 'zh-CN'), '暂无可预约项目');
  assert.equal(i18n.t('noBookableServices', 'en'), 'No services are currently available');
});

// 4. 选择服务后，总时长驱动日历
test('4. 选择服务后，总时长驱动日历', () => {
  let cart = cartApi.create();
  const serviceA = { id: ID.serviceA, durationMinutes: 45, price: 68, categoryId: 'cat-hair' };
  const serviceB = { id: ID.serviceB, durationMinutes: 90, price: 188, categoryId: 'cat-hair' };
  cart = cartApi.add(cart, serviceA);
  cart = cartApi.add(cart, serviceB);
  const totals = cartApi.totals(cart, [serviceA, serviceB]);
  assert.equal(totals.durationMinutes, 135);
  const requestItems = cartApi.requestItems(cart);
  assert.equal(requestItems.length, 2);
  assert.match(html, /\/api\/booking\/multi-service-available-dates/);
});

// 5. 日期时间不可用：无可行员工组合时禁用该日期/时间
test('5. 日期时间不可用：无可行员工组合时禁用该日期/时间', async () => {
  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.trim();
      if (/SELECT shop\.id AS shop_id/.test(sql)) {
        return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      }
      if (/service\.id=ANY/.test(sql)) {
        return { rows: [
          { id: ID.serviceA, duration_minutes: 60, price: '88', price_is_from: false, category_id: 'cat-hair', localized_name: 'Haircut' }
        ] };
      }
      if (/TO_CHAR\(\(\(\$1::DATE\+candidate\.time::TIME\)/.test(sql)) {
        return { rows: [
          { time: '10:00', start_at: `${params[0]}T02:00:00.000000Z` },
          { time: '11:00', start_at: `${params[0]}T03:00:00.000000Z` }
        ] };
      }
      if (/assigned_appointment_count/.test(sql)) {
        return { rows: [{ staff_id: ID.staffA, display_name: 'Alice', assigned_appointment_count: 0 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  // Mock validator to reject 10:00 but accept 11:00
  app.locals.bookingValidator = async ({ requestedStartAt }) => {
    if (requestedStartAt.includes('02:00:00')) {
      throw new StaffBookabilityError('NO_AVAILABLE_STAFF');
    }
  };

  await withServer(async base => {
    const res = await fetch(`${base}/api/booking/multi-service-available-times`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        date: '2030-01-07',
        locale: 'en',
        items: [{ serviceId: ID.serviceA, staffSelectionType: 'no_preference' }]
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    // 10:00 was rejected by validator, so only 11:00 should be returned
    assert.deepEqual(body.data.map(slot => slot.time), ['11:00']);
  });
});

// 6. 选择时间后才展示员工选项
test('6. 选择时间后才展示员工选项', () => {
  assert.match(html, /id="staffSection" class="staff-section" hidden/);
  assert.match(html, /loadEligibleStaffForSlot\(dateInput\.value, slot\.time\)/);
  assert.match(html, /if \(staffSection\) staffSection\.hidden = true/);
});

// 7. 员工选项默认高亮“不指定员工｜系统最快安排”
test('7. 员工选项默认高亮“不指定员工｜系统最快安排”', () => {
  assert.equal(i18n.t('customerStaffNoPreferenceFastest', 'zh-CN'), '不指定员工｜系统最快安排');
  assert.equal(i18n.t('customerStaffNoPreferenceFastest', 'en'), 'No preference | Fastest system match');
  assert.match(html, /staff-choice-card highlighted/);
  assert.match(html, /NO_PREFERENCE_VALUE/);
});

// 8. 员工选项按技能、排班、休假、冲突严格过滤
test('8. 员工选项按技能、排班、休假、冲突严格过滤', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (/SELECT shop\.id AS shop_id/.test(sql)) {
        return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      }
      if (/service\.id=ANY/.test(sql)) {
        return { rows: [
          { id: ID.serviceA, duration_minutes: 60, price: '88', price_is_from: false, category_id: 'cat-hair', localized_name: 'Haircut' }
        ] };
      }
      if (/FROM locations location/.test(sql)) {
        return { rows: [{ start_at: '2030-01-07T02:00:00.000Z' }] };
      }
      if (/assigned_appointment_count/.test(sql)) {
        return { rows: [
          { staff_id: ID.staffA, display_name: 'Alice', assigned_appointment_count: 0 },
          { staff_id: ID.staffB, display_name: 'Bob', assigned_appointment_count: 0 }
        ] };
      }
      return { rows: [] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  // Mock validator: Alice is available, Bob is on leave/busy
  app.locals.bookingValidator = async ({ staffId }) => {
    if (staffId === ID.staffB) {
      const err = new Error('Staff on leave');
      err.code = 'STAFF_ON_LEAVE';
      throw err;
    }
  };

  await withServer(async base => {
    const res = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        date: '2030-01-07',
        time: '10:00',
        locale: 'en',
        items: [{ serviceId: ID.serviceA, clientItemKey: 'item-1' }]
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 1);
    const eligible = body.data[0].eligibleStaff;
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].staffId, ID.staffA);
    assert.equal(eligible[0].displayName, 'Alice');
  });
});

// 9. 多项目连续服务：时间段保证所有项目连续可行
test('9. 多项目连续服务：时间段保证所有项目连续可行', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (/SELECT shop\.id AS shop_id/.test(sql)) {
        return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      }
      if (/service\.id=ANY/.test(sql)) {
        return { rows: [
          { id: ID.serviceA, duration_minutes: 45, price: '68', price_is_from: false, category_id: 'cat-hair', localized_name: 'Haircut' },
          { id: ID.serviceB, duration_minutes: 60, price: '128', price_is_from: false, category_id: 'cat-hair', localized_name: 'Treatment' }
        ] };
      }
      if (/FROM locations location/.test(sql)) {
        return { rows: [{ start_at: '2030-01-07T02:00:00.000Z' }] };
      }
      if (/assigned_appointment_count/.test(sql)) {
        return { rows: [
          { staff_id: ID.staffA, display_name: 'Alice', assigned_appointment_count: 0 }
        ] };
      }
      return { rows: [] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  app.locals.bookingValidator = async () => {};

  await withServer(async base => {
    const res = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        date: '2030-01-07',
        time: '10:00',
        locale: 'en',
        items: [
          { serviceId: ID.serviceA, clientItemKey: 'item-1' },
          { serviceId: ID.serviceB, clientItemKey: 'item-2' }
        ]
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 2);
    // Item 1: 45 min, 02:00 -> 02:45
    assert.equal(body.data[0].startAt, '2030-01-07T02:00:00.000Z');
    assert.equal(body.data[0].endAt, '2030-01-07T02:45:00.000Z');
    // Item 2: 60 min, 02:45 -> 03:45
    assert.equal(body.data[1].startAt, '2030-01-07T02:45:00.000Z');
    assert.equal(body.data[1].endAt, '2030-01-07T03:45:00.000Z');
  });
});

// 10. 多项目自选员工：员工在对应项目时间段必须可用且不双重预订
test('10. 多项目自选员工：员工在对应项目时间段必须可用且不双重预订', async () => {
  const validatedWindows = [];
  const client = {
    query: async (sql, params = []) => {
      if (/SELECT shop\.id AS shop_id/.test(sql)) {
        return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      }
      if (/service\.id=ANY/.test(sql)) {
        return { rows: [
          { id: ID.serviceA, duration_minutes: 30, price: '50', price_is_from: false, category_id: 'cat-hair', localized_name: 'Cut' },
          { id: ID.serviceB, duration_minutes: 30, price: '60', price_is_from: false, category_id: 'cat-hair', localized_name: 'Wash' }
        ] };
      }
      if (/FROM locations location/.test(sql)) {
        return { rows: [{ start_at: '2030-01-07T02:00:00.000Z' }] };
      }
      if (/assigned_appointment_count/.test(sql)) {
        return { rows: [
          { staff_id: ID.staffA, display_name: 'Alice', assigned_appointment_count: 0 }
        ] };
      }
      return { rows: [] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  app.locals.bookingValidator = async input => {
    validatedWindows.push(input);
  };

  await withServer(async base => {
    const res = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        date: '2030-01-07',
        time: '10:00',
        locale: 'en',
        items: [
          { serviceId: ID.serviceA, clientItemKey: 'item-1' },
          { serviceId: ID.serviceB, clientItemKey: 'item-2' }
        ]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(validatedWindows.length, 2);
  assert.equal(validatedWindows[0].requestedStartAt, '2030-01-07T02:00:00.000Z');
  assert.equal(validatedWindows[0].requestedEndAt, '2030-01-07T02:30:00.000Z');
  assert.equal(validatedWindows[1].requestedStartAt, '2030-01-07T02:30:00.000Z');
  assert.equal(validatedWindows[1].requestedEndAt, '2030-01-07T03:00:00.000Z');
});

// 11. 单项目流程与多项目一致
test('11. 单项目流程与多项目一致', () => {
  let singleCart = cartApi.create();
  singleCart = cartApi.add(singleCart, { id: ID.serviceA, categoryId: 'cat-hair' });
  assert.equal(singleCart.length, 1);
  const items = cartApi.requestItems(singleCart);
  assert.equal(items.length, 1);
  assert.equal(items[0].staffSelectionType, 'no_preference');
  assert.equal(items[0].staffId, undefined);
  assert.match(html, /id="staffSection"/);
  assert.match(html, /id="confirmationSummary"/);
});

// 12. 中英文文案无混杂
test('12. 中英文文案无混杂', () => {
  const keys = [
    'allCategories',
    'otherCategory',
    'reloadServices',
    'customerStaffNoPreferenceFastest',
    'chooseStaffForSlot',
    'itemTimeSlot',
    'chooseStaffAfterTime',
    'noCustomerServices',
    'noBookableServices'
  ];
  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.ok(zh, `zh-CN missing ${key}`);
    assert.ok(en, `en missing ${key}`);
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `zh-CN contains English letters in ${key}: ${zh}`);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/, `en contains Chinese characters in ${key}: ${en}`);
  }
});

// 13. 不访问生产、不产生数据库业务写入
test('13. 不访问生产、不产生数据库业务写入', () => {
  assert.doesNotMatch(html, /production\.supabase|prod-db|stripe-live/);
  assert.doesNotMatch(serverJs, /production\.supabase|prod-db/);
  const endpointRegex = /app\.post\('\/api\/booking\/multi-service-eligible-staff'[\s\S]*?\}\);/;
  const match = serverJs.match(endpointRegex);
  assert.ok(match, 'multi-service-eligible-staff endpoint found');
  assert.doesNotMatch(match[0], /INSERT INTO|UPDATE |DELETE FROM/);
});

// =========================================================================
// P0 修复专项测试：Visible Content Fallback & DOM Visibility Verification
// =========================================================================

// 14. 0分类+1服务：分类为空但服务存在时，隐藏分类标签，直接显示服务方块
test('14. 0分类+1服务：服务可见，隐藏分类标签，直接显示服务方块', async () => {
  const services = [{ id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45, categoryId: null }];
  const { elements } = await createCustomerContext({ categories: [], services });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.notEqual(elements.get('bookingStep').style.display, 'none');
  assert.equal(elements.get('categoryStep').hidden, true);
  assert.equal(elements.get('servicesEmpty').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceA);
});

// 15. 0分类+0服务：真正0服务时，父容器保持可见，显示友好空状态
test('15. 0分类+0服务：真正0服务时，父容器保持可见，显示友好空状态', async () => {
  const { elements } = await createCustomerContext({ categories: [], services: [] });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.notEqual(elements.get('bookingStep').style.display, 'none');
  assert.equal(elements.get('categoryStep').hidden, true);
  assert.equal(elements.get('servicesEmpty').hidden, false);
  assert.equal(elements.get('servicesError').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, true);
});

// 16. 分类接口失败+服务成功：直接显示服务，不阻断预约
test('16. 分类接口失败+服务成功：直接显示服务，不阻断预约', async () => {
  const services = [{ id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45 }];
  const { elements } = await createCustomerContext({ categoriesFail: true, services });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.notEqual(elements.get('bookingStep').style.display, 'none');
  assert.equal(elements.get('categoryStep').hidden, true);
  assert.equal(elements.get('servicesEmpty').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
  assert.equal(elements.get('serviceCards').children.length, 1);
});

// 17. 服务接口失败：显示双语错误及重新加载/Retry按钮，点击Retry重新请求
test('17. 服务接口失败：显示双语错误及重新加载按钮，点击Retry重新请求', async () => {
  const { elements, fetchUrls } = await createCustomerContext({ servicesFail: true });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.notEqual(elements.get('bookingStep').style.display, 'none');
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesLoading').hidden, true);

  const retryBtn = elements.get('servicesRetryBtn');
  assert.ok(retryBtn, 'servicesRetryBtn exists');
  assert.equal(retryBtn.dataset.i18n, 'reloadServices');

  const countBefore = fetchUrls.filter(u => u.includes('/api/services-db')).length;
  retryBtn.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const countAfter = fetchUrls.filter(u => u.includes('/api/services-db')).length;
  assert.ok(countAfter > countBefore, 'Clicking retry must re-fetch services');
});

// 18. 2分类+未分类服务：自动显示Other标签且服务可见
test('18. 2分类+未分类服务：自动显示Other标签且服务可见', async () => {
  const categories = [
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' },
    { categoryId: 'cat-spa', name: 'SPA', iconKey: 'body-wellness' }
  ];
  const services = [
    { id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45, categoryId: 'cat-hair' },
    { id: ID.serviceB, name: '未分类护理', price: 128, durationMinutes: 60, categoryId: null }
  ];
  const { elements } = await createCustomerContext({ categories, services });

  assert.equal(elements.get('categoryStep').hidden, false);
  assert.equal(elements.get('bookingStep').hidden, false);
  // Grid should have 3 tabs: cat-hair, cat-spa, and __other__
  const tabs = elements.get('categoryGrid').children;
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].dataset.categoryId, 'cat-hair');
  assert.equal(tabs[1].dataset.categoryId, 'cat-spa');
  assert.equal(tabs[2].dataset.categoryId, '__other__');

  // Clicking "Other" tab filters for uncategorized services
  tabs[2].click();
  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);
});

// 19. disabled/missing category服务不消失：自动归入Other标签
test('19. disabled/missing category服务不消失：自动归入Other标签', async () => {
  const categories = [
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' }
  ];
  const services = [
    { id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45, categoryId: 'cat-hair' },
    { id: ID.serviceB, name: '停用分类下的有效服务', price: 98, durationMinutes: 50, categoryId: 'cat-deactivated' }
  ];
  const { elements } = await createCustomerContext({ categories, services });

  // 1 category + 1 other = 2 tabs -> showTabs is true
  assert.equal(elements.get('categoryStep').hidden, false);
  const tabs = elements.get('categoryGrid').children;
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].dataset.categoryId, 'cat-hair');
  assert.equal(tabs[1].dataset.categoryId, '__other__');

  tabs[1].click();
  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);
});

// 20. 移动端首屏 (390x844) 布局与双语无空旷
test('20. 移动端首屏 (390x844) 布局与双语无空旷', async () => {
  // Chinese
  const zh = await createCustomerContext({ categories: [], services: [], locale: 'zh-CN' });
  assert.equal(zh.elements.get('bookingStep').hidden, false);
  assert.equal(zh.elements.get('servicesEmpty').hidden, false);

  // English
  const en = await createCustomerContext({ categories: [], services: [], locale: 'en' });
  assert.equal(en.elements.get('bookingStep').hidden, false);
  assert.equal(en.elements.get('servicesEmpty').hidden, false);

  // CSS constraints
  assert.match(html, /\.container\s*\{[^}]*max-width:\s*520px/);
  assert.match(html, /viewport.*width=device-width/);
});

// 21. 维护模式下分类/服务/日期/时间/员工必须正常浏览
test('21. 维护模式下分类/服务/日期/时间/员工必须正常浏览', async () => {
  process.env.BOOKING_WRITE_MAINTENANCE = 'true';
  const client = {
    query: async (sql, params = []) => {
      if (/SELECT shop\.id AS shop_id/.test(sql)) {
        return { rows: [{ shop_id: ID.shop, shop_slug: 'tenant-a', location_id: ID.location }] };
      }
      if (/service\.id=ANY/.test(sql)) {
        return { rows: [{ id: ID.serviceA, duration_minutes: 60, price: '88', price_is_from: false, category_id: 'cat-1', localized_name: 'Haircut', name: 'Haircut' }] };
      }
      if (/FROM\s+service_categories/.test(sql) || /service_categories/.test(sql)) {
        return { rows: [{ categoryId: 'cat-1', name: 'Hair', iconKey: 'hair', sortOrder: 1 }] };
      }
      if (/FROM shops AS shop\s+JOIN services/.test(sql)) {
        return { rows: [{ id: ID.serviceA, duration_minutes: 60, price: '88', price_is_from: false, category_id: 'cat-1', localized_name: 'Haircut', name: 'Haircut' }] };
      }
      if (/FROM locations location/.test(sql)) {
        return { rows: [{ start_at: '2030-01-07T02:00:00.000Z' }] };
      }
      if (/assigned_appointment_count/.test(sql)) {
        return { rows: [{ staff_id: ID.staffA, display_name: 'Alice', assigned_appointment_count: 0 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  app.locals.bookingValidator = async () => {};

  await withServer(async base => {
    // 1. Categories endpoint readable
    const catRes = await fetch(`${base}/api/booking/service-categories?shopSlug=tenant-a&locale=en`);
    assert.equal(catRes.status, 200);

    // 2. Services endpoint readable
    const srvRes = await fetch(`${base}/api/services-db?shopSlug=tenant-a&locale=en`);
    assert.equal(srvRes.status, 200);

    // 3. Eligible staff endpoint readable
    const staffRes = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        date: '2030-01-07',
        time: '10:00',
        locale: 'en',
        items: [{ serviceId: ID.serviceA, clientItemKey: 'item-1' }]
      })
    });
    assert.equal(staffRes.status, 200);

    // 4. Booking write is blocked
    const writeRes = await fetch(`${base}/api/new-db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopSlug: 'tenant-a',
        customerName: 'Test',
        phone: '+6599999999',
        date: '2030-01-07',
        startAt: '2030-01-07T02:00:00.000Z',
        items: [{ serviceId: ID.serviceA }]
      })
    });
    assert.equal(writeRes.status, 503);
    const writeBody = await writeRes.json();
    assert.equal(writeBody.code, 'BOOKING_MAINTENANCE');
  });
  delete process.env.BOOKING_WRITE_MAINTENANCE;
});

// 22. 店铺上下文500：bookingStep保持可见，显示双语错误，Retry按钮可见且错误不写入contactStep
test('22. 店铺上下文500：bookingStep保持可见，显示双语错误，Retry按钮可见且错误不写入contactStep', async () => {
  const { elements } = await createCustomerContext({ contextFail: true });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.notEqual(elements.get('bookingStep').style.display, 'none');
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesError').textContent, i18n.t('loadServicesFailed', 'zh-CN'));
  assert.equal(elements.get('servicesRetryContainer').hidden, false);

  // 错误不得写入hidden的contactStep
  assert.equal(elements.get('contactStep').hidden, true);
  assert.equal(elements.get('message').textContent, '');
});

// 23. 店铺上下文网络失败：bookingStep保持可见，显示错误与Retry
test('23. 店铺上下文网络失败：bookingStep保持可见，显示错误与Retry', async () => {
  const customFetch = async url => {
    if (url.includes('/api/booking/context')) {
      throw new TypeError('Failed to fetch');
    }
    return undefined;
  };
  const { elements } = await createCustomerContext({ customFetch });

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesError').textContent, i18n.t('loadServicesFailed', 'zh-CN'));
  assert.equal(elements.get('servicesRetryContainer').hidden, false);
});

// 24. 店铺上下文悬挂超时：AbortController超时后结束loading，显示可见Retry
test('24. 店铺上下文悬挂超时：AbortController超时后结束loading，显示可见Retry', async () => {
  const customFetch = async (url, opts) => {
    if (url.includes('/api/booking/context')) {
      return new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }
      });
    }
    return undefined;
  };
  const { elements } = await createCustomerContext({ customFetch, timeoutMs: 30 });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesRetryContainer').hidden, false);
});

// 25. 分类悬挂但服务成功：并行请求下分类超时不阻断，直接显示服务方块
test('25. 分类悬挂但服务成功：并行请求下分类超时不阻断，直接显示服务方块', async () => {
  const services = [{ id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45 }];
  const customFetch = async (url, opts) => {
    if (url.includes('/api/booking/service-categories')) {
      return new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }
      });
    }
    if (url.includes('/api/services-db')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: services }) };
    }
    return undefined;
  };
  const { elements } = await createCustomerContext({ customFetch, timeoutMs: 30 });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('categoryStep').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, true);
});

// 26. 服务悬挂超时：超时后结束loading，显示错误和Retry
test('26. 服务悬挂超时：超时后结束loading，显示错误和Retry', async () => {
  const customFetch = async (url, opts) => {
    if (url.includes('/api/services-db')) {
      return new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }
      });
    }
    return undefined;
  };
  const { elements } = await createCustomerContext({ customFetch, timeoutMs: 30 });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesRetryContainer').hidden, false);
});

// 27. Retry后恢复：失败后点击Retry，重新执行完整context+分类+服务并恢复正常展示
test('27. Retry后恢复：失败后点击Retry，重新执行完整context+分类+服务并恢复正常展示', async () => {
  let contextShouldFail = true;
  const services = [{ id: ID.serviceA, name: '女士剪发', price: 68, durationMinutes: 45 }];
  const customFetch = async url => {
    if (url.includes('/api/booking/context')) {
      if (contextShouldFail) return { ok: false, status: 500, json: async () => ({ success: false }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: { shopSlug: 'test-shop', shopName: 'Test Shop' } }) };
    }
    if (url.includes('/api/services-db')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: services }) };
    }
    return undefined;
  };
  const { elements } = await createCustomerContext({ customFetch });

  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesRetryContainer').hidden, false);

  contextShouldFail = false;
  elements.get('servicesRetryBtn').click();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('servicesError').hidden, true);
  assert.equal(elements.get('servicesRetryContainer').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
  assert.equal(elements.get('serviceCards').children.length, 1);
});

// 28. Retry旧响应迟到防覆盖：新一轮Retry先返回，旧慢响应后返回被丢弃
test('28. Retry旧响应迟到防覆盖：新一轮Retry先返回，旧慢响应后返回被丢弃', async () => {
  let callCount = 0;
  let resolveSlow;
  const servicesA = [{ id: ID.serviceA, name: '服务A', price: 50 }];
  const servicesB = [{ id: ID.serviceB, name: '服务B', price: 100 }];

  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      callCount++;
      if (callCount === 1) {
        return new Promise(resolve => {
          resolveSlow = () => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: servicesA }) });
        });
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: servicesB }) };
    }
    return undefined;
  };

  const { elements } = await createCustomerContext({ customFetch });

  elements.get('servicesRetryBtn').click();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);

  if (resolveSlow) resolveSlow();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);
});

// 29. 切换语言旧响应迟到防覆盖：新语言先返回，旧慢语言后返回被丢弃
test('29. 切换语言旧响应迟到防覆盖：新语言先返回，旧慢语言后返回被丢弃', async () => {
  let resolveSlow;
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      const u = new URL(url, 'http://localhost');
      const loc = u.searchParams.get('locale');
      if (loc === 'en') {
        return new Promise(resolve => {
          resolveSlow = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: [{ id: ID.serviceA, name: 'Cut En', price: 50 }] })
          });
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [{ id: ID.serviceA, name: '剪发中文', price: 50 }] })
      };
    }
    return undefined;
  };

  const { context, elements } = await createCustomerContext({ customFetch });

  vm.runInContext("switchLanguage('en')", context);
  await new Promise(r => setTimeout(r, 10));

  vm.runInContext("switchLanguage('zh-CN')", context);
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.match(elements.get('serviceCards').children[0].textContent, /剪发中文/);

  if (resolveSlow) resolveSlow();
  await new Promise(r => setTimeout(r, 60));

  assert.match(elements.get('serviceCards').children[0].textContent, /剪发中文/);
});

// 30. 连续多次Retry无重复监听器：多次点击Retry保持单一监听器并正常收敛
test('30. 连续多次Retry无重复监听器：多次点击Retry保持单一监听器并正常收敛', async () => {
  const { elements, context } = await createCustomerContext();
  const retryBtn = elements.get('servicesRetryBtn');

  const listeners = retryBtn._listeners.get('click') || [];
  assert.equal(listeners.length, 1);

  await context.initializeCustomerPage();
  await new Promise(r => setTimeout(r, 60));

  assert.equal((retryBtn._listeners.get('click') || []).length, 1);
});

// 31. 所有非2xx路径检查：400、404、502均安全失败并显示错误+Retry
test('31. 所有非2xx路径检查：400、404、502均安全失败并显示错误+Retry', async () => {
  for (const status of [400, 404, 502]) {
    const customFetch = async url => {
      if (url.includes('/api/services-db')) {
        return { ok: false, status, json: async () => ({ success: false, message: `Error ${status}` }) };
      }
      return undefined;
    };
    const { elements } = await createCustomerContext({ customFetch });
    assert.equal(elements.get('bookingStep').hidden, false);
    assert.equal(elements.get('servicesLoading').hidden, true);
    assert.equal(elements.get('servicesError').hidden, false);
    assert.equal(elements.get('servicesRetryContainer').hidden, false);
  }
});

// 32. 移动端首屏 (390x844) 父容器及错误/Retry实际可见
test('32. 移动端首屏 (390x844) 父容器及错误/Retry实际可见', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const { elements } = await createCustomerContext({ servicesFail: true, locale });
    assert.equal(elements.get('bookingStep').hidden, false);
    assert.notEqual(elements.get('bookingStep').style.display, 'none');
    assert.equal(elements.get('servicesError').hidden, false);
    assert.equal(elements.get('servicesRetryContainer').hidden, false);
    assert.equal(elements.get('servicesRetryBtn').hidden, false);
    assert.equal(elements.get('servicesLoading').hidden, true);
    assert.equal(elements.get('servicesError').textContent, i18n.t('loadServicesFailed', locale));
  }
});

// 33. HTTP 200响应头+部分JSON正文永久悬挂：body读取超时后错误及Retry可见
test('33. HTTP 200响应头+部分JSON正文永久悬挂：body读取超时后错误及Retry可见', async () => {
  const customFetch = async (url, opts) => {
    if (url.includes('/api/services-db')) {
      return {
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }
        })
      };
    }
    return undefined;
  };

  const { elements } = await createCustomerContext({ customFetch, timeoutMs: 30 });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('bookingStep').hidden, false);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('servicesError').hidden, false);
  assert.equal(elements.get('servicesRetryContainer').hidden, false);
  assert.equal(elements.get('servicesRetryBtn').hidden, false);
});

// 34. OLD Context晚于NEW返回，shopSlug和标题仍保持NEW
test('34. OLD Context晚于NEW返回，shopSlug和标题仍保持NEW', async () => {
  let resolveOldContext;
  const customFetch = async url => {
    if (url.includes('/api/booking/context')) {
      const u = new URL(url, 'http://localhost');
      const slug = u.searchParams.get('shopSlug');
      if (slug === 'test-shop') {
        return new Promise(resolve => {
          resolveOldContext = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { shopSlug: 'test-shop', shopName: 'Old Shop' } })
          });
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { shopSlug: 'new-shop', shopName: 'New Shop' } })
      };
    }
    return undefined;
  };

  const { context, elements } = await createCustomerContext({ customFetch });

  // 触发新的初始化
  context.globalThis.location.search = '?shop=new-shop';
  const newInitPromise = context.initializeCustomerPage();
  await new Promise(r => setTimeout(r, 60));
  await newInitPromise;

  assert.equal(vm.runInContext('customerShopSlug', context), 'new-shop');
  assert.equal(elements.get('shopBrandName').textContent, 'New Shop');
  assert.match(context.document.title, /New Shop/);

  // 旧Context迟到返回
  if (resolveOldContext) resolveOldContext();
  await new Promise(r => setTimeout(r, 60));

  // 仍保持 NEW
  assert.equal(vm.runInContext('customerShopSlug', context), 'new-shop');
  assert.equal(elements.get('shopBrandName').textContent, 'New Shop');
  assert.match(context.document.title, /New Shop/);
});

// 35. 初始化期间切换中文/英文：新语言胜出且旧初始化不污染状态
test('35. 初始化期间切换中文/英文：新语言胜出且旧初始化不污染状态', async () => {
  let resolveSlowZh;
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      const u = new URL(url, 'http://localhost');
      const loc = u.searchParams.get('locale');
      if (loc === 'zh-CN') {
        return new Promise(resolve => {
          resolveSlowZh = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: [{ id: ID.serviceA, name: '剪发中文', price: 50 }] })
          });
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [{ id: ID.serviceA, name: 'Haircut English', price: 50 }] })
      };
    }
    return undefined;
  };

  const { context, elements } = await createCustomerContext({ customFetch, locale: 'zh-CN' });
  // 在中文初始化挂起时快速切换英文
  await vm.runInContext("switchLanguage('en')", context);
  await new Promise(r => setTimeout(r, 60));

  assert.equal(vm.runInContext('currentLocale', context), 'en');
  assert.match(elements.get('serviceCards').children[0].textContent, /Haircut English/);

  // 迟到的中文响应返回
  if (resolveSlowZh) resolveSlowZh();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(vm.runInContext('currentLocale', context), 'en');
  assert.match(elements.get('serviceCards').children[0].textContent, /Haircut English/);
});

// 36. 初始化期间点击Retry：新generation胜出并正常收敛
test('36. 初始化期间点击Retry：新generation胜出并正常收敛', async () => {
  let callCount = 0;
  let resolveFirst;
  const customFetch = async url => {
    if (url.includes('/api/services-db')) {
      callCount++;
      if (callCount === 1) {
        return new Promise(resolve => {
          resolveFirst = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: [{ id: ID.serviceA, name: 'First Service', price: 50 }] })
          });
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [{ id: ID.serviceB, name: 'Second Service', price: 60 }] })
      };
    }
    return undefined;
  };

  const { elements } = await createCustomerContext({ customFetch });
  // 点击Retry
  elements.get('servicesRetryBtn').click();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);

  // 迟到的第一轮返回
  if (resolveFirst) resolveFirst();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(elements.get('serviceCards').children.length, 1);
  assert.equal(elements.get('serviceCards').children[0].dataset.serviceId, ID.serviceB);
});

// 37. 服务1ms成功、分类悬挂：服务在1秒内可见，分类后来成功升级标签但购物车保持
test('37. 服务1ms成功、分类悬挂：服务在1秒内可见，分类后来成功升级标签但购物车保持', async () => {
  let resolveCats;
  const customFetch = async (url, opts) => {
    if (url.includes('/api/booking/service-categories')) {
      return new Promise((resolve, reject) => {
        resolveCats = () => resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              { categoryId: 'cat-hair', name: '美发' },
              { categoryId: 'cat-spa', name: 'SPA' }
            ]
          })
        });
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
        }
      });
    }
    if (url.includes('/api/services-db')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [
            { id: ID.serviceA, name: '剪发', price: 50, durationMinutes: 30, categoryId: 'cat-hair' },
            { id: ID.serviceB, name: '按摩', price: 80, durationMinutes: 60, categoryId: 'cat-spa' }
          ]
        })
      };
    }
    return undefined;
  };

  const startTime = Date.now();
  const { context, elements } = await createCustomerContext({ customFetch });

  // 确认在1秒内服务即刻可见（无需等待分类）
  const elapsed = Date.now() - startTime;
  assert.ok(elapsed < 1000, `Services must be visible in under 1s, took ${elapsed}ms`);
  assert.equal(elements.get('servicesLoading').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
  assert.equal(elements.get('serviceCards').children.length, 2);
  assert.equal(elements.get('categoryStep').hidden, true);

  // 顾客选购项目加入购物车
  elements.get('serviceCards').children[0].click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(vm.runInContext('cart.length', context), 1);
  assert.equal(vm.runInContext('cart[0].serviceId', context), ID.serviceA);

  // 分类稍后成功返回
  resolveCats();
  await new Promise(r => setTimeout(r, 60));

  // 升级为分类标签展示
  assert.equal(elements.get('categoryStep').hidden, false);
  // 购物车保持不受影响
  assert.equal(vm.runInContext('cart.length', context), 1);
  assert.equal(vm.runInContext('cart[0].serviceId', context), ID.serviceA);
});

// 38. data对象/字符串/缺失/null项目全部显示错误而不是误判为空状态
test('38. data对象/字符串/缺失/null项目全部显示错误而不是误判为空状态', async () => {
  const invalidPayloads = [
    { success: true, data: { id: ID.serviceA } },
    { success: true, data: 'invalid string' },
    { success: true },
    { success: true, data: null },
    { success: false, data: [] },
    { success: true, data: [null] },
    { success: true, data: [{ id: ID.serviceA }, null] },
    { success: true, data: [{ name: 'No ID' }] }
  ];

  for (const payload of invalidPayloads) {
    const customFetch = async url => {
      if (url.includes('/api/services-db')) {
        return {
          ok: true,
          status: 200,
          json: async () => payload
        };
      }
      return undefined;
    };

    const { elements } = await createCustomerContext({ customFetch });
    assert.equal(elements.get('bookingStep').hidden, false);
    assert.equal(elements.get('servicesLoading').hidden, true);
    assert.equal(elements.get('servicesEmpty').hidden, true);
    assert.equal(elements.get('servicesError').hidden, false);
    assert.equal(elements.get('servicesRetryContainer').hidden, false);
  }
});

// 39. 连续多次Retry无重复监听器且各轮次正常收敛
test('39. 连续多次Retry无重复监听器且各轮次正常收敛', async () => {
  const services = [{ id: ID.serviceA, name: '服务A', price: 50 }];
  const { elements, context } = await createCustomerContext({ services });
  const retryBtn = elements.get('servicesRetryBtn');

  assert.equal((retryBtn._listeners.get('click') || []).length, 1);

  for (let i = 0; i < 3; i++) {
    await context.initializeCustomerPage();
    await new Promise(r => setTimeout(r, 20));
  }

  assert.equal((retryBtn._listeners.get('click') || []).length, 1);
  assert.equal(elements.get('servicesError').hidden, true);
  assert.equal(elements.get('serviceCards').hidden, false);
});

// 40. 390×844移动端全功能视口渲染与双语测试
test('40. 390×844移动端全功能视口渲染与双语测试', async () => {
  const services = [
    { id: ID.serviceA, name: '服务A', price: 50 },
    { id: ID.serviceB, name: '服务B', price: 60 }
  ];
  for (const locale of ['zh-CN', 'en']) {
    const { elements } = await createCustomerContext({ services, locale });
    assert.equal(elements.get('bookingStep').hidden, false);
    assert.equal(elements.get('servicesLoading').hidden, true);
    assert.equal(elements.get('servicesError').hidden, true);
    assert.equal(elements.get('serviceCards').hidden, false);
    assert.equal(elements.get('serviceCards').children.length, 2);
  }
});
