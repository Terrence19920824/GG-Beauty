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
  shopSG: '11111111-1111-4111-8111-111111111111',
  locSG: '22222222-2222-4222-8222-222222222222',
  catBeauty: '33333333-3333-4333-8333-111111111111',
  srvFacial: '44444444-4444-4444-8444-111111111111',
  staffAmy: '55555555-5555-4555-8555-111111111111'
};

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE shops(id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, status text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY, shop_id uuid NOT NULL, timezone text NOT NULL, is_active boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, id));
CREATE TABLE staff(id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text NOT NULL, is_active boolean NOT NULL, bookable boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_categories(id uuid PRIMARY KEY, shop_id uuid NOT NULL, is_active boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE services(id uuid PRIMARY KEY, shop_id uuid NOT NULL, category_id uuid, name text NOT NULL, description text, duration_minutes integer NOT NULL, price numeric NOT NULL, price_is_from boolean NOT NULL, is_active boolean NOT NULL, bookable boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_translations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, service_id uuid NOT NULL, locale text NOT NULL, name text, description text);
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL, service_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, day_of_week integer NOT NULL, start_time time NOT NULL, end_time time NOT NULL, is_active boolean NOT NULL, effective_from date, effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, location_id uuid, staff_id uuid, schedule_date date, is_active boolean, approval_status text, override_type text, start_time time, end_time time);
CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, name text NOT NULL, phone text NOT NULL, email text);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, customer_id uuid NOT NULL, service_id uuid NOT NULL, staff_id uuid NOT NULL, appointment_no text NOT NULL DEFAULT ('GG-'||substr(gen_random_uuid()::text,1,8)), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, booking_source text, customer_special_request text, override_conflict boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, location_id, id), UNIQUE(shop_id, id), FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT, CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist(staff_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&) WHERE (status IN ('pending', 'confirmed') AND override_conflict = false));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL, service_name_snapshot text NOT NULL, service_locale_snapshot text, duration_minutes_snapshot integer NOT NULL, price_snapshot numeric, snapshot_source text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_items_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, id), FOREIGN KEY(shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL CHECK(role IN('primary','assistant')), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, appointment_item_id, staff_id), FOREIGN KEY(shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_status_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, appointment_id uuid NOT NULL, from_status text NOT NULL, to_status text NOT NULL, operator_type text NOT NULL, operator_id text, source text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now());
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

