'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { createOwnerAppointmentServiceAddon } = require('../lib/owner-appointment-service-addon');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');
const uuid = () => crypto.randomUUID();
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class BookabilityError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function connectWhenReady(config, postgres, stderr) {
  let last;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (postgres.exitCode !== null || postgres.signalCode !== null) throw new Error(`PostgreSQL exited: ${stderr()}`);
    const client = new Client(config);
    try { await client.connect(); return client; } catch (error) { last = error; await client.end().catch(() => {}); await wait(100); }
  }
  throw last;
}

const BASE_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE owner_shop_memberships (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, role text NOT NULL
);
CREATE TABLE appointments (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL,
  appointment_id uuid NOT NULL, service_id uuid NOT NULL, sequence_no integer NOT NULL,
  service_name_snapshot text NOT NULL, service_locale_snapshot text NOT NULL,
  duration_minutes_snapshot integer NOT NULL, price_snapshot numeric NOT NULL,
  snapshot_source text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_items_shop_location_id_key UNIQUE (shop_id, location_id, id),
  UNIQUE (shop_id, appointment_id, sequence_no)
);
CREATE TABLE appointment_item_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, location_id uuid NOT NULL,
  appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL, role text NOT NULL,
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  UNIQUE (appointment_item_id, role)
);
CREATE TABLE staff (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, name text NOT NULL,
  is_active boolean NOT NULL, bookable boolean NOT NULL
);
CREATE TABLE staff_location_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL,
  location_id uuid NOT NULL, is_active boolean NOT NULL,
  CONSTRAINT staff_location_assignments_scope_key UNIQUE (shop_id, staff_id, location_id)
);
CREATE TABLE staff_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, staff_id uuid NOT NULL,
  service_id uuid NOT NULL, is_active boolean NOT NULL,
  UNIQUE (shop_id, staff_id, service_id)
);
CREATE TABLE service_categories (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, is_active boolean NOT NULL,
  UNIQUE (shop_id, id)
);
CREATE TABLE services (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, category_id uuid NOT NULL, name text NOT NULL,
  duration_minutes integer NOT NULL, price numeric NOT NULL,
  is_active boolean NOT NULL, bookable boolean NOT NULL
);
CREATE TABLE service_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL, service_id uuid NOT NULL,
  locale text NOT NULL, name text NOT NULL, UNIQUE (shop_id, service_id, locale)
);
CREATE TABLE checkout_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL,
  appointment_id uuid NOT NULL, status text NOT NULL
);
`;

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('Active Service Add-on V1 migrations, authority, audit and PostgreSQL concurrency', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-addon-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const port = 58800 + Math.floor(Math.random() * 100);
  let stderr = '';
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-k', socket, '-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  postgres.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  const config = { host: socket, port, database: 'postgres', user: os.userInfo().username, ssl: false };
  let db;
  let pool;
  try {
    db = await connectWhenReady(config, postgres, () => stderr);
    await db.query(BASE_SCHEMA);

    await t.test('087 preflight, 088 forward, 089 verify, and empty rollback', async () => {
      await db.query(migration('087_appointment_item_mutation_commands_preflight_readonly.sql'));
      await db.query(migration('088_appointment_item_mutation_commands_schema.sql'));
      await db.query(migration('089_appointment_item_mutation_commands_verification_readonly.sql'));
      const supporting = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('owner_shop_memberships_shop_id_id_key','appointment_items_id_appointment_id_key') ORDER BY indexname`);
      assert.equal(supporting.rows.length, 2);
      await db.query(migration('rollback/088_appointment_item_mutation_commands_rollback.sql'));
      assert.equal((await db.query(`SELECT to_regclass('public.appointment_item_mutation_commands') AS relation`)).rows[0].relation, null);
      await db.query(migration('087_appointment_item_mutation_commands_preflight_readonly.sql'));
      await db.query(migration('088_appointment_item_mutation_commands_schema.sql'));
      await db.query(migration('089_appointment_item_mutation_commands_verification_readonly.sql'));
    });

    pool = new Pool(config);
    const ids = {
      shopA: uuid(), shopB: uuid(), locationA: uuid(), locationB: uuid(),
      staffA: uuid(), staffB: uuid(), staffIncapable: uuid(), staffOther: uuid(),
      categoryA: uuid(), categoryB: uuid(), serviceA: uuid(), serviceB: uuid(),
      serviceInactive: uuid(), serviceOther: uuid()
    };
    ids.members = Object.fromEntries(['owner', 'manager', 'admin', 'front_desk', 'staff'].map(role => [role, uuid()]));
    const memberValues = Object.entries(ids.members).map(([role, id]) => `('${id}','${ids.shopA}','${role}')`).join(',');
    await db.query(`INSERT INTO owner_shop_memberships(id,shop_id,role) VALUES ${memberValues},('${uuid()}','${ids.shopB}','owner')`);
    await db.query(`INSERT INTO staff(id,shop_id,name,is_active,bookable) VALUES
      ($1,$5,'Staff A',true,true),($2,$5,'Staff B',true,true),($3,$5,'No Skill',true,true),($4,$6,'Other Shop',true,true)`,
      [ids.staffA, ids.staffB, ids.staffIncapable, ids.staffOther, ids.shopA, ids.shopB]);
    await db.query(`INSERT INTO staff_location_assignments(shop_id,staff_id,location_id,is_active) VALUES
      ($1,$2,$6,true),($1,$3,$6,true),($1,$4,$6,true),($5,$7,$8,true)`,
      [ids.shopA, ids.staffA, ids.staffB, ids.staffIncapable, ids.shopB, ids.locationA, ids.staffOther, ids.locationB]);
    await db.query(`INSERT INTO service_categories(id,shop_id,is_active) VALUES ($1,$3,true),($2,$4,true)`,
      [ids.categoryA, ids.categoryB, ids.shopA, ids.shopB]);
    await db.query(`INSERT INTO services(id,shop_id,category_id,name,duration_minutes,price,is_active,bookable) VALUES
      ($1,$5,$6,'Colour',30,180.50,true,true),
      ($2,$5,$6,'Treatment',45,80.00,true,true),
      ($3,$5,$6,'Inactive',25,40.00,false,true),
      ($4,$7,$8,'Other',20,30.00,true,true)`,
      [ids.serviceA, ids.serviceB, ids.serviceInactive, ids.serviceOther, ids.shopA, ids.categoryA, ids.shopB, ids.categoryB]);
    await db.query(`INSERT INTO service_translations(shop_id,service_id,locale,name) VALUES
      ($1,$2,'zh-CN','染发'),($1,$2,'en','Colour'),($1,$3,'zh-CN','护理'),($1,$3,'en','Treatment'),
      ($1,$4,'zh-CN','停用'),($5,$6,'zh-CN','其他')`,
      [ids.shopA, ids.serviceA, ids.serviceB, ids.serviceInactive, ids.shopB, ids.serviceOther]);
    await db.query(`INSERT INTO staff_services(shop_id,staff_id,service_id,is_active) VALUES
      ($1,$2,$4,true),($1,$2,$5,true),($1,$3,$4,true),($1,$3,$5,true),($1,$2,$6,true),($7,$8,$9,true)`,
      [ids.shopA, ids.staffA, ids.staffB, ids.serviceA, ids.serviceB, ids.serviceInactive, ids.shopB, ids.staffOther, ids.serviceOther]);

    const makeAddon = validator => createOwnerAppointmentServiceAddon({
      pool, crypto, isUuid,
      validator: validator || (async () => {}),
      StaffBookabilityError: BookabilityError,
      safeErrorCode: error => error?.code || 'error'
    });
    const invoke = async ({ appointmentId, serviceId = ids.serviceA, staffId = ids.staffA,
      key = `addon_${uuid().replace(/-/g, '')}`, role = 'owner', bodyExtra = {}, addon = makeAddon(),
      shopId = ids.shopA, membershipId = ids.members[role] }) => {
      const req = {
        params: { appointmentId },
        body: { serviceId, staffId, locale: 'en', idempotencyKey: key, ...bodyExtra },
        ownerAuth: { shopId, membershipId, role }
      };
      const res = responseRecorder();
      await addon.addService(req, res);
      return res;
    };
    const createAppointment = async (status = 'arrived', shopId = ids.shopA, locationId = ids.locationA, staffId = ids.staffA) => {
      const appointmentId = uuid();
      const start = '2031-04-05T01:00:00.000Z';
      const end = '2031-04-05T02:00:00.000Z';
      await db.query(`INSERT INTO appointments(id,shop_id,location_id,start_at,end_at,status) VALUES($1,$2,$3,$4,$5,$6)`, [appointmentId, shopId, locationId, start, end, status]);
      const item = await db.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,service_locale_snapshot,duration_minutes_snapshot,price_snapshot,snapshot_source,start_at,end_at,status)
        VALUES($1,$2,$3,$4,1,'Haircut','en',60,50,'booking',$5,$6,$7) RETURNING id`, [shopId, locationId, appointmentId, ids.serviceA, start, end, status]);
      await db.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'primary',$5,$6)`, [shopId, locationId, item.rows[0].id, staffId, start, end]);
      return appointmentId;
    };

    await t.test('rollback waits for an in-flight audit insert and refuses after it commits', async () => {
      const appointmentId = await createAppointment();
      const idempotencyKey = `rollback_${uuid().replace(/-/g, '')}`;
      const writer = await pool.connect();
      const rollbackClient = await pool.connect();
      try {
        await writer.query('BEGIN');
        const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const inserted = await writer.query(
          `INSERT INTO appointment_item_mutation_commands (
             shop_id,location_id,appointment_id,appointment_item_id,service_id,staff_id,
             mutation_type,operator_membership_id,operator_role_snapshot,idempotency_key,
             request_fingerprint,fingerprint_version,appointment_end_at_before,
             appointment_end_at_after,item_sequence_no,item_start_at,item_end_at,
             service_name_snapshot,duration_minutes_snapshot,price_snapshot,
             item_status_snapshot,staff_role_snapshot
           )
           SELECT item.shop_id,item.location_id,item.appointment_id,item.id,item.service_id,
                  assignment.staff_id,'service_item_added',$1,'owner',$2,$3,1,
                  item.start_at,item.end_at,item.sequence_no,item.start_at,item.end_at,
                  item.service_name_snapshot,item.duration_minutes_snapshot,
                  item.price_snapshot,item.status,assignment.role
             FROM appointment_items item
             JOIN appointment_item_staff_assignments assignment
               ON assignment.shop_id=item.shop_id
              AND assignment.location_id=item.location_id
              AND assignment.appointment_item_id=item.id
              AND assignment.role='primary'
            WHERE item.appointment_id=$4
           RETURNING id`,
          [ids.members.owner, idempotencyKey, 'a'.repeat(64), appointmentId]
        );
        assert.equal(inserted.rows.length, 1);

        const rollbackPid = Number((await rollbackClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        let rollbackError;
        const rollbackFinished = rollbackClient
          .query(migration('rollback/088_appointment_item_mutation_commands_rollback.sql'))
          .then(
            () => {},
            error => { rollbackError = error; }
          );

        let waitingOnProtectiveLock = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const activity = await db.query(
            `SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1`,
            [rollbackPid]
          );
          if (activity.rows[0]?.wait_event_type === 'Lock') {
            waitingOnProtectiveLock = true;
            break;
          }
          await wait(25);
        }
        assert.equal(waitingOnProtectiveLock, true);

        const relationLocks = await db.query(
          `SELECT pid,mode,granted
             FROM pg_locks
            WHERE relation='public.appointment_item_mutation_commands'::regclass
              AND pid=ANY($1::INTEGER[])`,
          [[writerPid, rollbackPid]]
        );
        assert.ok(relationLocks.rows.some(lock =>
          Number(lock.pid) === writerPid && lock.mode === 'RowExclusiveLock' && lock.granted === true
        ));
        assert.ok(relationLocks.rows.some(lock =>
          Number(lock.pid) === rollbackPid && lock.mode === 'AccessExclusiveLock' && lock.granted === false
        ));

        await writer.query('COMMIT');
        await rollbackFinished;
        assert.match(String(rollbackError?.message || ''), /rollback refused: audit rows exist/);
        await rollbackClient.query('ROLLBACK');

        assert.ok((await db.query(
          `SELECT to_regclass('public.appointment_item_mutation_commands') AS relation`
        )).rows[0].relation);
        assert.equal(Number((await db.query(
          `SELECT count(*) FROM appointment_item_mutation_commands WHERE id=$1`,
          [inserted.rows[0].id]
        )).rows[0].count), 1);
        const supporting = await db.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname='public'
              AND indexname IN (
                'owner_shop_memberships_shop_id_id_key',
                'appointment_items_id_appointment_id_key'
              )`
        );
        assert.equal(supporting.rows.length, 2);
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        await rollbackClient.query('ROLLBACK').catch(() => {});
        writer.release();
        rollbackClient.release();
      }
    });

    await t.test('arrived/in_service pass with server duration, price, sequence, timing, primary staff and audit', async () => {
      for (const status of ['arrived', 'in_service']) {
        const appointmentId = await createAppointment(status);
        const res = await invoke({ appointmentId, staffId: ids.staffB });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.sequenceNo, 2);
        assert.equal(res.body.data.durationMinutes, 30);
        assert.equal(Number(res.body.data.priceSnapshot), 180.5);
        assert.equal(new Date(res.body.data.startAt).toISOString(), '2031-04-05T02:00:00.000Z');
        assert.equal(new Date(res.body.data.endAt).toISOString(), '2031-04-05T02:30:00.000Z');
        const assignment = await db.query(`SELECT role,staff_id FROM appointment_item_staff_assignments WHERE appointment_item_id=$1`, [res.body.data.appointmentItemId]);
        assert.deepEqual(assignment.rows[0], { role: 'primary', staff_id: ids.staffB });
        const audit = await db.query(`SELECT * FROM appointment_item_mutation_commands WHERE id=$1`, [res.body.data.commandId]);
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].service_name_snapshot, 'Colour');
        assert.equal(audit.rows[0].operator_role_snapshot, 'owner');
        assert.equal(audit.rows[0].staff_role_snapshot, 'primary');
      }
    });

    await t.test('all ineligible statuses reject without mutation and Completed remains unrelated to Paid', async () => {
      for (const status of ['pending', 'confirmed', 'completed', 'cancelled', 'no_show']) {
        const appointmentId = await createAppointment(status);
        const res = await invoke({ appointmentId });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'APPOINTMENT_STATUS_NOT_ELIGIBLE');
        assert.equal(Number((await db.query(`SELECT count(*) FROM appointment_items WHERE appointment_id=$1`, [appointmentId])).rows[0].count), 1);
      }
    });

    await t.test('checkout, tenant, capability, service and strict-body guards reject safely', async () => {
      const checkedOut = await createAppointment();
      await db.query(`INSERT INTO checkout_transactions(shop_id,appointment_id,status) VALUES($1,$2,'refunded')`, [ids.shopA, checkedOut]);
      assert.equal((await invoke({ appointmentId: checkedOut })).body.code, 'CHECKOUT_ALREADY_EXISTS');
      const normal = await createAppointment();
      assert.equal((await invoke({ appointmentId: normal, staffId: ids.staffOther })).body.code, 'STAFF_UNAVAILABLE');
      assert.equal((await invoke({ appointmentId: normal, serviceId: ids.serviceOther })).body.code, 'STAFF_NOT_CAPABLE');
      assert.equal((await invoke({ appointmentId: normal, staffId: ids.staffIncapable })).body.code, 'STAFF_NOT_CAPABLE');
      assert.equal((await invoke({ appointmentId: normal, serviceId: ids.serviceInactive })).body.code, 'SERVICE_UNAVAILABLE');
      const otherAppointment = await createAppointment('arrived', ids.shopB, ids.locationB, ids.staffOther);
      assert.equal((await invoke({ appointmentId: otherAppointment })).statusCode, 404);
      assert.equal((await invoke({ appointmentId: normal, bodyExtra: { price: 0 } })).body.code, 'INVALID_REQUEST');
      assert.equal((await invoke({ appointmentId: normal, bodyExtra: { durationMinutes: 1 } })).body.code, 'INVALID_REQUEST');
      assert.equal((await invoke({ appointmentId: normal, bodyExtra: { requestFingerprint: '0'.repeat(64) } })).body.code, 'INVALID_REQUEST');
    });

    await t.test('owner, manager, admin and front_desk allowed while ordinary staff denied', async () => {
      for (const role of ['owner', 'manager', 'admin', 'front_desk']) {
        const res = await invoke({ appointmentId: await createAppointment(), role });
        assert.equal(res.statusCode, 201, `${role}: ${JSON.stringify(res.body)}`);
      }
      const denied = await invoke({ appointmentId: await createAppointment(), role: 'staff' });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.body.code, 'PERMISSION_DENIED');
    });

    await t.test('collision authority maps to a safe localized code and rolls back', async () => {
      const appointmentId = await createAppointment();
      const addon = makeAddon(async () => { throw new BookabilityError('APPOINTMENT_COLLISION'); });
      const res = await invoke({ appointmentId, addon });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'STAFF_TIME_CONFLICT');
      assert.equal(Number((await db.query(`SELECT count(*) FROM appointment_items WHERE appointment_id=$1`, [appointmentId])).rows[0].count), 1);
    });

    await t.test('same key replays once, conflicting payload rejects, and same key is independent by shop', async () => {
      const appointmentId = await createAppointment();
      const key = `same_${uuid().replace(/-/g, '')}`;
      const [first, second] = await Promise.all([invoke({ appointmentId, key }), invoke({ appointmentId, key })]);
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
      assert.equal(first.body.data.appointmentItemId, second.body.data.appointmentItemId);
      assert.equal(Number((await db.query(`SELECT count(*) FROM appointment_item_mutation_commands WHERE shop_id=$1 AND idempotency_key=$2`, [ids.shopA, key])).rows[0].count), 1);
      const conflict = await invoke({ appointmentId, key, staffId: ids.staffB });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

      const membershipB = (await db.query(`SELECT id FROM owner_shop_memberships WHERE shop_id=$1 LIMIT 1`, [ids.shopB])).rows[0].id;
      const otherAppointment = await createAppointment('arrived', ids.shopB, ids.locationB, ids.staffOther);
      const independent = await invoke({ appointmentId: otherAppointment, serviceId: ids.serviceOther,
        staffId: ids.staffOther, key, shopId: ids.shopB, membershipId: membershipB });
      assert.equal(independent.statusCode, 201, JSON.stringify(independent.body));
      assert.equal(Number((await db.query(`SELECT count(*) FROM appointment_item_mutation_commands WHERE idempotency_key=$1`, [key])).rows[0].count), 2);

      await db.query(`INSERT INTO appointment_item_mutation_commands SELECT gen_random_uuid(),$1,location_id,appointment_id,appointment_item_id,service_id,staff_id,mutation_type,operator_membership_id,operator_role_snapshot,$2,request_fingerprint,fingerprint_version,appointment_end_at_before,appointment_end_at_after,item_sequence_no,item_start_at,item_end_at,service_name_snapshot,duration_minutes_snapshot,price_snapshot,item_status_snapshot,staff_role_snapshot,now()
        FROM appointment_item_mutation_commands WHERE shop_id=$3 AND idempotency_key=$4`,
        [ids.shopB, `fk_${uuid().replace(/-/g, '')}`, ids.shopA, key]).then(
          () => assert.fail('cross-tenant item FKs must reject an unproven audit relationship'),
          error => assert.equal(error.code, '23503')
        );

      const appointmentOne = await createAppointment();
      const appointmentTwo = await createAppointment();
      const contestedKey = `race_${uuid().replace(/-/g, '')}`;
      const contested = await Promise.all([
        invoke({ appointmentId: appointmentOne, serviceId: ids.serviceA, key: contestedKey }),
        invoke({ appointmentId: appointmentTwo, serviceId: ids.serviceB, key: contestedKey })
      ]);
      assert.deepEqual(contested.map(result => result.statusCode).sort(), [201, 409]);
      assert.equal(contested.find(result => result.statusCode === 409).body.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(Number((await db.query(`SELECT count(*) FROM appointment_item_mutation_commands WHERE shop_id=$1 AND idempotency_key=$2`, [ids.shopA, contestedKey])).rows[0].count), 1);
    });

    await t.test('different keys serialize on one appointment and allocate distinct sequences', async () => {
      const appointmentId = await createAppointment();
      const [one, two] = await Promise.all([
        invoke({ appointmentId, serviceId: ids.serviceA, staffId: ids.staffA }),
        invoke({ appointmentId, serviceId: ids.serviceB, staffId: ids.staffB })
      ]);
      assert.deepEqual([one.statusCode, two.statusCode], [201, 201]);
      const items = await db.query(`SELECT sequence_no,start_at,end_at FROM appointment_items WHERE appointment_id=$1 ORDER BY sequence_no`, [appointmentId]);
      assert.deepEqual(items.rows.map(row => row.sequence_no), [1, 2, 3]);
      assert.equal(new Date(items.rows[1].end_at).getTime(), new Date(items.rows[2].start_at).getTime());
      assert.equal(new Date((await db.query(`SELECT end_at FROM appointments WHERE id=$1`, [appointmentId])).rows[0].end_at).getTime(), new Date(items.rows[2].end_at).getTime());
    });

    await t.test('checkout and status races serialize through appointment-first locking', async () => {
      const checkoutAppointment = await createAppointment();
      const checkout = await pool.connect();
      await checkout.query('BEGIN');
      await checkout.query(`SELECT id FROM appointments WHERE id=$1 FOR UPDATE`, [checkoutAppointment]);
      const pendingAddon = invoke({ appointmentId: checkoutAppointment });
      await checkout.query(`INSERT INTO checkout_transactions(shop_id,appointment_id,status) VALUES($1,$2,'draft')`, [ids.shopA, checkoutAppointment]);
      await checkout.query('COMMIT');
      checkout.release();
      const checkoutResult = await pendingAddon;
      assert.equal(checkoutResult.body.code, 'CHECKOUT_ALREADY_EXISTS');

      const addonFirstAppointment = await createAppointment();
      let releaseValidation;
      let reachedValidation;
      const reached = new Promise(resolve => { reachedValidation = resolve; });
      const release = new Promise(resolve => { releaseValidation = resolve; });
      const pausedAddon = makeAddon(async () => { reachedValidation(); await release; });
      const addingFirst = invoke({ appointmentId: addonFirstAppointment, addon: pausedAddon });
      await reached;
      const checkoutAfter = await pool.connect();
      await checkoutAfter.query('BEGIN');
      let checkoutHasLock = false;
      const appointmentLock = checkoutAfter.query(`SELECT id FROM appointments WHERE id=$1 FOR UPDATE`, [addonFirstAppointment]).then(() => { checkoutHasLock = true; });
      await wait(75);
      assert.equal(checkoutHasLock, false);
      releaseValidation();
      assert.equal((await addingFirst).statusCode, 201);
      await appointmentLock;
      assert.equal(Number((await checkoutAfter.query(`SELECT count(*) FROM appointment_items WHERE appointment_id=$1`, [addonFirstAppointment])).rows[0].count), 2);
      await checkoutAfter.query(`INSERT INTO checkout_transactions(shop_id,appointment_id,status) VALUES($1,$2,'draft')`, [ids.shopA, addonFirstAppointment]);
      await checkoutAfter.query('COMMIT');
      checkoutAfter.release();

      const statusAppointment = await createAppointment();
      const statusClient = await pool.connect();
      await statusClient.query('BEGIN');
      await statusClient.query(`SELECT id FROM appointments WHERE id=$1 FOR UPDATE`, [statusAppointment]);
      const pendingStatusAddon = invoke({ appointmentId: statusAppointment });
      await statusClient.query(`UPDATE appointments SET status='completed' WHERE id=$1`, [statusAppointment]);
      await statusClient.query('COMMIT');
      statusClient.release();
      assert.equal((await pendingStatusAddon).body.code, 'APPOINTMENT_STATUS_NOT_ELIGIBLE');
    });

    await t.test('capability deactivation waits behind the add-on share lock', async () => {
      const appointmentId = await createAppointment();
      let releaseValidation;
      let reachedValidation;
      const reached = new Promise(resolve => { reachedValidation = resolve; });
      const release = new Promise(resolve => { releaseValidation = resolve; });
      const addon = makeAddon(async () => { reachedValidation(); await release; });
      const adding = invoke({ appointmentId, serviceId: ids.serviceB, staffId: ids.staffB, addon });
      await reached;
      const capabilityClient = await pool.connect();
      await capabilityClient.query('BEGIN');
      let deactivationFinished = false;
      const deactivation = capabilityClient.query(`UPDATE staff_services SET is_active=false WHERE shop_id=$1 AND staff_id=$2 AND service_id=$3`, [ids.shopA, ids.staffB, ids.serviceB]).then(() => { deactivationFinished = true; });
      await wait(75);
      assert.equal(deactivationFinished, false);
      releaseValidation();
      assert.equal((await adding).statusCode, 201);
      await deactivation;
      await capabilityClient.query('COMMIT');
      capabilityClient.release();
      assert.equal((await db.query(`SELECT is_active FROM staff_services WHERE shop_id=$1 AND staff_id=$2 AND service_id=$3`, [ids.shopA, ids.staffB, ids.serviceB])).rows[0].is_active, false);
    });

    await t.test('audit is immutable, tenant FKs reject drift, and rollback refuses after data', async () => {
      const command = (await db.query(`SELECT * FROM appointment_item_mutation_commands ORDER BY created_at LIMIT 1`)).rows[0];
      const membershipB = (await db.query(`SELECT id FROM owner_shop_memberships WHERE shop_id=$1 LIMIT 1`, [ids.shopB])).rows[0].id;
      const spareItem = (await db.query(`SELECT item.id,item.appointment_id FROM appointment_items item
        WHERE item.shop_id=$1 AND NOT EXISTS (SELECT 1 FROM appointment_item_mutation_commands command WHERE command.appointment_item_id=item.id)
        LIMIT 1`, [ids.shopA])).rows[0];
      const cloneCommand = ({ shopId = command.shop_id, appointmentId = spareItem.appointment_id,
        appointmentItemId = spareItem.id,
        staffId = command.staff_id, membershipId = command.operator_membership_id }) => db.query(
        `INSERT INTO appointment_item_mutation_commands (
           id,shop_id,location_id,appointment_id,appointment_item_id,service_id,staff_id,
           mutation_type,operator_membership_id,operator_role_snapshot,idempotency_key,
           request_fingerprint,fingerprint_version,appointment_end_at_before,
           appointment_end_at_after,item_sequence_no,item_start_at,item_end_at,
           service_name_snapshot,duration_minutes_snapshot,price_snapshot,item_status_snapshot,
           staff_role_snapshot,created_at
         ) SELECT gen_random_uuid(),$1,location_id,$2,$3,service_id,$4,
                  mutation_type,$5,operator_role_snapshot,$6,request_fingerprint,fingerprint_version,
                  appointment_end_at_before,appointment_end_at_after,item_sequence_no,item_start_at,
                  item_end_at,service_name_snapshot,duration_minutes_snapshot,price_snapshot,
                  item_status_snapshot,staff_role_snapshot,now()
             FROM appointment_item_mutation_commands WHERE id=$7`,
        [shopId, appointmentId, appointmentItemId, staffId, membershipId, `fk_${uuid().replace(/-/g, '')}`, command.id]
      );
      await assert.rejects(cloneCommand({ shopId: ids.shopB }), error => error.constraint === 'appointment_item_mutation_commands_item_scope_fkey');
      await assert.rejects(cloneCommand({ appointmentId: uuid() }), error => error.constraint === 'appointment_item_mutation_commands_item_appointment_fkey');
      await assert.rejects(cloneCommand({ staffId: ids.staffOther }), error => error.constraint === 'appointment_item_mutation_commands_staff_location_fkey');
      await assert.rejects(cloneCommand({ membershipId: membershipB }), error => error.constraint === 'appointment_item_mutation_commands_operator_fkey');
      await assert.rejects(db.query(`UPDATE appointment_item_mutation_commands SET service_name_snapshot='changed' WHERE id=$1`, [command.id]), error => error.code === '55000');
      await assert.rejects(db.query(`DELETE FROM appointment_item_mutation_commands WHERE id=$1`, [command.id]), error => error.code === '55000');
      await assert.rejects(db.query(migration('rollback/088_appointment_item_mutation_commands_rollback.sql')), /rollback refused: audit rows exist/);
      await db.query('ROLLBACK');
      assert.ok((await db.query(`SELECT to_regclass('public.appointment_item_mutation_commands') AS relation`)).rows[0].relation);
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
