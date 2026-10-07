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
  catBeautySG: '33333333-3333-4333-8333-111111111111',
  srvFacialSG: '44444444-4444-4444-8444-111111111111',
  staffAmySG: '55555555-5555-4555-8555-111111111111',

  shopKL: '11111111-1111-4111-8111-222222222222',
  locKL: '22222222-2222-4222-8222-333333333333',
  catBeautyKL: '33333333-3333-4333-8333-222222222222',
  srvFacialKL: '44444444-4444-4444-8444-222222222222',
  staffAmyKL: '55555555-5555-4555-8555-222222222222',

  shopNY: '11111111-1111-4111-8111-333333333333',
  locNY: '22222222-2222-4222-8222-444444444444',
  catBeautyNY: '33333333-3333-4333-8333-333333333333',
  srvFacialNY: '44444444-4444-4444-8444-333333333333',
  staffAmyNY: '55555555-5555-4555-8555-333333333333',

  shopNull: '11111111-1111-4111-8111-444444444444',
  locNull: '22222222-2222-4222-8222-555555555555',
  catNull: '33333333-3333-4333-8333-444444444444',
  srvNull: '44444444-4444-4444-8444-444444444444',
  staffNull: '55555555-5555-4555-8555-444444444444',

  shopEmpty: '11111111-1111-4111-8111-555555555555',
  locEmpty: '22222222-2222-4222-8222-666666666666',
  catEmpty: '33333333-3333-4333-8333-555555555555',
  srvEmpty: '44444444-4444-4444-8444-555555555555',
  staffEmpty: '55555555-5555-4555-8555-555555555555',

  shopInvalid: '11111111-1111-4111-8111-666666666666',
  locInvalid: '22222222-2222-4222-8222-777777777777',
  catInvalid: '33333333-3333-4333-8333-666666666666',
  srvInvalid: '44444444-4444-4444-8444-666666666666',
  staffInvalid: '55555555-5555-4555-8555-666666666666'
};

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE shops(id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, status text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY, shop_id uuid NOT NULL, timezone text, is_active boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, id));
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
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const seedShopFixture = async (dbClient, { shopId, slug, locId, tz, staffId, srvId, catId }) => {
  await dbClient.query(`INSERT INTO shops VALUES($1, $2, $2, 'active')`, [shopId, slug]);
  await dbClient.query(`INSERT INTO locations VALUES($1, $2, $3, true)`, [locId, shopId, tz]);
  await dbClient.query(`INSERT INTO service_categories(id, shop_id, is_active) VALUES ($1, $2, true)`, [catId, shopId]);
  await dbClient.query(`INSERT INTO services(id, shop_id, category_id, name, duration_minutes, price, price_is_from, is_active, bookable) VALUES
    ($1, $2, $3, 'Facial', 60, 88, false, true, true)`, [srvId, shopId, catId]);
  await dbClient.query(`INSERT INTO service_translations(shop_id, service_id, locale, name) VALUES
    ($1, $2, 'en', 'Basic Facial'), ($1, $2, 'zh-CN', '基础面部护理')`, [shopId, srvId]);
  await dbClient.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES ($1, $2, 'Staff', true, true)`, [staffId, shopId]);
  await dbClient.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES ($1, $2, $3, true)`, [shopId, staffId, srvId]);
  await dbClient.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES ($1, $2, $3, true)`, [shopId, locId, staffId]);
  for (let day = 1; day <= 7; day += 1) {
    await dbClient.query(`INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
       ($1, $2, $3, $4, '10:00', '21:00', true)`, [shopId, locId, staffId, day]);
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
      '026_multi_service_parent_collision_compatibility.sql',
      '108_booking_channel_attribution_preflight_readonly.sql',
      '109_booking_channel_attribution_schema.sql',
      '110_booking_channel_attribution_verification_readonly.sql'
    ]) {
      await db.query(migration(number));
    }

    // Seed fixtures with various DB location timezones
    await seedShopFixture(db, { shopId: id.shopSG, slug: 'gg-beauty', locId: id.locSG, tz: 'Asia/Singapore', staffId: id.staffAmySG, srvId: id.srvFacialSG, catId: id.catBeautySG });
    await seedShopFixture(db, { shopId: id.shopKL, slug: 'gg-kl', locId: id.locKL, tz: 'Asia/Kuala_Lumpur', staffId: id.staffAmyKL, srvId: id.srvFacialKL, catId: id.catBeautyKL });
    await seedShopFixture(db, { shopId: id.shopNY, slug: 'gg-ny', locId: id.locNY, tz: 'America/New_York', staffId: id.staffAmyNY, srvId: id.srvFacialNY, catId: id.catBeautyNY });
    await seedShopFixture(db, { shopId: id.shopNull, slug: 'gg-tz-null', locId: id.locNull, tz: null, staffId: id.staffNull, srvId: id.srvNull, catId: id.catNull });
    await seedShopFixture(db, { shopId: id.shopEmpty, slug: 'gg-tz-empty', locId: id.locEmpty, tz: '', staffId: id.staffEmpty, srvId: id.srvEmpty, catId: id.catEmpty });
    await seedShopFixture(db, { shopId: id.shopInvalid, slug: 'gg-tz-invalid', locId: id.locInvalid, tz: 'Invalid/Zone', staffId: id.staffInvalid, srvId: id.srvInvalid, catId: id.catInvalid });

    process.env.DATABASE_URL = url;
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false });
    app.locals.bookingPool = pool;
    app.locals.ownerAuthPool = pool;

    await withServer(app, async base => {

      // TEST 1: DB location timezone Asia/Singapore -> normal Singapore behavior PASS
      await t.test('1. DB location timezone Asia/Singapore: normal Singapore behavior PASS', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z'); // 11:29 SGT

        // Multi-service availability
        const resMultiTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resMultiTimes.status, 200);
        const dataMultiTimes = await resMultiTimes.json();
        assert.ok(dataMultiTimes.data.some(s => s.time === '11:30'), '11:30 must be available at 11:29');
        assert.ok(!dataMultiTimes.data.some(s => s.time === '11:00'), '11:00 must be unavailable at 11:29');

        // Multi-service write succeeds
        const resWrite = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            customerName: 'Customer Future',
            phone: '+6591234567',
            startAt: '2026-09-29T10:00:00.000Z',
            items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWrite.status, 200);
      });

      // TEST 2: DB location timezone Asia/Kuala_Lumpur -> uses KL timezone
      await t.test('2. DB location timezone Asia/Kuala_Lumpur: uses KL timezone', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z'); // 11:29 KL time
        const res = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-kl',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacialKL, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.data.some(s => s.time === '11:30'), 'KL 11:30 is available at 11:29');
      });

      // TEST 3: DB location timezone America/New_York -> follows NY timezone boundary
      await t.test('3. DB location timezone America/New_York: date/time boundary follows NY timezone', async () => {
        // At UTC 2026-09-29T02:00:00.000Z:
        // In Singapore, it is 2026-09-29 10:00 AM (start_at 02:00Z has arrived).
        // In New York (EDT, UTC-4), it is 2026-09-28 10:00 PM! September 29 is tomorrow.
        // 10:00 AM on 2026-09-29 starts at 2026-09-29T14:00:00.000Z (12 hours ahead of now).
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');

        // New York: 10:00 AM on 2026-09-29 is in the future and MUST be available
        const resNY = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-ny',
            date: '2026-09-29',
            locale: 'en',
            items: [{ serviceId: id.srvFacialNY, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resNY.status, 200);
        const dataNY = await resNY.json();
        assert.ok(dataNY.data.some(s => s.time === '10:00'), 'NY 10:00 AM slot is available because it is still yesterday in NY');

        // Singapore: 10:00 AM on 2026-09-29 is NOW (start_at = 02:00Z <= nowMs), so must NOT be available
        const resSG = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resSG.status, 200);
        const dataSG = await resSG.json();
        assert.ok(!dataSG.data.some(s => s.time === '10:00'), 'Singapore 10:00 AM slot is not available as it already elapsed');
      });

      // TEST 4: timezone NULL -> FAIL CLOSED
      await t.test('4. DB location timezone NULL: fails closed across all active booking paths', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z');

        // multi-service available times -> 400
        const resTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-tz-null', date: '2026-09-29', items: [{ serviceId: id.srvNull, staffSelectionType: 'no_preference' }] })
        });
        assert.equal(resTimes.status, 400);

        // multi-service available dates -> 400
        const resDates = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-tz-null', startDate: '2026-09-29', endDate: '2026-09-30', items: [{ serviceId: id.srvNull }] })
        });
        assert.equal(resDates.status, 400);

        // multi-service eligible staff -> 400
        const resStaff = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-tz-null', date: '2026-09-29', time: '11:30', items: [{ serviceId: id.srvNull }] })
        });
        assert.equal(resStaff.status, 400);

        // /api/available-times-db -> 400
        const resDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-tz-null&date=2026-09-29&serviceId=${id.srvNull}&staffSelectionType=no_preference`);
        assert.equal(resDb.status, 400);

        // /api/available-times -> 400
        const resLegacy = await fetch(`${base}/api/available-times?shopSlug=gg-tz-null&date=2026-09-29`);
        assert.equal(resLegacy.status, 400);

        // multi-service write -> 400
        const resWriteMulti = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-tz-null',
            customerName: 'Test Null',
            phone: '+6591234567',
            startAt: '2026-09-29T10:00:00.000Z',
            items: [{ serviceId: id.srvNull, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWriteMulti.status, 400);

        // single-service write -> 400
        const resWriteSingle = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-tz-null',
            customerName: 'Test Null Single',
            phone: '+6591234567',
            serviceId: id.srvNull,
            staffSelectionType: 'no_preference',
            date: '2026-09-29',
            time: '12:00'
          })
        });
        assert.equal(resWriteSingle.status, 400);
      });

      // TEST 5: timezone empty string -> FAIL CLOSED
      await t.test('5. DB location timezone empty string: fails closed across all active booking paths', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z');

        const resTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-tz-empty', date: '2026-09-29', items: [{ serviceId: id.srvEmpty, staffSelectionType: 'no_preference' }] })
        });
        assert.equal(resTimes.status, 400);

        const resDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-tz-empty&date=2026-09-29&serviceId=${id.srvEmpty}&staffSelectionType=no_preference`);
        assert.equal(resDb.status, 400);

        const resLegacy = await fetch(`${base}/api/available-times?shopSlug=gg-tz-empty&date=2026-09-29`);
        assert.equal(resLegacy.status, 400);

        const resWriteMulti = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-tz-empty',
            customerName: 'Test Empty',
            phone: '+6591234567',
            startAt: '2026-09-29T10:00:00.000Z',
            items: [{ serviceId: id.srvEmpty, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWriteMulti.status, 400);
      });

      // TEST 6: invalid timezone e.g. Invalid/Zone -> FAIL CLOSED
      await t.test('6. DB location timezone Invalid/Zone: fails closed across all active booking paths', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z');

        const resTimes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-tz-invalid', date: '2026-09-29', items: [{ serviceId: id.srvInvalid, staffSelectionType: 'no_preference' }] })
        });
        assert.equal(resTimes.status, 400);

        const resDb = await fetch(`${base}/api/available-times-db?shopSlug=gg-tz-invalid&date=2026-09-29&serviceId=${id.srvInvalid}&staffSelectionType=no_preference`);
        assert.equal(resDb.status, 400);

        const resLegacy = await fetch(`${base}/api/available-times?shopSlug=gg-tz-invalid&date=2026-09-29`);
        assert.equal(resLegacy.status, 400);

        const resWriteMulti = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-tz-invalid',
            customerName: 'Test Invalid',
            phone: '+6591234567',
            startAt: '2026-09-29T10:00:00.000Z',
            items: [{ serviceId: id.srvInvalid, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWriteMulti.status, 400);
      });

      // TEST 7: browser/device/machine timezone cannot override DB timezone
      await t.test('7. Machine timezone independence: TZ=America/New_York vs UTC vs Asia/Tokyo', async () => {
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
                items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }]
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

      // TEST 8: /api/available-times uses DB location timezone
      await t.test('8. /api/available-times uses DB location timezone', async () => {
        // At 02:00 UTC, 10:00 is past in Singapore (02:00 UTC) but future in NY (14:00 UTC)
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');

        const resSG = await fetch(`${base}/api/available-times?shopSlug=gg-beauty&date=2026-09-29`);
        assert.equal(resSG.status, 200);
        const dataSG = await resSG.json();
        assert.ok(!dataSG.data.includes('10:00'), 'Singapore 10:00 is past');

        const resNY = await fetch(`${base}/api/available-times?shopSlug=gg-ny&date=2026-09-29`);
        assert.equal(resNY.status, 200);
        const dataNY = await resNY.json();
        assert.ok(dataNY.data.includes('10:00'), 'New York 10:00 is future');
      });

      // TEST 9: /api/available-times-db uses DB location timezone
      await t.test('9. /api/available-times-db uses DB location timezone', async () => {
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');

        const resSG = await fetch(`${base}/api/available-times-db?shopSlug=gg-beauty&date=2026-09-29&serviceId=${id.srvFacialSG}&staffSelectionType=no_preference`);
        assert.equal(resSG.status, 200);
        const dataSG = await resSG.json();
        assert.ok(!dataSG.data.includes('10:00'), 'Singapore 10:00 is past');

        const resNY = await fetch(`${base}/api/available-times-db?shopSlug=gg-ny&date=2026-09-29&serviceId=${id.srvFacialNY}&staffSelectionType=no_preference`);
        assert.equal(resNY.status, 200);
        const dataNY = await resNY.json();
        assert.ok(dataNY.data.includes('10:00'), 'New York 10:00 is future');
      });

      // TEST 10: multi-service availability uses DB location timezone
      await t.test('10. multi-service availability uses DB location timezone', async () => {
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');

        const resDatesNY = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-ny', startDate: '2026-09-29', endDate: '2026-09-29', items: [{ serviceId: id.srvFacialNY, staffSelectionType: 'no_preference' }] })
        });
        assert.equal(resDatesNY.status, 200);
        const dataDatesNY = await resDatesNY.json();
        assert.equal(dataDatesNY.data[0].hasAvailability, true, 'NY has availability on Sept 29 at 02:00Z');
      });

      // TEST 11: eligible-staff uses DB location timezone
      await t.test('11. eligible-staff uses DB location timezone', async () => {
        app.locals.bookingNow = new Date('2026-09-29T03:31:00.000Z'); // 11:31 SGT

        // Requesting 11:30 in Singapore -> past (400)
        const resPastStaff = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            date: '2026-09-29',
            time: '11:30',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacialSG }]
          })
        });
        assert.equal(resPastStaff.status, 400);

        // Requesting 11:30 in NY -> future (starts at 15:30 UTC, 12 hrs later) -> 200
        const resFutureStaffNY = await fetch(`${base}/api/booking/multi-service-eligible-staff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-ny',
            date: '2026-09-29',
            time: '11:30',
            locale: 'en',
            items: [{ serviceId: id.srvFacialNY }]
          })
        });
        assert.equal(resFutureStaffNY.status, 200);
      });

      // TEST 12: multi-service write uses DB location timezone
      await t.test('12. multi-service write uses DB location timezone', async () => {
        // At 02:00 UTC, 10:00 AM on 2026-09-29 in NY is 14:00 UTC (future) -> succeeds
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');
        const resWriteNY = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-ny',
            customerName: 'Customer NY',
            phone: '+12125551234',
            startAt: '2026-09-29T14:00:00.000Z',
            items: [{ serviceId: id.srvFacialNY, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resWriteNY.status, 200);
      });

      // TEST 13: legacy single-service write uses DB location timezone
      await t.test('13. legacy single-service write uses DB location timezone', async () => {
        // At 02:00 UTC, 11:00 AM in NY is 15:00 UTC (future) -> succeeds
        app.locals.bookingNow = new Date('2026-09-29T02:00:00.000Z');
        const resWriteLegacyNY = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-ny',
            customerName: 'Customer NY Single',
            phone: '+12125551234',
            serviceId: id.srvFacialNY,
            staffSelectionType: 'no_preference',
            date: '2026-09-29',
            time: '11:00'
          })
        });
        assert.equal(resWriteLegacyNY.status, 200);
      });

      // TEST 14: existing past-slot boundaries remain
      await t.test('14. existing past-slot boundaries remain (11:29 allowed, 11:30 denied, 11:31 denied, 23:59 denied)', async () => {
        // 11:29 -> 11:30 allowed
        app.locals.bookingNow = new Date('2026-09-29T03:29:00.000Z');
        const res1129 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-29', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.ok((await res1129.json()).data.some(s => s.time === '11:30'));

        // 11:30 -> 11:30 denied
        app.locals.bookingNow = new Date('2026-09-29T03:30:00.000Z');
        const res1130 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-29', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.ok(!(await res1130.json()).data.some(s => s.time === '11:30'));

        // 11:31 -> 11:30 denied
        app.locals.bookingNow = new Date('2026-09-29T03:31:00.000Z');
        const res1131 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-29', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.ok(!(await res1131.json()).data.some(s => s.time === '11:30'));

        // 23:59 -> same-day denied
        app.locals.bookingNow = new Date('2026-09-29T15:59:00.000Z');
        const res2359 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-29', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.deepEqual((await res2359.json()).data, []);

        // Future day unaffected
        const resFutureDay = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-30', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.ok((await resFutureDay.json()).data.length > 0);

        // Previous day denied
        const resPrevDay = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopSlug: 'gg-beauty', date: '2026-09-28', items: [{ serviceId: id.srvFacialSG, staffSelectionType: 'no_preference' }] })
        });
        assert.deepEqual((await resPrevDay.json()).data, []);
      });

    });

  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    if (pg) {
      pg.kill('SIGTERM');
      await new Promise(r => pg.once('exit', r));
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});
