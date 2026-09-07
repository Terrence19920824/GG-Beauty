'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migrations = [13, 14, 15, 16, 17].map(number => {
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
 staff_id uuid NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending',override_conflict boolean NOT NULL DEFAULT false,
 CONSTRAINT appointments_check CHECK(end_at>start_at),
 CONSTRAINT appointments_shop_location_id_uidx UNIQUE(shop_id,location_id,id),
 CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist
   (staff_id WITH =,tstzrange(start_at,end_at,'[)') WITH &&)
   WHERE(status IN ('pending','confirmed') AND override_conflict=false)
);
CREATE TABLE appointment_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,
 appointment_id uuid NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
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

    await t.test('migration reruns and final verification are idempotent', async () => {
      await admin.query(sql(migrations[1]));
      await admin.query(sql(migrations[2]));
      await admin.query(sql(migrations[3]));
      await admin.query(sql(migrations[4]));
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
  assert.match(constraint, /tstzrange\(start_at,end_at,'\[\)'\) WITH &&/);
  assert.match(verification, /BEGIN TRANSACTION READ ONLY/i);
});

test('shared validator uses canonical primary and assistant assignments', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/staff-bookability-validator.js'), 'utf8');
  assert.match(source, /appointment_item_staff_assignments AS assignment/);
  assert.match(source, /assignment\.role IN \('primary', 'assistant'\)/);
  assert.match(source, /assignment\.blocks_time = TRUE/);
  assert.doesNotMatch(source.match(/collision_state AS \([\s\S]*?\n  \)/)[0], /appointments AS appointment/);
});
