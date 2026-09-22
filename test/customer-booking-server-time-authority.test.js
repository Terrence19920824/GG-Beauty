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
CREATE TABLE service_categories(id uuid PRIMARY KEY, shop_id uuid NOT NULL, is_active boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE services(id uuid PRIMARY KEY, shop_id uuid NOT NULL, category_id uuid, name text NOT NULL, description text, duration_minutes integer NOT NULL, price numeric NOT NULL, price_is_from boolean NOT NULL, is_active boolean NOT NULL, bookable boolean NOT NULL, UNIQUE(shop_id, id));
CREATE TABLE service_translations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, service_id uuid NOT NULL, locale text NOT NULL, name text, description text);
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL, service_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, is_active boolean NOT NULL);
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, staff_id uuid NOT NULL, day_of_week integer NOT NULL, start_time time NOT NULL, end_time time NOT NULL, is_active boolean NOT NULL, effective_from date, effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, location_id uuid, staff_id uuid, schedule_date date, is_active boolean, approval_status text, override_type text, start_time time, end_time time);
CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, name text NOT NULL, phone text NOT NULL, email text);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, customer_id uuid NOT NULL, service_id uuid NOT NULL, staff_id uuid NOT NULL, appointment_no text NOT NULL DEFAULT ('GG-'||substr(gen_random_uuid()::text,1,8)), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, booking_source text, override_conflict boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id, location_id, id), UNIQUE(shop_id, id), FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT, CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist(staff_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&) WHERE (status IN ('pending', 'confirmed') AND override_conflict = false));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL, service_name_snapshot text NOT NULL, service_locale_snapshot text, duration_minutes_snapshot integer NOT NULL, price_snapshot numeric, snapshot_source text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_items_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, id), FOREIGN KEY(shop_id, location_id, appointment_id) REFERENCES appointments(shop_id, location_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL, appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL CHECK(role IN('primary','assistant')), start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at > start_at), UNIQUE(shop_id, location_id, appointment_item_id, staff_id), FOREIGN KEY(shop_id, location_id, appointment_item_id) REFERENCES appointment_items(shop_id, location_id, id) ON DELETE RESTRICT, FOREIGN KEY(shop_id, staff_id) REFERENCES staff(shop_id, id) ON DELETE RESTRICT);
CREATE TABLE appointment_status_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, appointment_id uuid NOT NULL, from_status text NOT NULL, to_status text NOT NULL, operator_type text NOT NULL, operator_id text, source text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id, location_id, appointment_item_id) WHERE role = 'primary';
CREATE INDEX appointment_item_staff_schedule_idx ON appointment_item_staff_assignments(shop_id, location_id, staff_id, start_at, end_at);
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

