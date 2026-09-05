'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');
const {
  normalizeLocale,
  browserLocale,
  resolveLocalizedService,
  STORAGE_KEY
} = require('../public/service-locale');

const root = path.resolve(__dirname, '..');
const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  service: '44444444-4444-4444-8444-444444444444'
};

test('locale normalization follows Chinese variants and defaults others to English', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans']) assert.equal(normalizeLocale(locale), 'zh-CN');
  for (const locale of ['en', 'ms', 'th', 'id', 'vi', undefined]) assert.equal(normalizeLocale(locale), 'en');
  assert.equal(browserLocale({ languages: ['en-SG', 'zh-Hans'] }), 'zh-CN');
  assert.equal(browserLocale({ language: 'en-SG' }), 'en');
  assert.equal(STORAGE_KEY, 'gg_beauty_locale');
});

test('localized resolver follows requested, English, Chinese, canonical fallback', () => {
  const service = { name: 'Canonical', description: 'Canonical detail', translations: {
    en: { name: 'English', description: 'English detail' },
    'zh-CN': { name: '中文', description: '中文说明' }
  } };
  assert.equal(resolveLocalizedService(service, 'zh-SG').name, '中文');
  assert.equal(resolveLocalizedService({ ...service, translations: { en: service.translations.en } }, 'zh').name, 'English');
  assert.equal(resolveLocalizedService({ ...service, translations: { 'zh-CN': service.translations['zh-CN'] } }, 'en').name, '中文');
  assert.equal(resolveLocalizedService({ name: 'Canonical', translations: {} }, 'en').name, 'Canonical');
});

const migrationSql = () => ({
  preflight: fs.readFileSync(path.join(root, 'migrations/010_service_translations_preflight_readonly.sql'), 'utf8'),
  schema: fs.readFileSync(path.join(root, 'migrations/011_service_translations_schema.sql'), 'utf8'),
  backfill: fs.readFileSync(path.join(root, 'migrations/012_service_translations_backfill.sql'), 'utf8')
});

