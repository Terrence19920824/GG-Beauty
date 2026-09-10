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
  shop: '11111111-1111-4111-8111-111111111111', location: '22222222-2222-4222-8222-222222222222',
  category: '33333333-3333-4333-8333-333333333333',
  serviceA: '44444444-4444-4444-8444-111111111111', serviceB: '44444444-4444-4444-8444-222222222222',
  staffA: '55555555-5555-4555-8555-111111111111', staffB: '55555555-5555-4555-8555-222222222222'
};

const SCHEMA = `
CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto;
CREATE TABLE shops(id uuid PRIMARY KEY,slug text UNIQUE NOT NULL,status text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY,shop_id uuid NOT NULL,timezone text NOT NULL,is_active boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shop_id,id));
CREATE TABLE staff(id uuid PRIMARY KEY,shop_id uuid NOT NULL,name text NOT NULL,is_active boolean NOT NULL,bookable boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE service_categories(id uuid PRIMARY KEY,shop_id uuid NOT NULL,is_active boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE services(id uuid PRIMARY KEY,shop_id uuid NOT NULL,category_id uuid,name text NOT NULL,description text,duration_minutes integer NOT NULL,price numeric NOT NULL,price_is_from boolean NOT NULL,is_active boolean NOT NULL,bookable boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE service_translations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,service_id uuid NOT NULL,locale text NOT NULL,name text,description text);
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,staff_id uuid NOT NULL,service_id uuid NOT NULL,is_active boolean NOT NULL);
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,staff_id uuid NOT NULL,is_active boolean NOT NULL);
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,staff_id uuid NOT NULL,day_of_week integer NOT NULL,start_time time NOT NULL,end_time time NOT NULL,is_active boolean NOT NULL,effective_from date,effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid,location_id uuid,staff_id uuid,schedule_date date,is_active boolean,approval_status text,override_type text,start_time time,end_time time);
CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,name text NOT NULL,phone text NOT NULL,email text);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,customer_id uuid NOT NULL,service_id uuid NOT NULL,staff_id uuid NOT NULL,appointment_no text NOT NULL DEFAULT ('GG-'||substr(gen_random_uuid()::text,1,8)),start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,status text NOT NULL,booking_source text,override_conflict boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shop_id,location_id,id),UNIQUE(shop_id,id),FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT,FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id) ON DELETE RESTRICT,CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist(staff_id WITH =,tstzrange(start_at,end_at,'[)') WITH &&) WHERE(status IN('pending','confirmed') AND override_conflict=false));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,appointment_id uuid NOT NULL,service_id uuid NOT NULL,sequence_no integer NOT NULL,service_name_snapshot text NOT NULL,service_locale_snapshot text,duration_minutes_snapshot integer NOT NULL,price_snapshot numeric,snapshot_source text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT appointment_items_time_range_check CHECK(end_at>start_at),UNIQUE(shop_id,location_id,id),FOREIGN KEY(shop_id,location_id,appointment_id) REFERENCES appointments(shop_id,location_id,id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,appointment_item_id uuid NOT NULL,staff_id uuid NOT NULL,role text NOT NULL CHECK(role IN('primary','assistant')),start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at>start_at),UNIQUE(shop_id,location_id,appointment_item_id,staff_id),FOREIGN KEY(shop_id,location_id,appointment_item_id) REFERENCES appointment_items(shop_id,location_id,id) ON DELETE RESTRICT,FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id) ON DELETE RESTRICT);
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id,location_id,appointment_item_id) WHERE role='primary';
CREATE INDEX appointment_item_staff_schedule_idx ON appointment_item_staff_assignments(shop_id,location_id,staff_id,start_at,end_at);
`;

