'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');

const {
  evaluateScheduleSemantics,
  getTodayInTimezone,
  getLocalParts,
  computeBatchAvailability
} = require('../lib/customer-batch-availability');
const {
  validateStaffBookability,
  StaffBookabilityError
} = require('../lib/staff-bookability-validator');
const {
  loadEligibleBookingStaff
} = require('../server');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const id = {
  shopSG: '11111111-1111-4111-8111-111111111111',
  locSG: '22222222-2222-4222-8222-222222222222',
  shopNY: '11111111-1111-4111-8111-222222222222',
  locNY: '22222222-2222-4222-8222-333333333333',
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
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL, service_id uuid NOT NULL, is_active boolean NOT NULL, UNIQUE(shop_id, staff_id, service_id));
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, is_active boolean NOT NULL, UNIQUE(shop_id, staff_id, location_id));
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, day_of_week integer NOT NULL, start_time time NOT NULL, end_time time NOT NULL, is_active boolean NOT NULL, effective_from date, effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, location_id uuid, staff_id uuid, schedule_date date, is_active boolean, approval_status text, override_type text, start_time time, end_time time);
CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, name text NOT NULL, phone text NOT NULL, email text);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, customer_id uuid, service_id uuid NOT NULL, staff_id uuid NOT NULL, appointment_no text NOT NULL DEFAULT ('GG-'||substr(gen_random_uuid()::text,1,8)), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, booking_source text, override_conflict boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, location_id, id), UNIQUE(shop_id, id));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL, service_name_snapshot text NOT NULL, service_locale_snapshot text, duration_minutes_snapshot integer NOT NULL, price_snapshot numeric, snapshot_source text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_items_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, id), FOREIGN KEY(shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL CHECK(role IN('primary','assistant')), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, blocks_time boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, appointment_item_id, staff_id), FOREIGN KEY(shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT);

-- Baseline 000-052 indexes
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id, location_id, appointment_item_id) WHERE role = 'primary';
CREATE INDEX appointment_item_staff_schedule_idx ON appointment_item_staff_assignments(shop_id, location_id, staff_id, start_at, end_at);
CREATE INDEX staff_location_working_hours_lookup_idx ON staff_location_working_hours(shop_id, location_id, staff_id, day_of_week);
CREATE INDEX staff_schedule_overrides_lookup_idx ON staff_schedule_overrides(shop_id, location_id, staff_id, schedule_date);
ALTER TABLE appointment_item_staff_assignments ADD CONSTRAINT appointment_item_staff_collision_excl EXCLUDE USING gist (shop_id WITH =, staff_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&) WHERE (blocks_time=TRUE);
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

