'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const {
  loadAndValidatePhaseAStructure,
  AppointmentMutationError
} = require('../lib/appointment-multi-service');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migrations = [13, 14, 15, 16, 17].map(number => {
  const name = fs.readdirSync(path.join(ROOT, 'migrations')).find(file => file.startsWith(`${String(number).padStart(3, '0')}_`));
  return path.join(ROOT, 'migrations', name);
});
const parentCompatibilityMigrations = [22, 23, 24].map(number => {
  const name = fs.readdirSync(path.join(ROOT, 'migrations')).find(file => file.startsWith(`${String(number).padStart(3, '0')}_`));
  return path.join(ROOT, 'migrations', name);
});
const sql = file => fs.readFileSync(file, 'utf8');

const BASE_SCHEMA = `
CREATE EXTENSION btree_gist;
CREATE EXTENSION pgcrypto;
CREATE TABLE shops(id uuid PRIMARY KEY);
CREATE TABLE locations(id uuid PRIMARY KEY,shop_id uuid NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE staff(id uuid PRIMARY KEY,shop_id uuid NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE appointments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,
 service_id uuid,staff_id uuid NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending',override_conflict boolean NOT NULL DEFAULT false,
 CONSTRAINT appointments_check CHECK(end_at>start_at),
 CONSTRAINT appointments_shop_location_id_uidx UNIQUE(shop_id,location_id,id),
 CONSTRAINT appointments_staff_fkey FOREIGN KEY(shop_id,staff_id)
   REFERENCES staff(shop_id,id) ON DELETE RESTRICT,
 CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist
   (staff_id WITH =,tstzrange(start_at,end_at,'[)') WITH &&)
   WHERE(status IN ('pending','confirmed') AND override_conflict=false)
);
CREATE TABLE appointment_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,
 appointment_id uuid NOT NULL,service_id uuid,sequence_no integer NOT NULL DEFAULT 1,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending',
 CONSTRAINT appointment_items_time_range_check CHECK(end_at>start_at),
 CONSTRAINT appointment_items_shop_location_id_key UNIQUE(shop_id,location_id,id),
 CONSTRAINT appointment_items_parent_fkey FOREIGN KEY(shop_id,location_id,appointment_id)
   REFERENCES appointments(shop_id,location_id,id) ON DELETE RESTRICT
);
CREATE TABLE appointment_item_staff_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,
 appointment_item_id uuid NOT NULL,staff_id uuid NOT NULL,role text NOT NULL,
 start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT appointment_item_staff_role_check CHECK(role IN ('primary','assistant')),
 CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at>start_at),
 CONSTRAINT appointment_item_staff_assignment_staff_key UNIQUE(shop_id,location_id,appointment_item_id,staff_id),
 CONSTRAINT appointment_item_staff_item_fkey FOREIGN KEY(shop_id,location_id,appointment_item_id)
   REFERENCES appointment_items(shop_id,location_id,id) ON DELETE RESTRICT,
 CONSTRAINT appointment_item_staff_staff_fkey FOREIGN KEY(shop_id,staff_id)
   REFERENCES staff(shop_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx
 ON appointment_item_staff_assignments(shop_id,location_id,appointment_item_id) WHERE role='primary';
CREATE INDEX appointment_item_staff_schedule_idx
 ON appointment_item_staff_assignments(shop_id,location_id,staff_id,start_at,end_at);
`;

const ids = {
  shop: '11111111-1111-4111-8111-111111111111',
  shop2: '11111111-1111-4111-8111-222222222222',
  location: '22222222-2222-4222-8222-111111111111',
  location2: '22222222-2222-4222-8222-222222222222',
  staffA: '33333333-3333-4333-8333-111111111111',
  staffB: '33333333-3333-4333-8333-222222222222',
  staffC: '33333333-3333-4333-8333-333333333333',
  staffOther: '33333333-3333-4333-8333-444444444444'
};

async function insertScope(client) {
  await client.query(`INSERT INTO shops VALUES($1),($2)`, [ids.shop, ids.shop2]);
  await client.query(`INSERT INTO locations VALUES($1,$2),($3,$4)`, [ids.location, ids.shop, ids.location2, ids.shop2]);
  await client.query(`INSERT INTO staff VALUES($1,$4),($2,$4),($3,$4),($5,$6)`, [ids.staffA, ids.staffB, ids.staffC, ids.shop, ids.staffOther, ids.shop2]);
}

