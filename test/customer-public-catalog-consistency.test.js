'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const cartApi = require('../public/customer-multi-service-cart');
const categoryFlow = require('../public/customer-category-flow');
const i18n = require('../public/shared-i18n');
const shopContext = require('../public/customer-shop-context');
const bookingCalendar = require('../public/customer-booking-calendar');

const id = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  catBeauty: '33333333-3333-4333-8333-111111111111',
  catHair: '33333333-3333-4333-8333-222222222222',
  srvFacial: '44444444-4444-4444-8444-111111111111',
  srvBalayage: '44444444-4444-4444-8444-222222222222',
  staffAmy: '55555555-5555-4555-8555-111111111111',
  staffBob: '55555555-5555-4555-8555-222222222222'
};

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE shops (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  status text NOT NULL
);

CREATE TABLE locations (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  timezone text NOT NULL,
  is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, id)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL,
  bookable boolean NOT NULL,
  UNIQUE(shop_id, id)
);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  canonical_name text NOT NULL DEFAULT 'Category',
  icon_key text NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, id)
);

CREATE TABLE service_category_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  category_id uuid NOT NULL,
  locale text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, category_id, locale),
  FOREIGN KEY (shop_id, category_id) REFERENCES service_categories(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE services (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  category text NULL,
  category_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  duration_minutes integer NOT NULL,
  price numeric NOT NULL,
  price_is_from boolean NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL,
  bookable boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, id),
  FOREIGN KEY (shop_id, category_id) REFERENCES service_categories(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE service_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  service_id uuid NOT NULL,
  locale text NOT NULL,
  name text,
  description text,
  UNIQUE(shop_id, service_id, locale),
  FOREIGN KEY (shop_id, service_id) REFERENCES services(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE staff_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  is_active boolean NOT NULL,
  UNIQUE(shop_id, staff_id, service_id),
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, service_id) REFERENCES services(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE staff_location_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  is_active boolean NOT NULL,
  UNIQUE(shop_id, location_id, staff_id),
  FOREIGN KEY (shop_id, location_id) REFERENCES locations(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE staff_location_working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  day_of_week integer NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  is_active boolean NOT NULL,
  effective_from date,
  effective_to date,
  FOREIGN KEY (shop_id, location_id) REFERENCES locations(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE staff_schedule_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  schedule_date date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  approval_status text NOT NULL DEFAULT 'approved',
  override_type text NOT NULL,
  start_time time,
  end_time time
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  name text NOT NULL,
  phone text NOT NULL,
  phone_normalized text,
  email text,
  UNIQUE(shop_id, id)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  appointment_no text NOT NULL DEFAULT ('GG-' || substr(gen_random_uuid()::text, 1, 8)),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL,
  booking_source text,
  override_conflict boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id, location_id, id),
  UNIQUE(shop_id, id),
  FOREIGN KEY(shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id, service_id) REFERENCES services(shop_id, id) ON DELETE RESTRICT,
  CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist(
    staff_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed') AND override_conflict = false)
);

CREATE TABLE appointment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  service_id uuid NOT NULL,
  sequence_no integer NOT NULL,
  service_name_snapshot text NOT NULL,
  service_locale_snapshot text,
  duration_minutes_snapshot integer NOT NULL,
  price_snapshot numeric,
  snapshot_source text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_items_time_range_check CHECK(end_at > start_at),
  UNIQUE(shop_id, location_id, id),
  FOREIGN KEY(shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id, service_id) REFERENCES services(shop_id, id) ON DELETE RESTRICT
);

CREATE TABLE appointment_item_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  appointment_item_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('primary', 'assistant')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  blocks_time boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at > start_at),
  UNIQUE(shop_id, location_id, appointment_item_id, staff_id),
  FOREIGN KEY(shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX appointment_item_staff_primary_uidx
  ON appointment_item_staff_assignments(shop_id, location_id, appointment_item_id) WHERE role = 'primary';
`;

const withServer = async (app, operation) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

test('PostgreSQL: dual Beauty and Hair categories qualification, cache invalidation, and date/time consistency', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-catalog-consistency-pg-'));
  const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 57000 + Math.floor(Math.random() * 400);
  const pg = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;
  let pool;

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        db = new Client({ connectionString: url });
        await db.connect();
        break;
      } catch {
        if (db) await db.end().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(db, 'Connected to test database');
    await db.query(SCHEMA);

    // Seed shop & location
    await db.query(`INSERT INTO shops VALUES($1, 'gg-beauty', 'GG Beauty & Hair', 'active')`, [id.shop]);
    await db.query(`INSERT INTO locations VALUES($1, $2, 'Asia/Singapore', true)`, [id.location, id.shop]);

    // Seed categories: Beauty and Hair
    await db.query(`INSERT INTO service_categories(id, shop_id, canonical_name, icon_key, sort_order, is_active) VALUES
      ($1, $3, 'Beauty', 'beauty', 1, true),
      ($2, $3, 'Hair', 'hair', 2, true)`,
      [id.catBeauty, id.catHair, id.shop]
    );
    await db.query(`INSERT INTO service_category_translations(shop_id, category_id, locale, name) VALUES
      ($1, $2, 'en', 'Beauty'), ($1, $2, 'zh-CN', '美容'),
      ($1, $3, 'en', 'Hair'), ($1, $3, 'zh-CN', '美发')`,
      [id.shop, id.catBeauty, id.catHair]
    );

    // Seed services: Facial (Beauty) and Balayage (Hair)
    await db.query(`INSERT INTO services(id, shop_id, category, category_id, name, duration_minutes, price, price_is_from, sort_order, is_active, bookable) VALUES
      ($1, $3, 'Beauty', $4, 'Basic Facial', 60, 88, false, 1, true, true),
      ($2, $3, 'Hair', $5, 'Balayage', 180, 238, true, 2, true, true)`,
      [id.srvFacial, id.srvBalayage, id.shop, id.catBeauty, id.catHair]
    );
    await db.query(`INSERT INTO service_translations(shop_id, service_id, locale, name) VALUES
      ($1, $2, 'en', 'Basic Facial'), ($1, $2, 'zh-CN', '基础面部护理'),
      ($1, $3, 'en', 'Balayage'), ($1, $3, 'zh-CN', 'Balayage渐层染')`,
      [id.shop, id.srvFacial, id.srvBalayage]
    );

    // Seed staff: Amy (Beauty specialist) and Bob (Hair specialist)
    await db.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES
      ($1, $3, 'Amy', true, true),
      ($2, $3, 'Bob', true, true)`,
      [id.staffAmy, id.staffBob, id.shop]
    );

    // Seed staff_services capability: Amy -> Facial, Bob -> Balayage
    await db.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES
      ($1, $2, $4, true),
      ($1, $3, $5, true)`,
      [id.shop, id.staffAmy, id.staffBob, id.srvFacial, id.srvBalayage]
    );

    // Seed location assignments
    for (const staffId of [id.staffAmy, id.staffBob]) {
      await db.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES($1, $2, $3, true)`,
        [id.shop, id.location, staffId]
      );
      // Working hours Monday through Sunday (1 to 7)
      for (let day = 1; day <= 7; day += 1) {
        await db.query(`INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
          ($1, $2, $3, $4, '09:00', '21:00', true)`,
          [id.shop, id.location, staffId, day]
        );
      }
    }

    process.env.DATABASE_URL = url;
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')];
    const { app, invalidateShopCatalogCache, getShopCatalogRevision } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false });
    app.locals.bookingPool = pool;
    app.locals.ownerAuthPool = pool;

    await withServer(app, async base => {
      // 1. When both Amy and Bob have active schedules, both categories and services must appear
      await t.test('1. Both Beauty and Hair categories appear with no-store cache headers', async () => {
        const res = await fetch(`${base}/api/booking/service-categories?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
        assert.equal(res.headers.get('pragma'), 'no-cache');
        assert.equal(res.headers.get('expires'), '0');
        assert.ok(res.headers.get('x-catalog-revision'));

        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.data.length, 2);
        const catNames = data.data.map(c => c.name);
        assert.ok(catNames.includes('美容'), 'Beauty category exists');
        assert.ok(catNames.includes('美发'), 'Hair category exists');
      });

      await t.test('2. Both Facial and Balayage services appear in services-db with no-store headers', async () => {
        const res = await fetch(`${base}/api/services-db?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
        assert.equal(res.headers.get('pragma'), 'no-cache');
        assert.equal(res.headers.get('expires'), '0');

        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.data.length, 2);
        const srvNames = data.data.map(s => s.name);
        assert.ok(srvNames.includes('基础面部护理'));
        assert.ok(srvNames.includes('Balayage渐层染'));
      });

      await t.test('3. Balayage multi-service available dates query succeeds when Bob is active', async () => {
        const res = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startDate: '2026-10-01',
            endDate: '2026-10-07',
            items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(Array.isArray(data.data));
        assert.ok(data.data.some(d => d.hasAvailability === true), 'Balayage has available dates');
      });

      // 4. Deactivating Hair staff schedule immediately removes Hair category and Balayage service
      await t.test('4. Deactivating Bob schedule removes Hair category and Balayage service from customer endpoints', async () => {
        await db.query(`UPDATE staff_location_working_hours SET is_active = FALSE WHERE staff_id = $1`, [id.staffBob]);

        // Categories check
        const catRes = await fetch(`${base}/api/booking/service-categories?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(catRes.status, 200);
        const catData = await catRes.json();
        assert.equal(catData.data.length, 1);
        assert.equal(catData.data[0].name, '美容');

        // Services check
        const srvRes = await fetch(`${base}/api/services-db?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(srvRes.status, 200);
        const srvData = await srvRes.json();
        assert.equal(srvData.data.length, 1);
        assert.equal(srvData.data[0].name, '基础面部护理');

        // Balayage date check fails with 400 service not found
        const dateRes = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startDate: '2026-10-01',
            endDate: '2026-10-07',
            items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(dateRes.status, 400);
        const dateData = await dateRes.json();
        assert.equal(dateData.success, false);
      });

      // 5. Restoring Bob schedule restores Hair category and service
      await t.test('5. Restoring Bob schedule restores Hair category and service', async () => {
        await db.query(`UPDATE staff_location_working_hours SET is_active = TRUE WHERE staff_id = $1`, [id.staffBob]);

        const catRes = await fetch(`${base}/api/booking/service-categories?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(catRes.status, 200);
        const catData = await catRes.json();
        assert.equal(catData.data.length, 2);

        const srvRes = await fetch(`${base}/api/services-db?shopSlug=gg-beauty&locale=zh-CN`);
        assert.equal(srvRes.status, 200);
        const srvData = await srvRes.json();
        assert.equal(srvData.data.length, 2);
      });

      // 6. Cache invalidation increments catalog revision
      await t.test('6. Invalidation increments catalog revision on mutation', async () => {
        const rev1 = getShopCatalogRevision(id.shop);
        invalidateShopCatalogCache(id.shop);
        const rev2 = getShopCatalogRevision(id.shop);
        assert.equal(rev2, rev1 + 1);

        const res = await fetch(`${base}/api/booking/service-categories?shopSlug=gg-beauty`);
        assert.equal(res.headers.get('x-catalog-revision'), String(rev2));
      });
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    pg.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// UI Test: Toggle Selection and Cart State Reset
test('Customer UI: First click selects, second click unselects, item change clears date, time, and staff', async () => {
  const makeElement = (tag = 'div') => {
    let innerHTML = '';
    let textContent = '';
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      get className() { return Array.from(classes).join(' '); },
      set className(val) {
        classes.clear();
        String(val || '').trim().split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      },
      get innerHTML() { return innerHTML; },
      set innerHTML(val) {
        innerHTML = String(val);
        if (innerHTML === '') this.children = [];
      },
      get textContent() {
        if (this.children.length > 0) return this.children.map(c => c.textContent).join('');
        return textContent;
      },
      set textContent(val) { textContent = String(val); },
      disabled: false,
      lang: '',
      href: '',
      options: [],
      dataset: {},
      hidden: false,
      style: { display: '' },
      children: [],
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (classes.has(c)) classes.delete(c);
            else classes.add(c);
          } else if (force) classes.add(c);
          else classes.delete(c);
        },
        contains(c) { return classes.has(c); }
      },
      _listeners: new Map(),
      addEventListener(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
      },
      async click() {
        for (const fn of this._listeners.get('click') || []) await fn({ target: this });
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
  const mockCategories = [
    { categoryId: 'cat-beauty', name: '美容', iconKey: 'beauty' },
    { categoryId: 'cat-hair', name: '美发', iconKey: 'hair' }
  ];
  const mockServices = [
    { id: 'srv-facial', categoryId: 'cat-beauty', name: '基础面部护理', price: 88, durationMinutes: 60, priceIsFrom: false },
    { id: 'srv-balayage', categoryId: 'cat-hair', name: 'Balayage渐层染', price: 238, durationMinutes: 180, priceIsFrom: true }
  ];

  let datesRequestedCount = 0;
  const contextObj = {
    console,
    encodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, ms !== undefined ? ms : 0),
    clearTimeout: (id) => clearTimeout(id),
    AbortController: globalThis.AbortController,
    fetch: async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/booking/context')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { shopSlug: 'gg-beauty', shopName: 'GG Beauty' } }) };
      }
      if (urlStr.includes('/api/booking/service-categories')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: mockCategories }) };
      }
      if (urlStr.includes('/api/services-db')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: mockServices }) };
      }
      if (urlStr.includes('/api/booking/multi-service-available-dates')) {
        datesRequestedCount += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, data: [{ date: '2026-10-01', hasAvailability: true }] }) };
      }
      if (urlStr.includes('/api/booking/staff-options')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: [{ staffId: 'staff-amy', displayName: 'Amy' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    },
    globalThis: {
      __CATALOGUE_TIMEOUT_MS__: 8000,
      ggI18n: i18n,
      ggCustomerShopContext: shopContext,
      ggCustomerCategoryFlow: categoryFlow,
      ggCustomerMultiServiceCart: cartApi,
      ggCustomerBookingCalendar: bookingCalendar,
      location: { hostname: 'localhost', pathname: '/', search: '?shop=gg-beauty' }
    },
    window: {
      location: { hostname: 'localhost', pathname: '/', search: '?shop=gg-beauty' },
      addEventListener: () => {}
    },
    localStorage: {
      getItem: () => 'zh-CN',
      setItem: () => {},
      removeItem: () => {}
    },
    navigator: { languages: ['zh-CN'] },
    document: {
      documentElement: { lang: 'zh-CN' },
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) {
          const el = makeElement();
          elements.set(id, el);
          contextObj[id] = el;
        }
        return elements.get(id);
      },
      createElement: (tag) => makeElement(tag),
      querySelectorAll: () => []
    }
  };

  for (const elId of [
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
    if (elId === 'servicesRetryBtn') el.dataset.i18n = 'reloadServices';
    if (elId === 'contactStep' || elId === 'servicesLoading' || elId === 'servicesEmpty' || elId === 'servicesError' || elId === 'servicesRetryContainer') {
      el.hidden = true;
    }
    elements.set(elId, el);
    contextObj[elId] = el;
  }

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const customerScript = scripts.at(-1)[1];
  const context = vm.createContext(contextObj);
  vm.runInContext(customerScript, context);
  await new Promise(resolve => setTimeout(resolve, 50));

  // Initialize customer page
  await context.initializeCustomerPage();

  const serviceCards = elements.get('serviceCards');
  assert.ok(serviceCards, 'serviceCards container exists');
  assert.ok(serviceCards.children.length > 0, 'Service cards rendered');

  const facialCard = serviceCards.children.find(c => c.dataset.serviceId === 'srv-facial');
  assert.ok(facialCard, 'Facial card rendered');

  // 1. First click: selects service
  await facialCard.click();
  let currentCart = vm.runInContext('cart', context);
  assert.equal(currentCart.length, 1);
  assert.equal(currentCart[0].serviceId, 'srv-facial');
  let currentFacialCard = serviceCards.children.find(c => c.dataset.serviceId === 'srv-facial');
  assert.ok(currentFacialCard.classList.contains('selected'), 'Card has selected class');
  assert.equal(currentFacialCard.getAttribute('aria-pressed'), 'true');
  const initialDateRequests = datesRequestedCount;
  assert.ok(initialDateRequests > 0, 'Dates requested after adding item');

  // Simulate user picking date
  const dateInput = elements.get('date');
  dateInput.value = '2026-10-01';
  assert.equal(dateInput.value, '2026-10-01');

  // 2. Second click on same card: unselects service (toggle off)
  await currentFacialCard.click();
  currentCart = vm.runInContext('cart', context);
  assert.equal(currentCart.length, 0, 'Cart is now empty after toggle unselect');
  currentFacialCard = serviceCards.children.find(c => c.dataset.serviceId === 'srv-facial');
  assert.ok(!currentFacialCard.classList.contains('selected'), 'Card no longer has selected class');
  assert.equal(currentFacialCard.getAttribute('aria-pressed'), 'false');
  assert.equal(dateInput.value, '', 'dateInput is cleared on unselect');

  // 3. Select facial again, set date, then select balayage
  await currentFacialCard.click();
  currentCart = vm.runInContext('cart', context);
  assert.equal(currentCart.length, 1);
  dateInput.value = '2026-10-01';

  // Switch category to hair and select balayage
  vm.runInContext('selectedCategoryId = "cat-hair"; renderServices();', context);
  const balayageCard = serviceCards.children.find(c => c.dataset.serviceId === 'srv-balayage');
  assert.ok(balayageCard, 'Balayage card found in Hair category');

  await balayageCard.click();
  currentCart = vm.runInContext('cart', context);
  assert.equal(currentCart.length, 2, 'Both facial and balayage now in cart');
  assert.equal(dateInput.value, '', 'dateInput cleared when second service added');
  // Both items in cart must have staffSelectionType reset to no_preference
  for (const item of currentCart) {
    assert.equal(item.staffSelectionType, 'no_preference');
  }

  // 4. Cart removal button clears date, time, and staff
  dateInput.value = '2026-10-05';
  const cartItems = elements.get('cartItems');
  assert.ok(cartItems.children.length === 2, '2 cart item cards rendered');
  const firstRemoveBtn = cartItems.children[0].children.find(c => c.classList.contains('remove-item'));
  assert.ok(firstRemoveBtn, 'Remove button found');

  await firstRemoveBtn.click();
  currentCart = vm.runInContext('cart', context);
  assert.equal(currentCart.length, 1, '1 item remains in cart');
  assert.equal(dateInput.value, '', 'dateInput cleared when item removed via button');
  assert.equal(currentCart[0].staffSelectionType, 'no_preference');
});