test('Customer Booking Authoritative Shop-Time & Boundary Invariants Suite', { timeout: 180000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-boundary-pg-'));
  const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 59300 + Math.floor(Math.random() * 200);
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

    for (const number of [
      '028_customers_composite_key_preflight_readonly.sql',
      '029_customers_composite_key_schema.sql',
      '030_customers_composite_key_verification_readonly.sql',
      '031_booking_recipient_booker_preflight_readonly.sql',
      '032_booking_recipient_booker_schema.sql',
      '033_booking_recipient_booker_legacy_backfill.sql',
      '034_booking_recipient_booker_consistency.sql',
      '035_booking_recipient_booker_verification_readonly.sql',
      '036_customer_member_identity_preflight_readonly.sql',
      '037_customer_member_profile_schema.sql',
      '038_customer_member_profile_verification_readonly.sql',
      '039_customer_member_code_backfill.sql',
      '040_customer_phone_otp_session_schema.sql',
      '041_customer_member_identity_enforcement.sql',
      '042_customer_member_identity_verification_readonly.sql',
      '014_assignment_collision_projection_schema.sql',
      '015_assignment_collision_backfill.sql',
      '016_assignment_collision_constraint.sql',
      '026_multi_service_parent_collision_compatibility.sql'
    ]) {
      await db.query(migration(number));
    }

    // Seed shop & location in Singapore (UTC+8)
    await db.query(`INSERT INTO shops VALUES($1, 'gg-beauty', 'GG Beauty', 'active')`, [id.shopSG]);
    await db.query(`INSERT INTO locations VALUES($1, $2, 'Asia/Singapore', true)`, [id.locSG, id.shopSG]);
    await db.query(`INSERT INTO service_categories(id, shop_id, is_active) VALUES ($1, $2, true)`, [id.catBeauty, id.shopSG]);
    await db.query(`INSERT INTO services(id, shop_id, category_id, name, duration_minutes, price, price_is_from, is_active, bookable) VALUES
      ($1, $2, $3, 'Facial', 60, 88, false, true, true)`, [id.srvFacial, id.shopSG, id.catBeauty]);
    await db.query(`INSERT INTO service_translations(shop_id, service_id, locale, name) VALUES
      ($1, $2, 'en', 'Basic Facial'), ($1, $2, 'zh-CN', '基础面部护理')`, [id.shopSG, id.srvFacial]);
    await db.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES ($1, $2, 'Amy', true, true)`, [id.staffAmy, id.shopSG]);
    await db.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES ($1, $2, $3, true)`, [id.shopSG, id.staffAmy, id.srvFacial]);
    await db.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES ($1, $2, $3, true)`, [id.shopSG, id.locSG, id.staffAmy]);
    for (let day = 1; day <= 7; day += 1) {
      await db.query(`INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
         ($1, $2, $3, $4, '10:00', '21:00', true)`, [id.shopSG, id.locSG, id.staffAmy, day]);
    }

    process.env.DATABASE_URL = url;
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false });
    app.locals.bookingPool = pool;
    app.locals.ownerAuthPool = pool;

    await withServer(app, async base => {

      // CASE 1: now = 2026-09-29 11:29 SGT (03:29 UTC)
      // 11:30 future slot -> allowed if otherwise bookable
      await t.test('1. now = 2026-09-29 11:29 SGT: 11:30 future slot is allowed', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z');

        // Multi-service available times
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resMultiTimes.status, 200);
        const dataMultiTimes = await resMultiTimes.json();
        assert.equal(dataMultiTimes.success, true);
        assert.ok(dataMultiTimes.data.some(s => s.time === '11:30'), '11:30 must be available at 11:29');
        assert.ok(!dataMultiTimes.data.some(s => s.time === '11:00'), '11:00 must be unavailable at 11:29');

        // Legacy /api/available-times-db
        const resLegacyDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-29&serviceId=${id.srvFacial}&staffSelectionType=no_preference`);
        assert.equal(resLegacyDb.status, 200);
        const dataLegacyDb = await resLegacyDb.json();
        assert.equal(dataLegacyDb.success, true);
        assert.ok(dataLegacyDb.data.includes('11:30'), 'Legacy db: 11:30 must be available at 11:29');
        assert.ok(!dataLegacyDb.data.includes('11:00'), 'Legacy db: 11:00 must be unavailable at 11:29');

        // Legacy /api/available-times
        const resLegacyMem = await fetch(`${base}/api/available-times?date=2026-09-29`);
        assert.equal(resLegacyMem.status, 200);
        const dataLegacyMem = await resLegacyMem.json();
        assert.equal(dataLegacyMem.success, true);
        assert.ok(dataLegacyMem.data.includes('11:30'), 'Legacy mem: 11:30 must be available at 11:29');
        assert.ok(!dataLegacyMem.data.includes('11:00'), 'Legacy mem: 11:00 must be unavailable at 11:29');

        // Multi-service booking write for 11:30 succeeds
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-29T03:30:00.000Z',
            customerName: 'Alice',
            phone: '81234567',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 200);
        const dataWrite = await resWrite.json();
        assert.equal(dataWrite.success, true);
      });

      // CASE 2: now = 2026-09-29 11:30 SGT (03:30 UTC)
      // 11:30 slot -> denied/not available
      await t.test('2. now = 2026-09-29 11:30 SGT: 11:30 slot is denied/unavailable', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:30:00.000Z');

        // Multi-service available times
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiTimes = await resMultiTimes.json();
        assert.ok(!dataMultiTimes.data.some(s => s.time === '11:30'), '11:30 must be excluded when now=11:30');

        // Legacy /api/available-times-db
        const resLegacyDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-29&serviceId=${id.srvFacial}&staffSelectionType=no_preference`);
        const dataLegacyDb = await resLegacyDb.json();
        assert.ok(!dataLegacyDb.data.includes('11:30'), 'Legacy db: 11:30 must be excluded when now=11:30');

        // Legacy /api/available-times
        const resLegacyMem = await fetch(`${base}/api/available-times?date=2026-09-29`);
        const dataLegacyMem = await resLegacyMem.json();
        assert.ok(!dataLegacyMem.data.includes('11:30'), 'Legacy mem: 11:30 must be excluded when now=11:30');

        // Multi-service write for 11:30 is rejected
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-29T03:30:00.000Z',
            customerName: 'Bob',
            phone: '81234568',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 400);
        const dataWrite = await resWrite.json();
        assert.equal(dataWrite.success, false);
        assert.match(dataWrite.message, /所选时间已过/);
      });

      // CASE 3: now = 2026-09-29 11:31 SGT (03:31 UTC)
      // 11:30 slot -> denied/not available
      await t.test('3. now = 2026-09-29 11:31 SGT: 11:30 slot is denied/unavailable', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:31:00.000Z');

        // Multi-service available times
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiTimes = await resMultiTimes.json();
        assert.ok(!dataMultiTimes.data.some(s => s.time === '11:30'), '11:30 must be excluded when now=11:31');

        // Multi-service write for 11:30 is rejected
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-29T03:30:00.000Z',
            customerName: 'Charlie',
            phone: '81234569',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 400);
        const dataWrite = await resWrite.json();
        assert.equal(dataWrite.success, false);
        assert.match(dataWrite.message, /所选时间已过/);
      });

      // CASE 4: now = 2026-09-29 23:59 SGT (15:59 UTC)
      // all earlier same-day slots -> unavailable
      await t.test('4. now = 2026-09-29 23:59 SGT: all same-day slots unavailable', async () => {
        app.locals.bookingNow = new Date('2026-09-29T15:59:00.000Z');

        // Multi-service available times returns empty array
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiTimes = await resMultiTimes.json();
        assert.equal(dataMultiTimes.success, true);
        assert.deepEqual(dataMultiTimes.data, [], 'All slots on 2026-09-29 must be unavailable at 23:59');

        // Multi-service available dates marks 2026-09-29 as hasAvailability=false
        const resMultiDates = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startDate: '2026-09-25',
            endDate: '2026-09-30',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiDates = await resMultiDates.json();
        assert.equal(dataMultiDates.success, true);
        const day29 = dataMultiDates.data.find(d => d.date === '2026-09-29');
        assert.equal(day29.hasAvailability, false, 'Day 29 hasAvailability must be false at 23:59');
        assert.equal(day29.earliestStartAt, null);

        // Legacy /api/available-times-db returns empty array
        const resLegacyDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-29&serviceId=${id.srvFacial}&staffSelectionType=no_preference`);
        const dataLegacyDb = await resLegacyDb.json();
        assert.equal(dataLegacyDb.success, true);
        assert.deepEqual(dataLegacyDb.data, [], 'Legacy db: all slots must be unavailable at 23:59');

        // Legacy /api/available-times returns empty array
        const resLegacyMem = await fetch(`${base}/api/available-times?date=2026-09-29`);
        const dataLegacyMem = await resLegacyMem.json();
        assert.equal(dataLegacyMem.success, true);
        assert.deepEqual(dataLegacyMem.data, [], 'Legacy mem: all slots must be unavailable at 23:59');

        // Booking write for 10:00 on 2026-09-29 is rejected
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-29T02:00:00.000Z',
            customerName: 'David',
            phone: '81234570',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 400);
        const dataWrite = await resWrite.json();
        assert.match(dataWrite.message, /所选时间已过/);
      });

      // CASE 5: future-day slots -> unaffected
      await t.test('5. Future-day slots (2026-09-30) unaffected by 23:59 on 2026-09-29', async () => {
        app.locals.bookingNow = new Date('2026-09-29T15:59:00.000Z');

        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-30',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiTimes = await resMultiTimes.json();
        assert.equal(dataMultiTimes.success, true);
        assert.ok(dataMultiTimes.data.some(s => s.time === '10:00'), 'Future day 10:00 must be available');
        assert.ok(dataMultiTimes.data.some(s => s.time === '11:00'), 'Future day 11:00 must be available');

        // Legacy db for future day
        const resLegacyDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-30&serviceId=${id.srvFacial}&staffSelectionType=no_preference`);
        const dataLegacyDb = await resLegacyDb.json();
        assert.equal(dataLegacyDb.success, true);
        assert.ok(dataLegacyDb.data.includes('10:00'), 'Legacy db: future day 10:00 must be available');

        // Write for future day succeeds
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-30T10:00:00.000Z',
            customerName: 'Eve',
            phone: '81234571',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 200);
      });

      // CASE 6: previous-day -> denied
      await t.test('6. Previous-day (2026-09-28) denied in availability and write', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:30:00.000Z');

        // Multi-service available times
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-28',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMultiTimes = await resMultiTimes.json();
        assert.equal(dataMultiTimes.success, true);
        assert.deepEqual(dataMultiTimes.data, [], 'Past date must return empty array');

        // Legacy db
        const resLegacyDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-28&serviceId=${id.srvFacial}&staffSelectionType=no_preference`);
        const dataLegacyDb = await resLegacyDb.json();
        assert.equal(dataLegacyDb.success, true);
        assert.deepEqual(dataLegacyDb.data, [], 'Legacy db: past date must return empty array');

        // Legacy mem
        const resLegacyMem = await fetch(`${base}/api/available-times?date=2026-09-28`);
        const dataLegacyMem = await resLegacyMem.json();
        assert.equal(dataLegacyMem.success, true);
        assert.deepEqual(dataLegacyMem.data, [], 'Legacy mem: past date must return empty array');

        // Multi-service write for past day rejected
        const resWriteMulti = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2026-09-28T02:00:00.000Z',
            customerName: 'Frank',
            phone: '81234572',
            countryCode: 'SG',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWriteMulti.status, 400);

        // Single-service legacy write for past day rejected
        const resWriteLegacy = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-28',
            time: '10:00',
            service: 'Facial',
            staff: 'Amy',
            customerName: 'Frank',
            phone: '81234572',
            countryCode: 'SG'
          })
        });
        assert.equal(resWriteLegacy.status, 400);
      });

      // CASE 7: timezone/date boundary around midnight
      await t.test('7. Timezone/date boundary around midnight in Asia/Singapore', async () => {
        // Just before midnight: 2026-09-29 23:59:59 SGT (15:59:59 UTC)
        app.locals.bookingNow = new Date('2026-09-29T15:59:59.000Z');
        const resBeforeMid = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.deepEqual((await resBeforeMid.json()).data, [], 'At 23:59:59, 2026-09-29 slots must be empty');

        // Exactly midnight: 2026-09-30 00:00:00 SGT (16:00:00 UTC on Sept 29)
        // In UTC it is 16:00 Sept 29, but in Asia/Singapore it is already Sept 30!
        app.locals.bookingNow = new Date('2026-09-29T16:00:00.000Z');

        // 2026-09-29 is now yesterday in shop timezone -> denied/empty
        const resMidDay29 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.deepEqual((await resMidDay29.json()).data, [], 'At midnight SGT, 2026-09-29 is past');

        // 2026-09-30 is now today in shop timezone -> morning 10:00 slot is available
        const resMidDay30 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-30',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        const dataMidDay30 = await resMidDay30.json();
        assert.ok(dataMidDay30.data.some(s => s.time === '10:00'), 'At midnight SGT, 2026-09-30 10:00 is available');

        // Just after midnight: 2026-09-30 00:01:00 SGT (16:01:00 UTC on Sept 29)
        app.locals.bookingNow = new Date('2026-09-29T16:01:00.000Z');
        const resAfterMid = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.deepEqual((await resAfterMid.json()).data, [], 'At 00:01 SGT, 2026-09-29 is past');
      });

      // CASE 8: Server behavior does not depend on machine timezone
      await t.test('8. Machine timezone independence (TZ=America/New_York vs UTC vs Asia/Tokyo)', async () => {
        const originalTz = process.env.TZ;
        try {
          for (const testTz of ['America/New_York', 'UTC', 'Asia/Tokyo']) {
            process.env.TZ = testTz;
            app.locals.bookingNow = new Date('2026-09-29T15:59:00.000Z'); // 23:59 SGT

            const resTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                shopSlug: 'gg-beauty',
                date: '2026-09-29',
                locale: 'zh-CN',
                items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
              })
            });
            const dataTimes = await resTimes.json();
            assert.deepEqual(dataTimes.data, [], `With TZ=${testTz}, 23:59 SGT slots on 2026-09-29 must be empty`);
          }
        } finally {
          if (originalTz !== undefined) process.env.TZ = originalTz;
          else delete process.env.TZ;
        }
      });

      // CASE 9: Multi-service eligible staff denies past slots
      await t.test('9. /api/booking/multi-service-eligible-staff denies past slot with 400', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:31:00.000Z'); // 11:31 SGT

        // Requesting 11:30 (in the past)
        const resPastStaff = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            time: '11:30',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial }]
          })
        });
        assert.equal(resPastStaff.status, 400);
        const dataPastStaff = await resPastStaff.json();
        assert.match(dataPastStaff.message, /所选时间已过/);

        // Requesting 12:00 (in the future)
        const resFutureStaff = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            time: '12:00',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial }]
          })
        });
        assert.equal(resFutureStaff.status, 200);
        const dataFutureStaff = await resFutureStaff.json();
        assert.equal(dataFutureStaff.success, true);
      });
    });

  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    pg.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