async function createAllocation(client, {
  assignedStaff, role = 'primary', parentStaff = assignedStaff,
  start = '2030-01-07T10:00:00Z', end = '2030-01-07T11:00:00Z',
  status = 'pending', override = false, twoItems = false,
  withinTransaction = false
}) {
  if (!withinTransaction) await client.query('BEGIN');
  try {
  const parent = (await client.query(
    `INSERT INTO appointments(shop_id,location_id,staff_id,start_at,end_at,status,override_conflict)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ids.shop, ids.location, parentStaff, start, end, status, override]
  )).rows[0].id;
  if (twoItems) {
    const dummyEnd = new Date(new Date(start).getTime() + 15 * 60000).toISOString();
    const dummy = (await client.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,start_at,end_at) VALUES($1,$2,$3,$4,$5) RETURNING id`, [ids.shop, ids.location, parent, start, dummyEnd])).rows[0].id;
    await client.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'primary',$5,$6)`, [ids.shop, ids.location, dummy, parentStaff, start, dummyEnd]);
  }
  const itemStart = twoItems ? new Date(new Date(start).getTime() + 15 * 60000).toISOString() : start;
  const item = (await client.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,start_at,end_at) VALUES($1,$2,$3,$4,$5) RETURNING id`, [ids.shop, ids.location, parent, itemStart, end])).rows[0].id;
  if (role === 'assistant') {
    await client.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'primary',$5,$6)`, [ids.shop, ids.location, item, parentStaff, itemStart, end]);
  }
  const assignment = (await client.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at,blocks_time) VALUES($1,$2,$3,$4,$5,'2000-01-01','2000-01-02',FALSE) RETURNING id,start_at,end_at,blocks_time`, [ids.shop, ids.location, item, assignedStaff, role])).rows[0];
  if (!withinTransaction) await client.query('COMMIT');
  return { parent, item, assignment };
  } catch (error) {
    if (!withinTransaction) await client.query('ROLLBACK');
    throw error;
  }
}

