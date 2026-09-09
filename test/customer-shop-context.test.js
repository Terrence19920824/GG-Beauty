'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shopContext = require('../public/customer-shop-context');
const { app } = require('../server');

const customerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const withServer = async operation => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('production root derives its merchant slug from the controlled host', () => {
  assert.equal(shopContext.resolveCandidate({ hostname: 'gg-beauty.onrender.com', pathname: '/', search: '' }), 'gg-beauty');
});

test('explicit query and route contexts support test and multi-merchant entry points', () => {
  assert.equal(shopContext.resolveCandidate({ hostname: 'localhost', pathname: '/', search: '?shop=gg-beauty-test' }), 'gg-beauty-test');
  assert.equal(shopContext.resolveCandidate({ hostname: 'example.com', pathname: '/book/merchant-a', search: '' }), 'merchant-a');
  assert.equal(shopContext.resolveCandidate({ hostname: 'localhost', pathname: '/', search: '' }), '');
  assert.equal(shopContext.resolveCandidate({ hostname: 'example.com', pathname: '/', search: '?shop=../bad' }), '');
});

test('server resolves active shop by slug and returns no tenant id', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ shop_id: 'private-id', shop_slug: 'merchant-a', location_id: 'private-location' }] };
    },
    release() {}
  };
  app.locals.bookingPool = { connect: async () => client };
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/booking/context?shopSlug=merchant-a`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: { shopSlug: 'merchant-a' } });
  });
  assert.deepEqual(queries[0].params, ['merchant-a']);
  assert.match(queries[0].sql, /shop\.slug = \$1/);
  assert.match(queries[0].sql, /shop\.status = 'active'/);
});

test('unknown slug fails safely and client tenant ids are rejected before database access', async () => {
  let connectCount = 0;
  const client = { query: async () => ({ rows: [] }), release() {} };
  app.locals.bookingPool = { connect: async () => { connectCount += 1; return client; } };
  await withServer(async baseUrl => {
    const unknown = await fetch(`${baseUrl}/api/booking/context?shopSlug=unknown-shop`);
    assert.equal(unknown.status, 404);
    const spoofed = await fetch(`${baseUrl}/api/booking/context?shopSlug=merchant-a&shop_id=forged`);
    assert.equal(spoofed.status, 400);
  });
  assert.equal(connectCount, 1);
});

test('customer uses one server-confirmed shop context for every booking request', () => {
  assert.doesNotMatch(customerHtml, /const SHOP_SLUG/);
  assert.doesNotMatch(customerHtml, /gg-beauty-test/);
  assert.match(customerHtml, /\/api\/booking\/context\?shopSlug=/);
  assert.match(customerHtml, /\/api\/services-db\?shopSlug=\$\{encodeURIComponent\(customerShopSlug\)\}/);
  assert.match(customerHtml, /\/api\/booking\/staff-options\?shopSlug=\$\{encodeURIComponent\(customerShopSlug\)\}/);
  assert.match(customerHtml, /\?shopSlug=\$\{encodeURIComponent\(customerShopSlug\)\}/);
  assert.match(customerHtml, /shopSlug: customerShopSlug/);
  assert.ok(customerHtml.indexOf('await loadCustomerShopContext()') < customerHtml.lastIndexOf('await setLocale(currentLocale)'));
});
