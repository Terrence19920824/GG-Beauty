'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');
const { StaffBookabilityError } = require('../lib/staff-bookability-validator');
const categoryFlow = require('../public/customer-category-flow');
const cartApi = require('../public/customer-multi-service-cart');
const i18n = require('../public/shared-i18n');

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
  assert.match(html, /bookingStep\.hidden = !entry\.showBookingStep/);
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
  const tabsState = categoryFlow.deriveTabsState([], '');
  assert.equal(tabsState.showTabs, false);
  assert.equal(tabsState.showBookingStep, false);
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
  // Alice was validated separately for the two sequential windows without overlap
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
  // HTML uses same scheduleSection, staffSection, and confirmationSummary
  assert.match(html, /id="staffSection"/);
  assert.match(html, /id="confirmationSummary"/);
});

// 12. 中英文文案无混杂
test('12. 中英文文案无混杂', () => {
  const keys = [
    'allCategories',
    'customerStaffNoPreferenceFastest',
    'chooseStaffForSlot',
    'itemTimeSlot',
    'chooseStaffAfterTime'
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
  // Endpoint must be read-only (no INSERT/UPDATE/DELETE)
  const endpointRegex = /app\.post\('\/api\/booking\/multi-service-eligible-staff'[\s\S]*?\}\);/;
  const match = serverJs.match(endpointRegex);
  assert.ok(match, 'multi-service-eligible-staff endpoint found');
  assert.doesNotMatch(match[0], /INSERT INTO|UPDATE |DELETE FROM/);
});