const withServer = async (app, operation) => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try { return await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('real PostgreSQL customer endpoint creates canonical multi-service and legacy bookings', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-customer-multi-pg-')); const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 56500 + Math.floor(Math.random() * 400); const pg = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`; let db; let pool;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) { try { db = new Client({ connectionString: url }); await db.connect(); break; } catch { if (db) await db.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(db); await db.query(SCHEMA);
    for (const number of ['028_booking_recipient_booker_preflight_readonly.sql','029_booking_recipient_booker_schema.sql','030_booking_recipient_booker_legacy_backfill.sql','031_booking_recipient_booker_consistency.sql','032_booking_recipient_booker_verification_readonly.sql']) await db.query(migration(number));
    await db.query(migration('014_assignment_collision_projection_schema.sql'));
    await db.query(migration('015_assignment_collision_backfill.sql'));
    await db.query(migration('016_assignment_collision_constraint.sql'));
    await db.query(migration('026_multi_service_parent_collision_compatibility.sql'));
    await db.query(`INSERT INTO shops VALUES($1,'tenant-a','active')`, [id.shop]);
    await db.query(`INSERT INTO locations(id,shop_id,timezone,is_active) VALUES($1,$2,'Asia/Singapore',true)`, [id.location, id.shop]);
    await db.query(`INSERT INTO service_categories VALUES($1,$2,true)`, [id.category, id.shop]);
    await db.query(`INSERT INTO staff VALUES($1,$3,'Amy',true,true),($2,$3,'Bob',true,true)`, [id.staffA, id.staffB, id.shop]);
    await db.query(`INSERT INTO services VALUES($1,$3,$4,'Facial',NULL,60,88,false,true,true),($2,$3,$4,'Balayage',NULL,180,238,true,true,true)`, [id.serviceA, id.serviceB, id.shop, id.category]);
    await db.query(`INSERT INTO service_translations(shop_id,service_id,locale,name) VALUES($1,$2,'en','Basic Facial'),($1,$2,'zh-CN','基础面部护理'),($1,$3,'en','Balayage'),($1,$3,'zh-CN','Balayage渐层染')`, [id.shop, id.serviceA, id.serviceB]);
    await db.query(`INSERT INTO staff_services(shop_id,staff_id,service_id,is_active) VALUES($1,$2,$4,true),($1,$3,$4,true),($1,$2,$5,true)`, [id.shop, id.staffA, id.staffB, id.serviceA, id.serviceB]);
    for (const staffId of [id.staffA, id.staffB]) { await db.query(`INSERT INTO staff_location_assignments(shop_id,location_id,staff_id,is_active) VALUES($1,$2,$3,true)`, [id.shop, id.location, staffId]); for (let day = 1; day <= 7; day += 1) await db.query(`INSERT INTO staff_location_working_hours(shop_id,location_id,staff_id,day_of_week,start_time,end_time,is_active) VALUES($1,$2,$3,$4,'09:00','21:00',true)`, [id.shop, id.location, staffId, day]); }
    process.env.DATABASE_URL = url; delete process.env.BOOKING_WRITE_MAINTENANCE;
    delete require.cache[require.resolve('../server')]; const { app } = require('../server');
    pool = new Pool({ connectionString: url, ssl: false }); app.locals.bookingPool = pool;
    const post = (base, body) => fetch(`${base}/api/new-db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const baseBody = { shopSlug: 'tenant-a', locale: 'en', customerName: 'Customer', phone: '00000000' };
    const inspect = async appointmentId => (await db.query(`SELECT p.*,json_agg(json_build_object('sequence',i.sequence_no,'service',i.service_id,'name',i.service_name_snapshot,'locale',i.service_locale_snapshot,'duration',i.duration_minutes_snapshot,'price',i.price_snapshot,'start',i.start_at,'end',i.end_at,'staff',a.staff_id) ORDER BY i.sequence_no) items FROM appointments p JOIN appointment_items i ON i.appointment_id=p.id JOIN appointment_item_staff_assignments a ON a.appointment_item_id=i.id AND a.role='primary' WHERE p.id=$1 GROUP BY p.id`, [appointmentId])).rows[0];

    await withServer(app, async base => {
      await t.test('same staff stores exactly two authoritative sequential items', async () => {
        const response = await post(base, { ...baseBody, phone: 'same', startAt: '2030-01-07T02:00:00Z', items: [{ serviceId: id.serviceA, staffSelectionType: 'specific', staffId: id.staffA }, { serviceId: id.serviceB, staffSelectionType: 'specific', staffId: id.staffA }] });
        assert.equal(response.status, 200); const saved = await inspect((await response.json()).data.id);
        assert.equal(saved.items.length, 2); assert.deepEqual(saved.items.map(item => item.sequence), [1, 2]); assert.deepEqual(saved.items.map(item => item.staff), [id.staffA, id.staffA]);
        assert.equal(new Date(saved.items[1].start).toISOString(), new Date(saved.items[0].end).toISOString()); assert.equal(saved.staff_id, id.staffA); assert.equal(saved.service_id, id.serviceA);
        assert.equal(new Date(saved.start_at).toISOString(), new Date(saved.items[0].start).toISOString()); assert.equal(new Date(saved.end_at).toISOString(), new Date(saved.items[1].end).toISOString());
        assert.deepEqual(saved.items.map(item => [item.name, item.locale, item.duration, Number(item.price)]), [['Basic Facial', 'en', 60, 88], ['Balayage', 'en', 180, 238]]);
        assert.equal(saved.customer_id, saved.recipient_customer_id); assert.equal(saved.booker_customer_id, saved.recipient_customer_id);
        assert.equal(saved.booker_name_snapshot, 'Customer'); assert.equal(saved.recipient_phone_snapshot, 'same');
      });
      await t.test('no preference endpoint solves scarce-staff fixture as B then A', async () => {
        const response = await post(base, { ...baseBody, phone: 'greedy', startAt: '2030-01-08T02:00:00Z', items: [{ serviceId: id.serviceA, staffSelectionType: 'no_preference' }, { serviceId: id.serviceB, staffSelectionType: 'no_preference' }] });
        assert.equal(response.status, 200); const saved = await inspect((await response.json()).data.id); assert.deepEqual(saved.items.map(item => item.staff), [id.staffB, id.staffA]);
      });
      for (const reverse of [false, true]) await t.test(reverse ? 'no preference then specific' : 'specific then no preference', async () => {
        const specificIndex = reverse ? 1 : 0; const services = reverse ? [id.serviceA, id.serviceB] : [id.serviceA, id.serviceB];
        const items = services.map((serviceId, index) => index === specificIndex ? { serviceId, staffSelectionType: 'specific', staffId: id.staffA } : { serviceId, staffSelectionType: 'no_preference' });
        const response = await post(base, { ...baseBody, phone: `mixed-${reverse}`, startAt: reverse ? '2030-01-09T02:00:00Z' : '2030-01-10T02:00:00Z', items });
        assert.equal(response.status, 200); const saved = await inspect((await response.json()).data.id); assert.equal(saved.items[specificIndex].staff, id.staffA);
      });
      await t.test('legacy date/time and startAt-only shapes both create parent item and primary', async () => {
        let response = await post(base, { ...baseBody, phone: 'legacy-date', serviceId: id.serviceA, staffSelectionType: 'specific', staffId: id.staffA, date: '2030-01-11', time: '10:00' }); assert.equal(response.status, 200); let saved = await inspect((await response.json()).data.id); assert.equal(saved.items.length, 1);
        response = await post(base, { ...baseBody, phone: 'legacy-start', serviceId: id.serviceA, staffSelectionType: 'no_preference', startAt: '2030-01-12T02:00:00Z' }); assert.equal(response.status, 200); saved = await inspect((await response.json()).data.id); assert.equal(saved.items.length, 1); assert.ok([id.staffA, id.staffB].includes(saved.items[0].staff));
      });
    });
  } finally {
    if (pool) await pool.end().catch(() => {}); if (db) await db.end().catch(() => {}); pg.kill('SIGTERM'); await new Promise(resolve => pg.once('exit', resolve)); fs.rmSync(temp, { recursive: true, force: true });
  }
});
