'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');
const categoryFlow = require('../public/customer-category-flow');
const i18n = require('../public/shared-i18n');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('zero, smart-entry and card entry states are deterministic', () => {
  assert.deepEqual(categoryFlow.deriveEntryState([], ''), {
    selectedCategoryId: '', showCategoryCards: false, showBookingStep: false, isEmpty: true
  });
  assert.deepEqual(categoryFlow.deriveEntryState([{ categoryId: 'one' }], ''), {
    selectedCategoryId: 'one', showCategoryCards: false, showBookingStep: true, isEmpty: false
  });
  assert.deepEqual(categoryFlow.deriveEntryState([{ categoryId: 'one' }, { categoryId: 'two' }], ''), {
    selectedCategoryId: '', showCategoryCards: true, showBookingStep: false, isEmpty: false
  });
});

test('selected category identity survives locale rerender and filters by categoryId', () => {
  const localized = [{ categoryId: 'hair', name: '美发' }, { categoryId: 'beauty', name: '美容' }];
  assert.equal(categoryFlow.deriveEntryState(localized, 'beauty').selectedCategoryId, 'beauty');
  assert.deepEqual(categoryFlow.filterServicesByCategory([
    { id: 'service-a', categoryId: 'hair' },
    { id: 'service-b', categoryId: 'beauty' }
  ], 'beauty').map(service => service.id), ['service-b']);
});

test('unknown icon uses one safe fallback and empty state is bilingual', () => {
  assert.equal(categoryFlow.categoryIcon('merchant-custom-icon'), '◇');
  assert.equal(i18n.t('noCustomerServices', 'zh-CN'), '当前暂无可预约服务');
  assert.equal(i18n.t('noCustomerServices', 'en'), 'No services are currently available for booking.');
});

test('public category API is tenant-scoped, localized, sorted and minimal', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ categoryId: 'category-a', name: 'Hair', iconKey: 'hair', sortOrder: 10 }] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/booking/service-categories?shopSlug=merchant-a&locale=en&shopId=forged`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: [{ categoryId: 'category-a', name: 'Hair', iconKey: 'hair', sortOrder: 10 }]
    });
  });
  assert.deepEqual(queries[0].params, ['merchant-a', 'en']);
  assert.match(queries[0].sql, /category\.shop_id = shop\.id/);
  assert.match(queries[0].sql, /category\.is_active = TRUE/);
  assert.match(queries[0].sql, /service\.shop_id = category\.shop_id/);
  assert.match(queries[0].sql, /service\.is_active = TRUE/);
  assert.match(queries[0].sql, /service\.bookable = TRUE/);
  assert.match(queries[0].sql, /ORDER BY category\.sort_order ASC, category\.id ASC/);
  assert.match(queries[0].sql, /COALESCE\(requested\.name, english\.name, chinese\.name, category\.canonical_name\)/);
  assert.doesNotMatch(JSON.stringify(queries[0].params), /forged/);
});

test('customer UI renders dynamic two-column cards without hardcoded category names', () => {
  assert.match(html, /id="categoryGrid" class="category-grid"/);
  assert.match(html, /id="contactStep" class="card" hidden/);
  assert.match(html, /contactStep\.hidden = !entry\.showBookingStep/);
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /\/api\/booking\/service-categories\?shopSlug=\$\{encodeURIComponent\(customerShopSlug\)\}/);
  assert.match(html, /button\.dataset\.categoryId = category\.categoryId/);
  assert.match(html, /filterServicesByCategory\(availableServices, selectedCategoryId\)/);
  assert.doesNotMatch(html, />\s*(Hair|Beauty|Nails)\s*</);
});

test('existing staff, time and booking flow remains downstream of service identity', () => {
  assert.match(html, /option\.value = service\.id/);
  assert.match(html, /option\.value = member\.staffId/);
  assert.match(html, /\/api\/booking\/staff-options/);
  assert.match(html, /\/api\/available-times-db/);
  assert.match(html, /serviceId: service\.id/);
  assert.match(html, /staffSelectionType: noPreference \? 'no_preference' : 'specific'/);
});
