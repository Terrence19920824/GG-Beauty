'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');

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
CREATE TABLE shops(id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, status text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY, shop_id uuid NOT NULL, timezone text NOT NULL, is_active boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, id));
CREATE TABLE staff(id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text NOT NULL, is_active boolean NOT NULL, bookable boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_categories(id uuid PRIMARY KEY, shop_id uuid NOT NULL, canonical_name text NOT NULL, icon_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_category_translations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, category_id uuid NOT NULL, locale text NOT NULL, name text NOT NULL, description text);
CREATE TABLE services(id uuid PRIMARY KEY, shop_id uuid NOT NULL, category text, category_id uuid, name text NOT NULL, description text, duration_minutes integer NOT NULL, price numeric NOT NULL, price_is_from boolean NOT NULL, sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL, bookable boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_translations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, service_id uuid NOT NULL, locale text NOT NULL, name text NOT NULL, description text);
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL, service_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, day_of_week integer NOT NULL, start_time time NOT NULL, end_time time NOT NULL, is_active boolean NOT NULL, effective_from date, effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, location_id uuid, staff_id uuid, schedule_date date, is_active boolean, approval_status text, override_type text, start_time time, end_time time);
CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, name text NOT NULL, phone text NOT NULL, email text);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, customer_id uuid, service_id uuid NOT NULL, staff_id uuid NOT NULL, appointment_no text NOT NULL DEFAULT ('GG-'||substr(gen_random_uuid()::text,1,8)), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, booking_source text, override_conflict boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, location_id, id), UNIQUE(shop_id, id));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL, service_name_snapshot text NOT NULL, service_locale_snapshot text, duration_minutes_snapshot integer NOT NULL, price_snapshot numeric, snapshot_source text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_items_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, id), FOREIGN KEY(shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL CHECK(role IN('primary','assistant')), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, blocks_time boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, appointment_item_id, staff_id), FOREIGN KEY(shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT);
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id, location_id, appointment_item_id) WHERE role = 'primary';
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