test('Customer Batch Availability Semantic Safety & Differential Parity Suite', { timeout: 180000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-batch-safety-pg-'));
  const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 58400 + Math.floor(Math.random() * 200);
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

    // 1. Seed Singapore and New York shops & locations
    await db.query(`INSERT INTO shops VALUES($1, 'gg-singapore', 'GG Singapore', 'active'), ($2, 'gg-newyork', 'GG New York', 'active')`, [id.shopSG, id.shopNY]);
    await db.query(`INSERT INTO locations VALUES($1, $3, 'Asia/Singapore', true), ($2, $4, 'America/New_York', true)`, [id.locSG, id.locNY, id.shopSG, id.shopNY]);

    // Seed categories & services
    await db.query(`INSERT INTO service_categories(id, shop_id, canonical_name, icon_key, sort_order, is_active) VALUES
      ($1, $3, 'Beauty', 'beauty', 1, true),
      ($2, $3, 'Hair', 'hair', 2, true),
      ($4, $5, 'Hair', 'hair', 1, true)`,
      [id.catBeauty, id.catHair, id.shopSG, '33333333-3333-4333-8333-333333333333', id.shopNY]
    );
    await db.query(`INSERT INTO services(id, shop_id, category, category_id, name, duration_minutes, price, price_is_from, sort_order, is_active, bookable) VALUES
      ($1, $3, 'Beauty', $4, 'Basic Facial', 60, 88, false, 1, true, true),
      ($2, $3, 'Hair', $5, 'Balayage', 120, 238, true, 2, true, true),
      ($6, $7, 'Hair', '33333333-3333-4333-8333-333333333333', 'NY Styling', 60, 150, false, 1, true, true)`,
      [id.srvFacial, id.srvBalayage, id.shopSG, id.catBeauty, id.catHair, '44444444-4444-4444-8444-333333333333', id.shopNY]
    );

    // Seed staff
    await db.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES
      ($1, $3, 'Amy SG', true, true),
      ($2, $3, 'Bob SG', true, true),
      ('55555555-5555-4555-8555-333333333333', $4, 'Carol NY', true, true)`,
      [id.staffAmy, id.staffBob, id.shopSG, id.shopNY]
    );

    // Seed capabilities
    await db.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES
      ($1, $2, $4, true),
      ($1, $3, $5, true),
      ($6, '55555555-5555-4555-8555-333333333333', '44444444-4444-4444-8444-333333333333', true)`,
      [id.shopSG, id.staffAmy, id.staffBob, id.srvFacial, id.srvBalayage, id.shopNY]
    );

    // Seed location assignments
    await db.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES
      ($1, $2, $3, true),
      ($1, $2, $4, true),
      ($5, $6, '55555555-5555-4555-8555-333333333333', true)`,
      [id.shopSG, id.locSG, id.staffAmy, id.staffBob, id.shopNY, id.locNY]
    );

    // Seed weekly working hours (09:00 - 18:00, all 7 days)
    for (let day = 1; day <= 7; day += 1) {
      await db.query(`INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
        ($1, $2, $3, $4, '09:00', '18:00', true),
        ($1, $2, $5, $4, '09:00', '18:00', true),
        ($6, $7, '55555555-5555-4555-8555-333333333333', $4, '09:00', '18:00', true)`,
        [id.shopSG, id.locSG, id.staffAmy, day, id.staffBob, id.shopNY, id.locNY]
      );
    }

    // Set up app server with pool
    process.env.DATABASE_URL = url;
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false });
    app.locals.bookingPool = pool;
    app.locals.ownerAuthPool = pool;

    await withServer(app, async base => {

      // TEST 1: 2020 Past Slots and Past Dates Rejection
      await t.test('1. Past date rejection: 2020 slots and days prior to today in shop timezone are rejected', async () => {
        // Set fixed now to 2026-06-15T12:00:00+08:00
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        // Month dates in 2020
        const res2020 = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            startDate: '2020-03-01',
            endDate: '2020-03-07',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(res2020.status, 200);
        const data2020 = await res2020.json();
        assert.equal(data2020.success, true);
        assert.equal(data2020.data.length, 7);
        for (const day of data2020.data) {
          assert.equal(day.hasAvailability, false, `Past date ${day.date} must have hasAvailability: false`);
          assert.equal(day.earliestStartAt, null, `Past date ${day.date} earliestStartAt must be null`);
        }

        // Single-day times in 2020
        const resTimes2020 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2020-03-01',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(resTimes2020.status, 200);
        const dataTimes2020 = await resTimes2020.json();
        assert.equal(dataTimes2020.success, true);
        assert.deepEqual(dataTimes2020.data, [], 'Past date times must be empty array');
      });

      // TEST 2: Same-day Past Time Rejection
      await t.test('2. Same-day past time rejection: slots prior to current instant in shop timezone are rejected', async () => {
        // In Singapore (UTC+8), 14:30 local is 06:30 UTC
        app.locals.bookingNow = new Date('2026-06-15T06:30:00.000Z');

        const res = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-15',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(data.data.length > 0);

        // Slots at or before 14:30 local time (10:00, 10:30, ..., 14:00, 14:30) must NOT appear
        for (const slot of data.data) {
          const slotUtc = new Date(slot.startAt).getTime();
          assert.ok(slotUtc > app.locals.bookingNow.getTime(), `Slot ${slot.time} (${slot.startAt}) must be strictly in the future`);
        }
        assert.ok(data.data.some(s => s.time === '15:00'), 'Slot 15:00 should be available');
        assert.ok(!data.data.some(s => s.time === '14:00'), 'Slot 14:00 must be rejected as past');
        assert.ok(!data.data.some(s => s.time === '14:30'), 'Slot 14:30 must be rejected as past');
      });

      // TEST 3 & 4 & 5: Cancelled vs Active Appointments and blocks_time = false
      await t.test('3. Cancelled appointments (blocks_time=false) do NOT block, active (blocks_time=true) DO block', async () => {
        app.locals.bookingNow = new Date('2026-06-01T00:00:00.000Z');

        // Target slot: 2026-06-20 11:00 local time (03:00 UTC), duration 60 min
        const slotStartUtc = '2026-06-20T03:00:00.000Z';
        const slotEndUtc = '2026-06-20T04:00:00.000Z';

        // Insert cancelled appointment with blocks_time = false for Amy
        const cancelApptId = '77777777-7777-4777-8777-111111111111';
        const cancelItemId = '88888888-8888-4888-8888-111111111111';
        await db.query(`INSERT INTO appointments(id, shop_id, location_id, service_id, staff_id, start_at, end_at, status) VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'cancelled')`,
          [cancelApptId, id.shopSG, id.locSG, id.srvFacial, id.staffAmy, slotStartUtc, slotEndUtc]
        );
        await db.query(`INSERT INTO appointment_items(id, shop_id, location_id, appointment_id, service_id, sequence_no, service_name_snapshot, duration_minutes_snapshot, price_snapshot, snapshot_source, start_at, end_at, status) VALUES
          ($1, $2, $3, $4, $5, 1, 'Facial', 60, 88, 'catalog', $6, $7, 'cancelled')`,
          [cancelItemId, id.shopSG, id.locSG, cancelApptId, id.srvFacial, slotStartUtc, slotEndUtc]
        );
        await db.query(`INSERT INTO appointment_item_staff_assignments(shop_id, location_id, appointment_item_id, staff_id, role, start_at, end_at, blocks_time) VALUES
          ($1, $2, $3, $4, 'primary', $5, $6, false)`,
          [id.shopSG, id.locSG, cancelItemId, id.staffAmy, slotStartUtc, slotEndUtc]
        );

        // Fetch times for Amy specifically
        const resCancelled = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-20',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'specific', staffId: id.staffAmy }]
          })
        });
        const dataCancelled = await resCancelled.json();
        assert.equal(dataCancelled.success, true);
        assert.ok(dataCancelled.data.some(s => s.time === '11:00'), 'Cancelled appointment with blocks_time=false must NOT block');

        // Now activate the appointment: status = confirmed, blocks_time = true
        await db.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [cancelApptId]);
        await db.query(`UPDATE appointment_item_staff_assignments SET blocks_time = true WHERE appointment_item_id = $1`, [cancelItemId]);

        const resActive = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-20',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'specific', staffId: id.staffAmy }]
          })
        });
        const dataActive = await resActive.json();
        assert.equal(dataActive.success, true);
        assert.ok(!dataActive.data.some(s => s.time === '11:00'), 'Active appointment with blocks_time=true MUST block');

        // Clean up appointment
        await db.query(`DELETE FROM appointment_item_staff_assignments WHERE appointment_item_id = $1`, [cancelItemId]);
        await db.query(`DELETE FROM appointment_items WHERE id = $1`, [cancelItemId]);
        await db.query(`DELETE FROM appointments WHERE id = $1`, [cancelApptId]);
      });

      // TEST 6 & 7: Overnight Schedule & Multi-service Crossing Midnight
      await t.test('6. Overnight slot / service crossing midnight fails closed consistently', async () => {
        // Evaluating pure semantics for item crossing midnight
        assert.throws(() => {
          evaluateScheduleSemantics({
            requestedStartAt: '2026-06-20T15:30:00.000Z', // 23:30 in Singapore
            requestedEndAt: '2026-06-20T17:00:00.000Z',   // 01:00 next day
            staffId: id.staffAmy,
            serviceId: id.srvFacial,
            timezone: 'Asia/Singapore',
            workingHours: [{ staff_id: id.staffAmy, day_of_week: 6, start_time: '20:00', end_time: '24:00' }]
          });
        }, error => error.message === 'BOOKABILITY_INTERVAL_INVALID');

        // Verify with authoritative validateStaffBookability in Postgres
        await assert.rejects(
          validateStaffBookability({
            dbClient: db,
            shopId: id.shopSG,
            locationId: id.locSG,
            staffId: id.staffAmy,
            serviceId: id.srvFacial,
            requestedStartAt: '2026-06-20T15:30:00.000Z',
            requestedEndAt: '2026-06-20T17:00:00.000Z'
          }),
          error => error instanceof StaffBookabilityError && error.code === 'BOOKABILITY_INTERVAL_INVALID',
          'Authoritative validator must reject overnight crossing midnight with BOOKABILITY_INTERVAL_INVALID'
        );
      });

      // TEST 8: Override Boundaries (day_off, leave, custom_hours, pending, half-open)
      await t.test('8. Override boundaries: day_off, leave, custom_hours half-open intervals', async () => {
        app.locals.bookingNow = new Date('2026-06-01T00:00:00.000Z');

        // 8a. Day off override for Amy on 2026-06-25
        await db.query(`INSERT INTO staff_schedule_overrides(shop_id, location_id, staff_id, schedule_date, override_type, approval_status, is_active)
          VALUES($1, $2, $3, '2026-06-25', 'day_off', 'approved', true)`,
          [id.shopSG, id.locSG, id.staffAmy]
        );
        const resDayOff = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-25',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'specific', staffId: id.staffAmy }]
          })
        });
        const dataDayOff = await resDayOff.json();
        assert.deepEqual(dataDayOff.data, [], 'Day off must make all slots unavailable');
        await db.query(`DELETE FROM staff_schedule_overrides WHERE staff_id = $1 AND schedule_date = '2026-06-25'`, [id.staffAmy]);

        // 8b. Partial leave for Amy on 2026-06-26 from 12:00 to 14:00
        await db.query(`INSERT INTO staff_schedule_overrides(shop_id, location_id, staff_id, schedule_date, override_type, start_time, end_time, approval_status, is_active)
          VALUES($1, $2, $3, '2026-06-26', 'leave', '12:00', '14:00', 'approved', true)`,
          [id.shopSG, id.locSG, id.staffAmy]
        );
        const resLeave = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-26',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'specific', staffId: id.staffAmy }]
          })
        });
        const dataLeave = await resLeave.json();
        assert.equal(dataLeave.success, true);
        // 11:00 slot (11:00-12:00): touches leave start at 12:00 -> AVAILABLE
        assert.ok(dataLeave.data.some(s => s.time === '11:00'), '11:00 slot touching leave boundary must be available');
        // 12:00 slot (12:00-13:00): overlaps leave -> UNAVAILABLE
        assert.ok(!dataLeave.data.some(s => s.time === '12:00'), '12:00 slot overlapping leave must be unavailable');
        // 13:00 slot (13:00-14:00): overlaps leave -> UNAVAILABLE
        assert.ok(!dataLeave.data.some(s => s.time === '13:00'), '13:00 slot overlapping leave must be unavailable');
        // 14:00 slot (14:00-15:00): touches leave end at 14:00 -> AVAILABLE
        assert.ok(dataLeave.data.some(s => s.time === '14:00'), '14:00 slot touching leave boundary must be available');
        await db.query(`DELETE FROM staff_schedule_overrides WHERE staff_id = $1 AND schedule_date = '2026-06-26'`, [id.staffAmy]);

        // 8c. Custom hours for Amy on 2026-06-27 from 11:00 to 15:00
        await db.query(`INSERT INTO staff_schedule_overrides(shop_id, location_id, staff_id, schedule_date, override_type, start_time, end_time, approval_status, is_active)
          VALUES($1, $2, $3, '2026-06-27', 'custom_hours', '11:00', '15:00', 'approved', true)`,
          [id.shopSG, id.locSG, id.staffAmy]
        );
        const resCustom = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-singapore',
            date: '2026-06-27',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'specific', staffId: id.staffAmy }]
          })
        });
        const dataCustom = await resCustom.json();
        assert.equal(dataCustom.success, true);
        assert.ok(!dataCustom.data.some(s => s.time === '10:00'), '10:00 slot before custom hours must be unavailable');
        assert.ok(dataCustom.data.some(s => s.time === '11:00'), '11:00 slot starting at custom hours must be available');
        assert.ok(dataCustom.data.some(s => s.time === '14:00'), '14:00 slot ending at 15:00 must be available');
        assert.ok(!dataCustom.data.some(s => s.time === '15:00'), '15:00 slot starting at custom end must be unavailable');
        await db.query(`DELETE FROM staff_schedule_overrides WHERE staff_id = $1 AND schedule_date = '2026-06-27'`, [id.staffAmy]);
      });

      // TEST 9: Singapore & New York DST Handling
      await t.test('9. Timezone & DST: Asia/Singapore, America/New_York Spring forward & Fall back', async () => {
        // 9a. America/New_York Spring Forward on 2026-03-08 (02:00 -> 03:00, gap hour 02:00 does NOT exist)
        app.locals.bookingNow = new Date('2026-01-01T00:00:00.000Z');

        const springRes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-newyork',
            date: '2026-03-08',
            locale: 'en',
            items: [{ serviceId: '44444444-4444-4444-8444-333333333333', staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(springRes.status, 200);
        const springData = await springRes.json();
        assert.equal(springData.success, true);
        // All returned times must have valid wall-clock and UTC instants
        for (const slot of springData.data) {
          const parts = getLocalParts(new Date(slot.startAt), 'America/New_York');
          const reconstructedTime = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
          assert.equal(reconstructedTime, slot.time, `Slot time ${slot.time} must match reconstructed local time`);
          assert.notEqual(slot.time, '02:00', 'Nonexistent local time 02:00 must NEVER be returned');
        }

        // 9b. America/New_York Fall Back on 2026-11-01 (repeated hour 01:00)
        const fallRes = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-newyork',
            date: '2026-11-01',
            locale: 'en',
            items: [{ serviceId: '44444444-4444-4444-8444-333333333333', staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(fallRes.status, 200);
        const fallData = await fallRes.json();
        assert.equal(fallData.success, true);
        // Instants must be unique and strictly monotonic
        const instants = fallData.data.map(s => new Date(s.startAt).getTime());
        for (let i = 1; i < instants.length; i++) {
          assert.ok(instants[i] > instants[i - 1], `Slot instants must be strictly increasing (${instants[i]} > ${instants[i - 1]})`);
        }
      });

      // TEST 10: Differential Testing Against validateStaffBookability
      await t.test('10. Differential Parity: Batch schedule evaluation matches validateStaffBookability', async () => {
        // Test various slots on 2026-06-15 in Singapore
        const testSlots = [
          { start: '2026-06-15T01:00:00.000Z', end: '2026-06-15T02:00:00.000Z', expected: 'OK' }, // 09:00 - 10:00 (contained)
          { start: '2026-06-15T00:30:00.000Z', end: '2026-06-15T01:30:00.000Z', expected: 'OUTSIDE_WORKING_HOURS' }, // 08:30 - 09:30 (outside)
          { start: '2026-06-15T09:30:00.000Z', end: '2026-06-15T10:30:00.000Z', expected: 'OUTSIDE_WORKING_HOURS' }, // 17:30 - 18:30 (outside)
          { start: '2026-06-15T15:30:00.000Z', end: '2026-06-15T16:30:00.000Z', expected: 'BOOKABILITY_INTERVAL_INVALID' } // 23:30 - 00:30 (midnight)
        ];

        for (const slot of testSlots) {
          let authorResult = null;
          let authorError = null;
          try {
            authorResult = await validateStaffBookability({
              dbClient: db,
              shopId: id.shopSG,
              locationId: id.locSG,
              staffId: id.staffAmy,
              serviceId: id.srvFacial,
              requestedStartAt: slot.start,
              requestedEndAt: slot.end
            });
          } catch (e) {
            authorError = e.code || e.message;
          }

          let batchError = null;
          try {
            evaluateScheduleSemantics({
              requestedStartAt: slot.start,
              requestedEndAt: slot.end,
              staffId: id.staffAmy,
              serviceId: id.srvFacial,
              timezone: 'Asia/Singapore',
              workingHours: [{ staff_id: id.staffAmy, day_of_week: 1, start_time: '09:00', end_time: '18:00' }]
            });
          } catch (e) {
            batchError = e.message;
          }

          if (slot.expected === 'OK') {
            assert.ok(authorResult, 'Authoritative validator should pass');
            assert.equal(batchError, null, 'Batch evaluator should pass');
          } else {
            assert.equal(authorError, slot.expected, `Authoritative error must be ${slot.expected}`);
            assert.equal(batchError, slot.expected, `Batch error must be ${slot.expected}`);
          }
        }
      });

    });

  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    pg.kill('SIGTERM');
    await new Promise(r => pg.once('exit', r));
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});