test('Customer Booking Server Time Authority & Final Write Revalidation Suite', { timeout: 180000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-time-authority-pg-'));
  const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 58600 + Math.floor(Math.random() * 200);
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

    // Apply migrations for complete booking customer schema
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

    // Seed categories & services (Beauty and Hair)
    await db.query(`INSERT INTO service_categories(id, shop_id, is_active) VALUES ($1, $3, true), ($2, $3, true)`,
      [id.catBeauty, id.catHair, id.shopSG]
    );
    await db.query(`INSERT INTO services(id, shop_id, category_id, name, duration_minutes, price, price_is_from, is_active, bookable) VALUES
      ($1, $3, $4, 'Facial', 60, 88, false, true, true),
      ($2, $3, $5, 'Balayage', 120, 238, true, true, true)`,
      [id.srvFacial, id.srvBalayage, id.shopSG, id.catBeauty, id.catHair]
    );
    await db.query(`INSERT INTO service_translations(shop_id, service_id, locale, name) VALUES
      ($1, $2, 'en', 'Basic Facial'), ($1, $2, 'zh-CN', '基础面部护理'),
      ($1, $3, 'en', 'Balayage'), ($1, $3, 'zh-CN', 'Balayage渐层染')`,
      [id.shopSG, id.srvFacial, id.srvBalayage]
    );

    // Seed staff
    await db.query(`INSERT INTO staff(id, shop_id, name, is_active, bookable) VALUES
      ($1, $3, 'Amy', true, true),
      ($2, $3, 'Bob', true, true)`,
      [id.staffAmy, id.staffBob, id.shopSG]
    );

    // Seed capabilities
    await db.query(`INSERT INTO staff_services(shop_id, staff_id, service_id, is_active) VALUES
      ($1, $2, $4, true),
      ($1, $3, $5, true)`,
      [id.shopSG, id.staffAmy, id.staffBob, id.srvFacial, id.srvBalayage]
    );

    // Seed location assignments and working hours 10:00 - 21:00 everyday
    await db.query(`INSERT INTO staff_location_assignments(shop_id, location_id, staff_id, is_active) VALUES
      ($1, $2, $3, true), ($1, $2, $4, true)`,
      [id.shopSG, id.locSG, id.staffAmy, id.staffBob]
    );
    for (let day = 1; day <= 7; day += 1) {
      await db.query(
        `INSERT INTO staff_location_working_hours(shop_id, location_id, staff_id, day_of_week, start_time, end_time, is_active) VALUES
         ($1, $2, $3, $4, '10:00', '21:00', true),
         ($1, $2, $5, $4, '10:00', '21:00', true)`,
        [id.shopSG, id.locSG, id.staffAmy, day, id.staffBob]
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

      // 1. Forged now in request body (2020 vs 2099 vs omitted) cannot alter date or time responses
      await t.test('1. Request body now (2020 vs 2099 vs omitted) cannot alter availability', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        const basePayload = {
          shopSlug: 'gg-beauty',
          startDate: '2026-06-10',
          endDate: '2026-06-20',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
        };

        const resNormal = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(basePayload)
        });
        const dataNormal = await resNormal.json();

        const res2020 = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...basePayload, now: '2020-01-01T00:00:00.000Z' })
        });
        const data2020 = await res2020.json();

        const res2099 = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...basePayload, now: '2099-01-01T00:00:00.000Z' })
        });
        const data2099 = await res2099.json();

        assert.deepEqual(data2020, dataNormal, 'body.now=2020 must produce identical response to normal');
        assert.deepEqual(data2099, dataNormal, 'body.now=2099 must produce identical response to normal');

        // Times endpoint test
        const timesBasePayload = {
          shopSlug: 'gg-beauty',
          date: '2026-06-15',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
        };

        const resTimesNormal = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(timesBasePayload)
        });
        const dataTimesNormal = await resTimesNormal.json();

        const resTimes2020 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...timesBasePayload, now: '2020-01-01T00:00:00.000Z' })
        });
        const dataTimes2020 = await resTimes2020.json();

        const resTimes2099 = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...timesBasePayload, now: '2099-01-01T00:00:00.000Z' })
        });
        const dataTimes2099 = await resTimes2099.json();

        assert.deepEqual(dataTimes2020, dataTimesNormal, 'times body.now=2020 must produce identical response');
        assert.deepEqual(dataTimes2099, dataTimesNormal, 'times body.now=2099 must produce identical response');
      });

      // 2. Query, header, and cookie forged time are completely inert
      await t.test('2. Query, header, and cookie forged time cannot alter availability', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        const payload = {
          shopSlug: 'gg-beauty',
          date: '2026-06-15',
          locale: 'zh-CN',
          items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
        };

        const resNormal = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const dataNormal = await resNormal.json();

        // With forged query
        const resQuery = await fetch(`${base}/api/booking/multi-service-available-times?now=2020-01-01T00:00:00Z&current_time=2020-01-01`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const dataQuery = await resQuery.json();

        // With forged headers
        const resHeader = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-now': '2020-01-01T00:00:00Z',
            'x-client-time': '2020-01-01T00:00:00Z',
            'date': 'Wed, 01 Jan 2020 00:00:00 GMT'
          },
          body: JSON.stringify(payload)
        });
        const dataHeader = await resHeader.json();

        // With forged cookies
        const resCookie = await fetch(`${base}/api/booking/multi-service-available-times`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cookie': 'now=2020-01-01; client_time=2020-01-01; server_time=2020-01-01'
          },
          body: JSON.stringify(payload)
        });
        const dataCookie = await resCookie.json();

        assert.deepEqual(dataQuery, dataNormal, 'query now must not alter times');
        assert.deepEqual(dataHeader, dataNormal, 'header now must not alter times');
        assert.deepEqual(dataCookie, dataNormal, 'cookie now must not alter times');
      });

      // 3. Production clock authority (without test override): uses real server clock
      await t.test('3. Production clock defaults to real server clock, past dates rejected', async () => {
        delete app.locals.bookingNow;

        // Query 2020 dates without test injection
        const res = await fetch(`${base}/api/booking/multi-service-available-dates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startDate: '2020-01-01',
            endDate: '2020-01-05',
            locale: 'zh-CN',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.data.length, 5);
        for (const item of data.data) {
          assert.equal(item.hasAvailability, false, `Date ${item.date} in 2020 must be unavailable`);
          assert.equal(item.earliestStartAt, null);
        }
      });

      // 4. Final write protection: /api/new-db in same transaction rejects past appointment with 400 and zero DB rows written
      await t.test('4. /api/new-db in same transaction rejects past appointment with 400 and zero DB writes', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        // Record counts before past write attempt
        const getCounts = async () => ({
          customers: Number((await db.query('SELECT count(*) FROM customers')).rows[0].count),
          appointments: Number((await db.query('SELECT count(*) FROM appointments')).rows[0].count),
          items: Number((await db.query('SELECT count(*) FROM appointment_items')).rows[0].count),
          assignments: Number((await db.query('SELECT count(*) FROM appointment_item_staff_assignments')).rows[0].count),
          history: Number((await db.query('SELECT count(*) FROM appointment_status_history')).rows[0].count)
        });

        const before = await getCounts();

        // Attempt past multi-service write (startAt in 2020)
        const pastRes = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            locale: 'zh-CN',
            customerName: 'Past Booker',
            phone: '+65 9123 4567',
            startAt: '2020-01-01T02:00:00.000Z',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });

        assert.equal(pastRes.status, 400, 'Past write must be rejected with HTTP 400');
        const pastBody = await pastRes.json();
        assert.equal(pastBody.success, false);
        assert.match(pastBody.message, /所选时间已过|无法预约/);

        // Verify strictly 0 rows added to any table
        const afterPast = await getCounts();
        assert.deepEqual(afterPast, before, 'Past write attempt must write exactly zero rows to all tables');

        // Attempt same-day past slot (at 12:00 SG time = 04:00 UTC, attempt 11:00 SG time = 03:00 UTC)
        const sameDayPastRes = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            locale: 'zh-CN',
            customerName: 'Same Day Past Booker',
            phone: '+65 9123 4568',
            startAt: '2026-06-15T03:00:00.000Z',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });

        assert.equal(sameDayPastRes.status, 400, 'Same-day past slot must be rejected with HTTP 400');
        const afterSameDay = await getCounts();
        assert.deepEqual(afterSameDay, before, 'Same-day past write must write zero rows');
      });

      // 5. Forged now in request body/query/headers cannot bypass past appointment write rejection
      await t.test('5. Forged now in request body/query/headers cannot bypass past appointment write rejection', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        const getCounts = async () => ({
          customers: Number((await db.query('SELECT count(*) FROM customers')).rows[0].count),
          appointments: Number((await db.query('SELECT count(*) FROM appointments')).rows[0].count),
          items: Number((await db.query('SELECT count(*) FROM appointment_items')).rows[0].count),
          assignments: Number((await db.query('SELECT count(*) FROM appointment_item_staff_assignments')).rows[0].count),
          history: Number((await db.query('SELECT count(*) FROM appointment_status_history')).rows[0].count)
        });

        const before = await getCounts();

        // Send past booking with body.now=2099, query ?now=2099, and header x-now=2099
        const res = await fetch(`${base}/api/new-db?now=2099-01-01T00:00:00.000Z`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-now': '2099-01-01T00:00:00.000Z'
          },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            locale: 'zh-CN',
            customerName: 'Attacker Clock',
            phone: '+65 9123 4569',
            startAt: '2020-01-01T02:00:00.000Z',
            now: '2099-01-01T00:00:00.000Z',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });

        assert.equal(res.status, 400, 'Tampered now request must still be rejected with HTTP 400');
        const after = await getCounts();
        assert.deepEqual(after, before, 'Zero rows written even with forged clock parameters');
      });

      // 6. Single-service legacy path also rejects past appointment with 400 and zero writes
      await t.test('6. Single-service legacy write path rejects past appointment with 400 and zero DB writes', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        const getCounts = async () => ({
          customers: Number((await db.query('SELECT count(*) FROM customers')).rows[0].count),
          appointments: Number((await db.query('SELECT count(*) FROM appointments')).rows[0].count),
          items: Number((await db.query('SELECT count(*) FROM appointment_items')).rows[0].count),
          assignments: Number((await db.query('SELECT count(*) FROM appointment_item_staff_assignments')).rows[0].count),
          history: Number((await db.query('SELECT count(*) FROM appointment_status_history')).rows[0].count)
        });

        const before = await getCounts();

        const res = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            locale: 'zh-CN',
            customerName: 'Legacy Past',
            phone: '+65 9123 4570',
            serviceId: id.srvFacial,
            staffSelectionType: 'no_preference',
            date: '2020-01-01',
            time: '10:00'
          })
        });

        assert.equal(res.status, 400, 'Single-service past write must be rejected with HTTP 400');
        const after = await getCounts();
        assert.deepEqual(after, before, 'Single-service past write must write zero rows');
      });

      // 7. Maintenance mode priority: BOOKING_WRITE_MAINTENANCE=true blocks write with 503
      await t.test('7. Maintenance mode priority: BOOKING_WRITE_MAINTENANCE=true blocks write with 503', async () => {
        process.env.BOOKING_WRITE_MAINTENANCE = 'true';
        try {
          const res = await fetch(`${base}/api/new-db`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              shopSlug: 'gg-beauty',
              locale: 'zh-CN',
              customerName: 'Maintenance Test',
              phone: '+65 9123 4571',
              startAt: '2030-01-07T02:00:00.000Z',
              items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
            })
          });
          assert.equal(res.status, 503);
          const body = await res.json();
          assert.equal(body.code, 'BOOKING_MAINTENANCE');
        } finally {
          delete process.env.BOOKING_WRITE_MAINTENANCE;
        }
      });

      // 8. Legitimate future appointment creation succeeds with HTTP 200 and commits all rows
      await t.test('8. Legitimate future appointment creation succeeds with HTTP 200 and commits all rows', async () => {
        app.locals.bookingNow = new Date('2026-06-15T04:00:00.000Z');

        const res = await fetch(`${base}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            locale: 'zh-CN',
            customerName: 'Future Booker',
            phone: '+65 9123 4572',
            startAt: '2030-01-07T02:00:00.000Z',
            items: [{ serviceId: id.srvFacial, staffSelectionType: 'no_preference' }]
          })
        });

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.message, '预约成功');
        assert.ok(body.data.id);

        // Verify rows exist in DB
        const appt = (await db.query('SELECT * FROM appointments WHERE id = $1', [body.data.id])).rows;
        assert.equal(appt.length, 1);
        const items = (await db.query('SELECT * FROM appointment_items WHERE appointment_id = $1', [body.data.id])).rows;
        assert.equal(items.length, 1);
        const assignments = (await db.query('SELECT * FROM appointment_item_staff_assignments WHERE appointment_item_id = $1', [items[0].id])).rows;
        assert.equal(assignments.length, 1);
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