test('Batch Availability Performance & Migration 056 Verification', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-batch-perf-pg-'));
  const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 58300 + Math.floor(Math.random() * 200);
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

    // Apply Migration 056
    const migration056Sql = migration('056_customer_catalog_qualification_indexes.sql');
    await db.query(migration056Sql);

    // Verify indexes created by Migration 056
    const indexCheck = await db.query(`
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_staff_services_qualified', 'idx_appointment_item_staff_assignments_blocking')
      ORDER BY indexname;
    `);
    assert.equal(indexCheck.rows.length, 2, 'Migration 056 created both indexes');
    assert.match(indexCheck.rows[0].indexdef, /blocks_time = true/i);
    assert.match(indexCheck.rows[1].indexdef, /is_active = true/i);

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

    // Seed staff: Amy and Bob
    await db.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES
      ($1, $3, 'Amy', true, true),
      ($2, $3, 'Bob', true, true)`,
      [id.staffAmy, id.staffBob, id.shop]
    );

    // Seed capabilities
    await db.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES
      ($1, $2, $4, true),
      ($1, $3, $5, true)`,
      [id.shop, id.staffAmy, id.staffBob, id.srvFacial, id.srvBalayage]
    );

    // Seed location assignments & working hours
    for (const staffId of [id.staffAmy, id.staffBob]) {
      await db.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES($1, $2, $3, true)`,
        [id.shop, id.location, staffId]
      );
      for (let day = 1; day <= 7; day += 1) {
        await db.query(`INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
          ($1, $2, $3, $4, '09:00', '21:00', true)`,
          [id.shop, id.location, staffId, day]
        );
      }
    }

    // Seed blocking appointment for Bob on 2026-03-15 14:00 (06:00 UTC)
    const apptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await db.query(`INSERT INTO appointments(id, shop_id, location_id, service_id, staff_id, start_at, end_at, status) VALUES
      ($1, $2, $3, $4, $5, '2026-03-15T06:00:00.000Z', '2026-03-15T09:00:00.000Z', 'confirmed')`,
      [apptId, id.shop, id.location, id.srvBalayage, id.staffBob]);
    await db.query(`INSERT INTO appointment_items(id, shop_id, location_id, appointment_id, service_id, sequence_no, service_name_snapshot, duration_minutes_snapshot, price_snapshot, snapshot_source, start_at, end_at, status) VALUES
      ($1, $2, $3, $4, $5, 1, 'Balayage', 180, 238, 'catalog', '2026-03-15T06:00:00.000Z', '2026-03-15T09:00:00.000Z', 'confirmed')`,
      [itemId, id.shop, id.location, apptId, id.srvBalayage]);
    await db.query(`INSERT INTO appointment_item_staff_assignments(shop_id, location_id, appointment_item_id, staff_id, role, start_at, end_at, blocks_time) VALUES
      ($1, $2, $3, $4, 'primary', '2026-03-15T06:00:00.000Z', '2026-03-15T09:00:00.000Z', true)`,
      [id.shop, id.location, itemId, id.staffBob]);

    // EXPLAIN (ANALYZE, BUFFERS) validation for queries
    const explainStaff = await db.query(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT capability.service_id, member.id AS staff_id, member.name AS display_name
      FROM services AS service
      JOIN service_categories AS category ON category.shop_id = service.shop_id AND category.id = service.category_id AND category.is_active = TRUE
      JOIN staff_services AS capability ON capability.shop_id = service.shop_id AND capability.service_id = service.id AND capability.is_active = TRUE
      JOIN staff AS member ON member.shop_id = capability.shop_id AND member.id = capability.staff_id AND member.is_active = TRUE AND member.bookable = TRUE
      JOIN staff_location_assignments AS location_assignment ON location_assignment.shop_id = member.shop_id AND location_assignment.staff_id = member.id AND location_assignment.location_id = $2::UUID AND location_assignment.is_active = TRUE
      JOIN locations AS location ON location.shop_id = service.shop_id AND location.id = location_assignment.location_id AND location.is_active = TRUE
      WHERE service.shop_id = $1::UUID AND service.id = ANY($3::UUID[]) AND service.is_active = TRUE AND service.bookable = TRUE
      ORDER BY member.name ASC, member.id ASC;
    `, [id.shop, id.location, [id.srvBalayage]]);
    console.log('EXPLAIN (ANALYZE, BUFFERS) - Qualified Staff:\n', explainStaff.rows.map(r => r['QUERY PLAN']).join('\n'));

    const explainBlocking = await db.query(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT assignment.staff_id, collision_item.appointment_id,
        (assignment.start_at AT TIME ZONE location.timezone)::DATE::TEXT AS local_date,
        assignment.start_at, assignment.end_at
      FROM locations location
      JOIN appointment_item_staff_assignments AS assignment ON assignment.shop_id = location.shop_id AND assignment.location_id = location.id
      JOIN appointment_items AS collision_item ON collision_item.shop_id = assignment.shop_id AND collision_item.location_id = assignment.location_id AND collision_item.id = assignment.appointment_item_id
      WHERE location.shop_id = $1::UUID AND location.id = $2::UUID AND assignment.staff_id = ANY($3::UUID[])
        AND assignment.role IN ('primary', 'assistant') AND assignment.blocks_time = TRUE
        AND assignment.start_at < '2026-03-31T23:59:59Z'::TIMESTAMPTZ AND assignment.end_at > '2026-03-01T00:00:00Z'::TIMESTAMPTZ;
    `, [id.shop, id.location, [id.staffBob]]);
    console.log('EXPLAIN (ANALYZE, BUFFERS) - Blocking Assignments:\n', explainBlocking.rows.map(r => r['QUERY PLAN']).join('\n'));

    // Set up instrumented client pool to count queries
    process.env.DATABASE_URL = url;
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false });

    const queryLog = [];
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      if (!client.__wrapped) {
        client.__wrapped = true;
        const origQuery = client.query.bind(client);
        client.query = async (...args) => {
          const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
          queryLog.push(sql.trim());
          return origQuery(...args);
        };
      }
      return client;
    };

    app.locals.bookingPool = pool;
    app.locals.ownerAuthPool = pool;

    await withServer(app, async base => {
      // 1. Single-day times query
      queryLog.length = 0;
      const timesRes = await fetch(`${base}/api/booking/multi-service-available-times`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'gg-beauty',
          date: '2026-03-15',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(timesRes.status, 200);
      const timesData = await timesRes.json();
      assert.equal(timesData.success, true);
      assert.ok(timesData.data.length > 0);
      const timesQueryCount = queryLog.length;
      console.log(`Query count for single-day (multi-service-available-times): ${timesQueryCount}`);
      assert.ok(timesQueryCount <= 8, `Single-day query count must be <= 8 (got ${timesQueryCount})`);

      // 2. 28-day month query (February 2026)
      queryLog.length = 0;
      const febRes = await fetch(`${base}/api/booking/multi-service-available-dates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'gg-beauty',
          startDate: '2026-02-01',
          endDate: '2026-02-28',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(febRes.status, 200);
      const febData = await febRes.json();
      assert.equal(febData.success, true);
      assert.equal(febData.data.length, 28);
      const count28 = queryLog.length;
      console.log(`Query count for 28-day month: ${count28}`);

      // 3. 30-day month query (April 2026)
      queryLog.length = 0;
      const aprRes = await fetch(`${base}/api/booking/multi-service-available-dates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'gg-beauty',
          startDate: '2026-04-01',
          endDate: '2026-04-30',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(aprRes.status, 200);
      const aprData = await aprRes.json();
      assert.equal(aprData.success, true);
      assert.equal(aprData.data.length, 30);
      const count30 = queryLog.length;
      console.log(`Query count for 30-day month: ${count30}`);

      // 4. 31-day month query (March 2026)
      queryLog.length = 0;
      const marRes = await fetch(`${base}/api/booking/multi-service-available-dates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'gg-beauty',
          startDate: '2026-03-01',
          endDate: '2026-03-31',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }]
        })
      });
      assert.equal(marRes.status, 200);
      const marData = await marRes.json();
      assert.equal(marData.success, true);
      assert.equal(marData.data.length, 31);
      const count31 = queryLog.length;
      console.log(`Query count for 31-day month: ${count31}`);

      // Query Invariance Assertions:
      assert.equal(count28, count30, 'Query count for 28 days must equal 30 days');
      assert.equal(count30, count31, 'Query count for 30 days must equal 31 days');
      assert.ok(count31 <= 8, `Monthly query count must be bounded <= 8 (got ${count31})`);

      // 5. Multi-service 2-item cart query count check across 31 days
      queryLog.length = 0;
      const multiMarRes = await fetch(`${base}/api/booking/multi-service-available-dates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shopSlug: 'gg-beauty',
          startDate: '2026-03-01',
          endDate: '2026-03-31',
          locale: 'zh-CN',
          items: [
            { serviceId: id.srvFacial, staffSelectionType: 'no_preference' },
            { serviceId: id.srvBalayage, staffSelectionType: 'no_preference' }
          ]
        })
      });
      assert.equal(multiMarRes.status, 200);
      const multiMarData = await multiMarRes.json();
      assert.equal(multiMarData.success, true);
      assert.equal(multiMarData.data.length, 31);
      const count2Items = queryLog.length;
      console.log(`Query count for 2-item multi-service 31-day month: ${count2Items}`);
      assert.ok(count2Items <= 9, `2-item multi-service 31-day query count bounded <= 9 (got ${count2Items})`);
    });

    } finally {
    if (db) await db.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    pg.kill();
    await new Promise(r => setTimeout(r, 100));
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});