test('010 preflight is database-enforced read-only with no write SQL', () => {
  const { preflight } = migrationSql();
  assert.match(preflight, /BEGIN TRANSACTION READ ONLY/);
  assert.doesNotMatch(preflight, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(preflight, /service_translations: EXPECTED ABSENT/);
});

test('010 validates complete translation columns and fails closed on drift', () => {
  const { preflight } = migrationSql();
  for (const column of ['id', 'shop_id', 'service_id', 'locale', 'name', 'description', 'created_at', 'updated_at']) {
    assert.match(preflight, new RegExp(`column_shape -> '${column}'`));
  }
  assert.match(preflight, /RAISE EXCEPTION 'service i18n preflight: service_translations column drift'/);
  assert.match(preflight, /column_count <> 8/);
  assert.match(preflight, /service_translations default drift/);
});

test('010 validates actual PK unique FK checks and index definitions', () => {
  const { preflight } = migrationSql();
  assert.match(preflight, /contype = 'p'/);
  assert.match(preflight, /ARRAY\['shop_id', 'service_id', 'locale'\]::name\[\]/);
  assert.match(preflight, /contype = 'f'[\s\S]*confrelid = 'public\.services'::regclass[\s\S]*confdeltype = 'r'/);
  assert.match(preflight, /service_translations locale CHECK drift/);
  assert.match(preflight, /service_translations name CHECK drift/);
  assert.match(preflight, /ARRAY\['shop_id', 'locale', 'service_id'\]::name\[\]/);
});

test('010 validates optional column type nullability default and locale check', () => {
  const { preflight } = migrationSql();
  assert.match(preflight, /atttypid = 'boolean'::regtype AND a\.attnotnull/);
  assert.match(preflight, /IN \('false', 'false::boolean'\)/);
  assert.match(preflight, /atttypid = 'text'::regtype[\s\S]*NOT attnotnull/);
  assert.match(preflight, /service_locale_snapshot CHECK drift/);
});

test('011 has bounded locks and rejects existing drift before idempotent DDL', () => {
  const { schema } = migrationSql();
  assert.match(schema, /SET LOCAL lock_timeout = '5s'/);
  assert.match(schema, /SET LOCAL statement_timeout = '30s'/);
  assert.match(schema, /price_is_from schema drift/);
  assert.match(schema, /service_locale_snapshot (?:column|CHECK) drift/);
  assert.match(schema, /service_translations (?:column|PK|UNIQUE|tenant FK|locale CHECK|name CHECK|lookup index) drift/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS public\.service_translations/);
  assert.ok(schema.indexOf('schema drift') < schema.indexOf('ALTER TABLE public.services'));
});

test('011 validates final schema and preserves tenant-safe constraints', () => {
  const { schema } = migrationSql();
  assert.match(schema, /FOREIGN KEY \(shop_id, service_id\)[\s\S]*REFERENCES public\.services \(shop_id, id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(schema, /price_is_from BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /service_locale_snapshot TEXT NULL/);
  assert.match(schema, /final price_is_from validation failed/);
  assert.match(schema, /final snapshot validation failed/);
  assert.match(schema, /final constraint\/index validation failed/);
});

test('012 has bounded locks and remains idempotent without snapshot rewrites', () => {
  const { backfill } = migrationSql();
  assert.match(backfill, /SET LOCAL lock_timeout = '5s'/);
  assert.match(backfill, /SET LOCAL statement_timeout = '30s'/);
  assert.match(backfill, /'en'/);
  assert.match(backfill, /ON CONFLICT \(shop_id, service_id, locale\) DO NOTHING/);
  assert.doesNotMatch(backfill, /UPDATE\s+(public\.)?(services|appointment_items)/i);
  assert.doesNotMatch(backfill, /service_(?:name|locale)_snapshot/i);
});

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

function publicPool() {
  const state = { queries: [], released: 0 };
  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql: sql.trim(), params });
      if (/FROM shops AS shop/.test(sql)) return { rows: [{ id: ID.service, category: 'Hair', price: '168.00', priceIsFrom: true, durationMinutes: 150, name: params[1] === 'zh-CN' ? '热烫' : 'Digital Perm', description: null, locale: params[1] }] };
      if (/FROM shops\s/.test(sql)) return { rows: [{ id: ID.shop }] };
      if (/FROM locations\s/.test(sql) && !/WITH scoped_location/.test(sql)) return { rows: [{ id: ID.location }] };
      if (/FROM staff\s/.test(sql)) return { rows: [{ id: ID.staff }] };
      if (/FROM services\s/.test(sql)) return { rows: [{ id: ID.service, duration_minutes: 150 }] };
      if (/WITH scoped_location/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { state.released += 1; }
  };
  return { state, pool: { async connect() { return client; } } };
}

test('customer service API localizes display without changing price or duration', async () => {
  const fixture = publicPool();
  app.locals.bookingPool = fixture.pool;
  await withServer(async baseUrl => {
    const zh = await fetch(`${baseUrl}/api/services-db?shopSlug=test-shop&locale=zh-SG`).then(response => response.json());
    const en = await fetch(`${baseUrl}/api/services-db?shopSlug=test-shop&locale=en`).then(response => response.json());
    assert.equal(zh.data[0].name, '热烫');
    assert.equal(en.data[0].name, 'Digital Perm');
    assert.equal(zh.data[0].price, en.data[0].price);
    assert.equal(zh.data[0].durationMinutes, en.data[0].durationMinutes);
  });
  assert.equal(fixture.state.released, 2);
});

test('availability uses tenant service id and never localized display name identity', async () => {
  const fixture = publicPool();
  app.locals.bookingPool = fixture.pool;
  app.locals.bookingValidator = async () => {};
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/available-times-db?shopSlug=test-shop&date=2030-01-07&staff=Test%20Staff&serviceId=${ID.service}`);
    assert.equal(response.status, 200);
  });
  const query = fixture.state.queries.find(item => /FROM services\s/.test(item.sql));
  assert.deepEqual(query.params, [ID.shop, ID.service, null]);
  assert.match(query.sql, /id = \$2::UUID/);
});

test('customer UI sends serviceId and locale and displays from-price in both languages', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /serviceId: service\.id/);
  assert.match(html, /locale: currentLocale/);
  assert.match(html, /From /);
  assert.match(html, / 起/);
  assert.doesNotMatch(html, /service:\s*service\.name/);
});