test('assignment collision migrations on real PostgreSQL 17', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 binaries unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-assignment-pg-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 55432 + Math.floor(Math.random() * 500);
  const pg = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-k', socket, '-p', String(port)], { stdio: ['ignore', 'ignore', 'ignore'] });
  const config = { host: socket, port, database: 'postgres', user: os.userInfo().username };
  let admin;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { admin = new Client(config); await admin.connect(); break; } catch { if (admin) await admin.end().catch(() => {}); await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(admin, 'temporary PostgreSQL did not start');
    await admin.query(BASE_SCHEMA);
    await insertScope(admin);
    await admin.query(sql(migrations[0]));
    await admin.query(sql(migrations[1]));
    await admin.query(sql(migrations[2]));
    await admin.query(sql(migrations[3]));
    await admin.query(sql(migrations[4]));

    await t.test('projection cannot be forged and validates tenant', async () => {
      const row = await createAllocation(admin, { assignedStaff: ids.staffA });
      assert.equal(row.assignment.blocks_time, true);
      assert.equal(new Date(row.assignment.start_at).toISOString(), '2030-01-07T10:00:00.000Z');
      await assert.rejects(createAllocation(admin, { assignedStaff: ids.staffOther, parentStaff: ids.staffB }), e => e.code === '23514');
    });

    for (const [leftRole, rightRole] of [['primary','primary'],['primary','assistant'],['assistant','primary'],['assistant','assistant']]) {
      await t.test(`${leftRole} versus ${rightRole} overlap returns 23P01`, async () => {
        await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
        await createAllocation(admin, { assignedStaff: ids.staffC, role: leftRole, parentStaff: ids.staffA, twoItems: leftRole === 'primary' });
        await assert.rejects(createAllocation(admin, { assignedStaff: ids.staffC, role: rightRole, parentStaff: ids.staffB, twoItems: rightRole === 'primary' }), e => e.code === '23P01');
      });
    }

    await t.test('different staff and adjacent slots are allowed', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await createAllocation(admin, { assignedStaff: ids.staffA });
      await createAllocation(admin, { assignedStaff: ids.staffB });
      await createAllocation(admin, { assignedStaff: ids.staffA, start: '2030-01-07T11:00:00Z', end: '2030-01-07T12:00:00Z' });
    });

    for (const [status, blocks] of [['pending',true],['confirmed',true],['completed',false],['cancelled',false],['no_show',false]]) {
      await t.test(`${status} projects blocks_time=${blocks}`, async () => {
        await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
        const row = await createAllocation(admin, { assignedStaff: ids.staffA, status });
        assert.equal(row.assignment.blocks_time, blocks);
      });
    }

    await t.test('override_conflict is nonblocking and status/override triggers sync', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const row = await createAllocation(admin, { assignedStaff: ids.staffA, override: true });
      assert.equal(row.assignment.blocks_time, false);
      await admin.query('UPDATE appointments SET override_conflict=false WHERE id=$1', [row.parent]);
      assert.equal((await admin.query('SELECT blocks_time FROM appointment_item_staff_assignments WHERE id=$1', [row.assignment.id])).rows[0].blocks_time, true);
    });

    await t.test('item time sync and deferred parent consistency', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const row = await createAllocation(admin, { assignedStaff: ids.staffA });
      await admin.query('BEGIN');
      await admin.query(`UPDATE appointments SET end_at='2030-01-07T11:30:00Z' WHERE id=$1`, [row.parent]);
      await admin.query(`UPDATE appointment_items SET end_at='2030-01-07T11:30:00Z' WHERE id=$1`, [row.item]);
      await admin.query('COMMIT');
      assert.equal(new Date((await admin.query('SELECT end_at FROM appointment_item_staff_assignments WHERE id=$1', [row.assignment.id])).rows[0].end_at).toISOString(), '2030-01-07T11:30:00.000Z');
    });

    await t.test('direct assignment time and blocks_time forgery is overwritten', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const row = await createAllocation(admin, { assignedStaff: ids.staffA });
      const projected = (await admin.query(`UPDATE appointment_item_staff_assignments SET start_at='2040-01-01',end_at='2040-01-02',blocks_time=false WHERE id=$1 RETURNING start_at,end_at,blocks_time`, [row.assignment.id])).rows[0];
      assert.equal(new Date(projected.start_at).toISOString(), '2030-01-07T10:00:00.000Z');
      assert.equal(projected.blocks_time, true);
    });

    await t.test('completed parent status synchronizes blocks_time false', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const row = await createAllocation(admin, { assignedStaff: ids.staffA });
      await admin.query(`UPDATE appointments SET status='completed' WHERE id=$1`, [row.parent]);
      assert.equal((await admin.query('SELECT blocks_time FROM appointment_item_staff_assignments WHERE id=$1', [row.assignment.id])).rows[0].blocks_time, false);
    });

    await t.test('override change synchronizes blocks_time false', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const row = await createAllocation(admin, { assignedStaff: ids.staffA });
      await admin.query('UPDATE appointments SET override_conflict=true WHERE id=$1', [row.parent]);
      assert.equal((await admin.query('SELECT blocks_time FROM appointment_item_staff_assignments WHERE id=$1', [row.assignment.id])).rows[0].blocks_time, false);
    });

    await t.test('invalid item time is rejected', async () => {
      await assert.rejects(admin.query(`INSERT INTO appointments(shop_id,location_id,staff_id,start_at,end_at,status,override_conflict) VALUES($1,$2,$3,'2031-01-01 10:00Z','2031-01-01 11:00Z','completed',false) RETURNING id`, [ids.shop, ids.location, ids.staffA]).then(async result => admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,start_at,end_at) VALUES($1,$2,$3,'2031-01-01 11:00Z','2031-01-01 10:00Z')`, [ids.shop, ids.location, result.rows[0].id])), e => e.code === '23514');
    });

    await t.test('assignment role cannot bypass collision', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffA, role: 'assistant' });
      await assert.rejects(createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffB, role: 'assistant' }), e => e.code === '23P01');
    });

    await t.test('cross-location overlap is still blocked', async () => {
      const definition = (await admin.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='prevent_assignment_staff_double_booking'`)).rows[0].definition;
      assert.doesNotMatch(definition, /location_id WITH/);
      assert.match(definition, /shop_id WITH =/);
    });

    await t.test('constraint uses half-open tstzrange', async () => {
      const definition = (await admin.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='prevent_assignment_staff_double_booking'`)).rows[0].definition;
      assert.match(definition, /tstzrange\(start_at, end_at, '\[\)'/);
    });

    await t.test('nonblocking to blocking collision rolls back', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffA, role: 'assistant' });
      const other = await createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffB, role: 'assistant', status: 'completed' });
      await assert.rejects(admin.query(`UPDATE appointments SET status='confirmed' WHERE id=$1`, [other.parent]), e => e.code === '23P01');
      assert.equal((await admin.query('SELECT status FROM appointments WHERE id=$1', [other.parent])).rows[0].status, 'completed');
    });

    await t.test('moving an item into assignment collision rolls back', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffA, role: 'assistant' });
      const moving = await createAllocation(admin, { assignedStaff: ids.staffC, parentStaff: ids.staffB, role: 'assistant', start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z' });
      await admin.query('BEGIN');
      await admin.query(`UPDATE appointments SET start_at='2030-01-07T10:30:00Z',end_at='2030-01-07T11:30:00Z' WHERE id=$1`, [moving.parent]);
      await assert.rejects(admin.query(`UPDATE appointment_items SET start_at='2030-01-07T10:30:00Z',end_at='2030-01-07T11:30:00Z' WHERE appointment_id=$1`, [moving.parent]), e => e.code === '23P01');
      await admin.query('ROLLBACK');
      assert.equal(new Date((await admin.query('SELECT start_at FROM appointment_item_staff_assignments WHERE id=$1', [moving.assignment.id])).rows[0].start_at).toISOString(), '2030-01-07T12:00:00.000Z');
    });

    await t.test('concurrent assignment inserts allow one winner', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      const a = new Client(config), b = new Client(config); await a.connect(); await b.connect();
      try {
        await a.query('BEGIN'); await b.query('BEGIN');
        const first = await createAllocation(a, { assignedStaff: ids.staffC, parentStaff: ids.staffA, role: 'assistant', withinTransaction: true });
        const pendingSecond = createAllocation(b, { assignedStaff: ids.staffC, parentStaff: ids.staffB, role: 'assistant', withinTransaction: true });
        await a.query('COMMIT');
        await assert.rejects(pendingSecond, e => e.code === '23P01');
        await b.query('ROLLBACK');
        assert.equal((await admin.query('SELECT count(*)::int n FROM appointment_item_staff_assignments WHERE staff_id=$1 AND blocks_time', [ids.staffC])).rows[0].n, 1);
        assert.ok(first.assignment.id);
      } finally { await a.end(); await b.end(); }
    });

    await t.test('single-service parent primary mismatch fails closed', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await assert.rejects(createAllocation(admin, { assignedStaff: ids.staffA, parentStaff: ids.staffB }), e => e.code === '23514');
    });

    await t.test('single-service item without primary fails closed at commit', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await admin.query('BEGIN');
      const parent = (await admin.query(`INSERT INTO appointments(shop_id,location_id,staff_id,start_at,end_at,status,override_conflict) VALUES($1,$2,$3,'2032-01-01 10:00Z','2032-01-01 11:00Z','pending',false) RETURNING id`, [ids.shop, ids.location, ids.staffA])).rows[0].id;
      await admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,start_at,end_at) VALUES($1,$2,$3,'2032-01-01 10:00Z','2032-01-01 11:00Z')`, [ids.shop, ids.location, parent]);
      await assert.rejects(admin.query('COMMIT'), e => e.code === '23514');
      await admin.query('ROLLBACK');
    });

    await t.test('verification fails closed on function drift', async () => {
      const original = (await admin.query(`SELECT pg_get_functiondef('public.assignment_collision_sync_item_time()'::regprocedure) definition`)).rows[0].definition;
      await admin.query(`CREATE OR REPLACE FUNCTION public.assignment_collision_sync_item_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await assert.rejects(admin.query(sql(migrations[4])));
      await admin.query('ROLLBACK');
      await admin.query(original);
      await admin.query(sql(migrations[4]));
    });

    await t.test('projection migration fails closed on partial trigger set', async () => {
      await admin.query('DROP TRIGGER assignment_collision_parent_consistency_trigger ON appointments');
      await assert.rejects(admin.query(sql(migrations[1])), /Partial assignment collision trigger set/);
      await admin.query('ROLLBACK');
      await admin.query(`CREATE CONSTRAINT TRIGGER assignment_collision_parent_consistency_trigger AFTER UPDATE OF start_at,end_at,staff_id ON public.appointments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assignment_collision_consistency_check()`);
    });

    await t.test('projection migration fails closed on existing function and trigger drift', async () => {
      const originalFunction = (await admin.query(`SELECT pg_get_functiondef('public.assignment_collision_project()'::regprocedure) definition`)).rows[0].definition;
      await admin.query(`CREATE OR REPLACE FUNCTION public.assignment_collision_project() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await assert.rejects(admin.query(sql(migrations[1])), /function drift/);
      await admin.query('ROLLBACK');
      await admin.query(originalFunction);

      await admin.query('ALTER TABLE appointment_item_staff_assignments DISABLE TRIGGER assignment_collision_project_trigger');
      await assert.rejects(admin.query(sql(migrations[1])), /trigger drift/);
      await admin.query('ROLLBACK');
      await admin.query('ALTER TABLE appointment_item_staff_assignments ENABLE TRIGGER assignment_collision_project_trigger');
    });

    await t.test('backfill fails closed on projection function drift', async () => {
      const original = (await admin.query(`SELECT pg_get_functiondef('public.assignment_collision_sync_parent_state()'::regprocedure) definition`)).rows[0].definition;
      await admin.query(`CREATE OR REPLACE FUNCTION public.assignment_collision_sync_parent_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await assert.rejects(admin.query(sql(migrations[2])), /projection dependency drift/);
      await admin.query('ROLLBACK');
      await admin.query(original);
    });

    await t.test('constraint and verification fail closed on time CHECK drift', async () => {
      await admin.query('ALTER TABLE appointment_item_staff_assignments DROP CONSTRAINT appointment_item_staff_time_range_check');
      await admin.query('ALTER TABLE appointment_item_staff_assignments ADD CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at>=start_at)');
      await assert.rejects(admin.query(sql(migrations[3])), /time range CHECK drift/);
      await admin.query('ROLLBACK');
      await assert.rejects(admin.query(sql(migrations[4])), /time range CHECK missing or drifted/);
      await admin.query('ROLLBACK');
      await admin.query('ALTER TABLE appointment_item_staff_assignments DROP CONSTRAINT appointment_item_staff_time_range_check');
      await admin.query('ALTER TABLE appointment_item_staff_assignments ADD CONSTRAINT appointment_item_staff_time_range_check CHECK(end_at>start_at)');
    });

    await t.test('migration reruns and final verification are idempotent', async () => {
      await admin.query(sql(migrations[1]));
      await admin.query(sql(migrations[2]));
      await admin.query(sql(migrations[3]));
      await admin.query(sql(migrations[4]));
    });

    await t.test('022 to 024 transfers final authority to assignments', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await admin.query('SET session_replication_role=replica');
      const badParent = (await admin.query(`INSERT INTO appointments(shop_id,location_id,staff_id,start_at,end_at,status,override_conflict) VALUES($1,$2,$3,'2034-01-01 10:00Z','2034-01-01 11:00Z','pending',false) RETURNING id`, [ids.shop,ids.location,ids.staffA])).rows[0].id;
      const badItem = (await admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,sequence_no,start_at,end_at,status) VALUES($1,$2,$3,1,'2034-01-01 10:00Z','2034-01-01 11:00Z','pending') RETURNING id`, [ids.shop,ids.location,badParent])).rows[0].id;
      await admin.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at,blocks_time) VALUES($1,$2,$3,$4,'primary','2034-01-01 10:00Z','2034-01-01 11:00Z',true)`, [ids.shop,ids.location,badItem,ids.staffB]);
      await admin.query('SET session_replication_role=origin');
      await assert.rejects(admin.query(sql(parentCompatibilityMigrations[0])), /Single-item parent primary compatibility mismatch/);
      await admin.query('ROLLBACK');
      assert.equal((await admin.query(`SELECT 1 FROM pg_constraint WHERE conname='prevent_staff_double_booking'`)).rows.length,1);
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await createAllocation(admin, { assignedStaff: ids.staffA });
      await admin.query(sql(parentCompatibilityMigrations[0]));
      await admin.query(sql(parentCompatibilityMigrations[1]));
      await admin.query(sql(parentCompatibilityMigrations[2]));
      const parentConstraint = await admin.query(`SELECT 1 FROM pg_constraint WHERE conname='prevent_staff_double_booking'`);
      const assignmentConstraint = await admin.query(`SELECT 1 FROM pg_constraint WHERE conname='prevent_assignment_staff_double_booking'`);
      assert.equal(parentConstraint.rows.length, 0);
      assert.equal(assignmentConstraint.rows.length, 1);
    });

    await t.test('real Phase A validates canonical single, multi, assistant and invalid fixtures', async () => {
      const service = '55555555-5555-4555-8555-555555555555';
      const insertParent = async (start, end, staff = ids.staffA) => (await admin.query(
        `INSERT INTO appointments(shop_id,location_id,service_id,staff_id,start_at,end_at,status,override_conflict)
         VALUES($1,$2,$3,$4,$5,$6,'pending',false) RETURNING *`,
        [ids.shop, ids.location, service, staff, start, end]
      )).rows[0];
      const insertItem = async (parent, sequence, start, end) => (await admin.query(
        `INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,start_at,end_at,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
        [ids.shop, ids.location, parent.id, service, sequence, start, end]
      )).rows[0];
      const assign = (item, staff, role = 'primary', start = item.start_at, end = item.end_at) => admin.query(
        `INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at,blocks_time)
         VALUES($1,$2,$3,$4,$5,$6,$7,true)`,
        [ids.shop, ids.location, item.id, staff, role, start, end]
      );
      const reset = () => admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');

      await reset(); await admin.query('BEGIN');
      let parent = await insertParent('2035-01-01T10:00Z','2035-01-01T11:00Z');
      let item = await insertItem(parent,1,parent.start_at,parent.end_at); await assign(item,ids.staffA);
      assert.equal((await loadAndValidatePhaseAStructure(admin,parent)).itemCount,1);
      await admin.query('COMMIT');

      await reset(); await admin.query('BEGIN');
      parent = await insertParent('2035-01-02T10:00Z','2035-01-02T12:00Z');
      const first = await insertItem(parent,1,'2035-01-02T10:00Z','2035-01-02T11:00Z');
      const second = await insertItem(parent,2,'2035-01-02T11:00Z','2035-01-02T12:00Z');
      await assign(first,ids.staffA); await assign(second,ids.staffB);
      let phase = await loadAndValidatePhaseAStructure(admin,parent);
      assert.equal(phase.primaryStaffCount,2);
      await admin.query('COMMIT');

      await reset(); await admin.query('BEGIN');
      parent = await insertParent('2035-01-03T10:00Z','2035-01-03T12:00Z');
      const adjacentA = await insertItem(parent,1,'2035-01-03T10:00Z','2035-01-03T11:00Z');
      const adjacentB = await insertItem(parent,2,'2035-01-03T11:00Z','2035-01-03T12:00Z');
      await assign(adjacentA,ids.staffA); await assign(adjacentB,ids.staffA);
      phase = await loadAndValidatePhaseAStructure(admin,parent);
      assert.equal(phase.primaryStaffCount,1);
      await admin.query('COMMIT');

      await reset(); await admin.query('BEGIN');
      parent = await insertParent('2035-01-04T10:00Z','2035-01-04T11:00Z');
      item = await insertItem(parent,1,parent.start_at,parent.end_at);
      await assign(item,ids.staffA); await assign(item,ids.staffB,'assistant');
      assert.equal((await loadAndValidatePhaseAStructure(admin,parent)).assignmentCount,2);
      await admin.query('COMMIT');

      await reset(); await admin.query('BEGIN');
      parent = await insertParent('2035-01-05T10:00Z','2035-01-05T11:00Z');
      await insertItem(parent,1,parent.start_at,parent.end_at);
      await assert.rejects(loadAndValidatePhaseAStructure(admin,parent), e => e instanceof AppointmentMutationError);
      await assert.rejects(admin.query('COMMIT'), e => e.code==='23514');
      await admin.query('ROLLBACK');

      await reset(); await admin.query('DROP INDEX appointment_item_staff_primary_uidx'); await admin.query('BEGIN');
      parent = await insertParent('2035-01-06T10:00Z','2035-01-06T11:00Z');
      item = await insertItem(parent,1,parent.start_at,parent.end_at);
      await assign(item,ids.staffA); await assign(item,ids.staffB);
      await assert.rejects(loadAndValidatePhaseAStructure(admin,parent), e => e instanceof AppointmentMutationError);
      await admin.query('ROLLBACK');
      await admin.query(`CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id,location_id,appointment_item_id) WHERE role='primary'`);

      await reset(); await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role=replica');
      parent = await insertParent('2035-01-07T10:00Z','2035-01-07T11:00Z');
      item = await insertItem(parent,1,parent.start_at,parent.end_at);
      await assign(item,ids.staffA,'primary','2035-01-07T10:15Z','2035-01-07T11:00Z');
      await admin.query('SET LOCAL session_replication_role=origin');
      await admin.query(`UPDATE appointments SET start_at=start_at WHERE id=$1`,[parent.id]);
      await assert.rejects(loadAndValidatePhaseAStructure(admin,parent), e => e instanceof AppointmentMutationError);
      await assert.rejects(admin.query('COMMIT'), e => e.code==='23514');
      await admin.query('ROLLBACK');

      await reset(); await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role=replica');
      parent = await insertParent('2035-01-08T10:00Z','2035-01-08T12:00Z');
      item = await insertItem(parent,1,'2035-01-08T10:00Z','2035-01-08T11:00Z'); await assign(item,ids.staffA);
      await admin.query('SET LOCAL session_replication_role=origin');
      await admin.query(`UPDATE appointments SET start_at=start_at WHERE id=$1`,[parent.id]);
      await assert.rejects(loadAndValidatePhaseAStructure(admin,parent), e => e instanceof AppointmentMutationError);
      await assert.rejects(admin.query('COMMIT'), e => e.code==='23514');
      await admin.query('ROLLBACK');

      await reset(); await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role=replica');
      parent = await insertParent('2035-01-09T10:00Z','2035-01-09T11:00Z');
      item = await insertItem(parent,1,parent.start_at,parent.end_at);
      await admin.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at,blocks_time) VALUES($1,$2,$3,$4,'primary',$5,$6,true)`, [ids.shop2,ids.location,item.id,ids.staffOther,item.start_at,item.end_at]);
      await admin.query('SET LOCAL session_replication_role=origin');
      await assert.rejects(loadAndValidatePhaseAStructure(admin,parent), e => e instanceof AppointmentMutationError);
      await admin.query('ROLLBACK');
    });

    await t.test('024 rejects an invalid canonical sequence fixture', async () => {
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
      await admin.query('SET session_replication_role=replica');
      const parent=(await admin.query(`INSERT INTO appointments(shop_id,location_id,service_id,staff_id,start_at,end_at,status,override_conflict) VALUES($1,$2,$3,$4,'2037-01-01 10:00Z','2037-01-01 12:00Z','pending',false) RETURNING id`,[ids.shop,ids.location,'55555555-5555-4555-8555-555555555555',ids.staffA])).rows[0].id;
      const first=(await admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,start_at,end_at,status) VALUES($1,$2,$3,$4,1,'2037-01-01 10:00Z','2037-01-01 11:00Z','pending') RETURNING id`,[ids.shop,ids.location,parent,'55555555-5555-4555-8555-555555555555'])).rows[0].id;
      const second=(await admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,start_at,end_at,status) VALUES($1,$2,$3,$4,1,'2037-01-01 11:00Z','2037-01-01 12:00Z','pending') RETURNING id`,[ids.shop,ids.location,parent,'55555555-5555-4555-8555-555555555555'])).rows[0].id;
      await admin.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at,blocks_time) VALUES($1,$2,$3,$4,'primary','2037-01-01 10:00Z','2037-01-01 11:00Z',true),($1,$2,$5,$4,'primary','2037-01-01 11:00Z','2037-01-01 12:00Z',true)`,[ids.shop,ids.location,first,ids.staffA,second]);
      await admin.query('SET session_replication_role=origin');
      await assert.rejects(admin.query(sql(parentCompatibilityMigrations[2])), /sequence invariant mismatch/);
      await admin.query('ROLLBACK');
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
    });

    await t.test('024 accepts legal item gaps and rejects parent span mismatch', async () => {
      const service='55555555-5555-4555-8555-555555555555';
      await admin.query('BEGIN');
      const parent=(await admin.query(`INSERT INTO appointments(shop_id,location_id,service_id,staff_id,start_at,end_at,status,override_conflict) VALUES($1,$2,$3,$4,'2037-02-01 10:00Z','2037-02-01 12:30Z','pending',false) RETURNING id`,[ids.shop,ids.location,service,ids.staffA])).rows[0].id;
      for(const [sequence,start,end,staff] of [[1,'2037-02-01 10:00Z','2037-02-01 11:00Z',ids.staffA],[2,'2037-02-01 11:30Z','2037-02-01 12:30Z',ids.staffB]]){
        const item=(await admin.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,start_at,end_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,[ids.shop,ids.location,parent,service,sequence,start,end])).rows[0].id;
        await admin.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'primary',$5,$6)`,[ids.shop,ids.location,item,staff,start,end]);
      }
      await admin.query('COMMIT');
      await admin.query(sql(parentCompatibilityMigrations[2]));
      await admin.query('SET session_replication_role=replica');
      await admin.query(`UPDATE appointments SET end_at='2037-02-01 12:00Z' WHERE id=$1`,[parent]);
      await admin.query('SET session_replication_role=origin');
      await assert.rejects(admin.query(sql(parentCompatibilityMigrations[2])), /Parent span mismatch/);
      await admin.query('ROLLBACK');
      await admin.query('TRUNCATE appointment_item_staff_assignments,appointment_items,appointments');
    });
  } finally {
    if (admin) await admin.end().catch(() => {});
    pg.kill('SIGTERM');
    await new Promise(resolve => pg.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('assignment collision migration files are staged and safe', () => {
  const [preflight, projection, backfill, constraint, verification] = migrations.map(sql);
  assert.match(preflight, /BEGIN TRANSACTION READ ONLY/i);
  assert.doesNotMatch(
    preflight.replace(/--.*$/gm, ''),
    /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/im
  );
  for (const body of [projection, backfill, constraint]) {
    assert.match(body, /SET LOCAL lock_timeout='5s'/i);
    assert.match(body, /SET LOCAL statement_timeout='30s'/i);
  }
  assert.match(projection, /BEFORE INSERT OR UPDATE/);
  assert.match(projection, /AFTER UPDATE OF start_at,end_at/);
  assert.match(projection, /AFTER UPDATE OF status,override_conflict/);
  assert.match(backfill, /GET DIAGNOSTICS affected=ROW_COUNT/);
  assert.match(constraint, /EXCLUDE USING gist/);
  assert.match(constraint, /ADD CONSTRAINT appointment_item_staff_time_range_check CHECK \(end_at > start_at\)/);
  assert.match(constraint, /tstzrange\(start_at,end_at,'\[\)'\) WITH &&/);
  assert.match(verification, /BEGIN TRANSACTION READ ONLY/i);
  assert.match(verification, /Blocking assignment overlap detected/);
});

test('shared validator uses canonical primary and assistant assignments', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/staff-bookability-validator.js'), 'utf8');
  assert.match(source, /appointment_item_staff_assignments AS assignment/);
  assert.match(source, /assignment\.role IN \('primary', 'assistant'\)/);
  assert.match(source, /assignment\.blocks_time = TRUE/);
  assert.doesNotMatch(source.match(/collision_state AS \([\s\S]*?\n  \)/)[0], /appointments AS appointment/);
});
