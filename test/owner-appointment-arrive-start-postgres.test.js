'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { Client, Pool } = require('pg');
const {
  AppointmentMutationError,
  loadAndValidatePhaseAStructure,
  runInTransaction,
  syncAppointmentItemStatus
} = require('../lib/appointment-multi-service');
const {
  canTransition,
  isKnownStatus,
  ownerStatusHistoryActorType,
  recordStatusHistory
} = require('../lib/appointment-status');
const { createOwnerAppointmentArriveStart } = require('../lib/owner-appointment-arrive-start');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const uuid = () => crypto.randomUUID();
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectWhenReady(config, postgres, stderr) {
  let last;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (postgres.exitCode !== null || postgres.signalCode !== null) throw new Error(`PostgreSQL exited: ${stderr()}`);
    const client = new Client(config);
    try { await client.connect(); return client; } catch (error) { last = error; await client.end().catch(() => {}); await wait(100); }
  }
  throw last;
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE staff (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL
);
CREATE TABLE appointments (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
  service_id uuid NOT NULL, staff_id uuid NOT NULL,
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_items (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
  appointment_id uuid NOT NULL, service_id uuid NOT NULL,
  sequence_no integer NOT NULL, start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL, status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_item_staff_assignments (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL, location_id uuid NOT NULL,
  appointment_item_id uuid NOT NULL, staff_id uuid NOT NULL,
  role text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL
);
CREATE TABLE appointment_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), edge_no bigserial UNIQUE,
  shop_id uuid NOT NULL,
  appointment_id uuid NOT NULL, from_status text NOT NULL, to_status text NOT NULL,
  operator_type text NOT NULL, operator_id uuid, source text NOT NULL,
  reason text, changed_at timestamptz NOT NULL DEFAULT now()
);
`;

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

test('arrive-and-start PostgreSQL atomicity and concurrent retry', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-arrive-start-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const port = 58920 + Math.floor(Math.random() * 60);
  let stderr = '';
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-k', socket, '-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  postgres.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  const config = { host: socket, port, database: 'postgres', user: os.userInfo().username, ssl: false };
  let db;
  let pool;
  try {
    db = await connectWhenReady(config, postgres, () => stderr);
    await db.query(SCHEMA);
    pool = new Pool(config);
    const ids = {
      shop: uuid(), otherShop: uuid(), location: uuid(), serviceA: uuid(), serviceB: uuid(),
      staffA: uuid(), staffB: uuid(), operator: uuid()
    };
    await db.query(
      'INSERT INTO staff(id,shop_id) VALUES($1,$3),($2,$3)',
      [ids.staffA, ids.staffB, ids.shop]
    );

    const createAppointment = async (status = 'pending') => {
      const appointmentId = uuid();
      const itemA = uuid();
      const itemB = uuid();
      const start = '2031-04-05T01:00:00.000Z';
      const middle = '2031-04-05T01:30:00.000Z';
      const end = '2031-04-05T02:00:00.000Z';
      await db.query(`INSERT INTO appointments(id,shop_id,location_id,service_id,staff_id,start_at,end_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [appointmentId, ids.shop, ids.location, ids.serviceA, ids.staffA, start, end, status]);
      await db.query(`INSERT INTO appointment_items(id,shop_id,location_id,appointment_id,service_id,sequence_no,start_at,end_at,status)
        VALUES($1,$3,$4,$5,$6,1,$7,$8,$9),($2,$3,$4,$5,$10,2,$8,$11,$9)`,
      [itemA, itemB, ids.shop, ids.location, appointmentId, ids.serviceA, start, middle, status, ids.serviceB, end]);
      await db.query(`INSERT INTO appointment_item_staff_assignments(id,shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at)
        VALUES($1,$3,$4,$5,$6,'primary',$7,$8),($2,$3,$4,$9,$10,'primary',$8,$11)`,
      [uuid(), uuid(), ids.shop, ids.location, itemA, ids.staffA, start, middle, itemB, ids.staffB, end]);
      return appointmentId;
    };

    const makeHandler = historyWriter => createOwnerAppointmentArriveStart({
      pool,
      isUuid,
      runInTransaction,
      AppointmentMutationError,
      loadAndValidatePhaseAStructure,
      syncAppointmentItemStatus,
      isKnownStatus,
      canTransition,
      ownerStatusHistoryActorType,
      recordStatusHistory: historyWriter || recordStatusHistory,
      safeErrorCode: error => error?.code || 'error'
    });
    const invoke = async (handler, appointmentId, shopId = ids.shop) => {
      const response = responseRecorder();
      await handler({
        params: { appointmentId },
        ownerAuth: { shopId, role: 'front_desk', ownerAccountId: ids.operator }
      }, response);
      return response;
    };

    await t.test('pending path commits exact parent/item/history edges', async () => {
      const appointmentId = await createAppointment('pending');
      const response = await invoke(makeHandler(), appointmentId);
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.data.status, 'in_service');
      assert.equal((await db.query('SELECT status FROM appointments WHERE id=$1', [appointmentId])).rows[0].status, 'in_service');
      assert.deepEqual((await db.query('SELECT status FROM appointment_items WHERE appointment_id=$1 ORDER BY sequence_no', [appointmentId])).rows.map(row => row.status), ['in_service', 'in_service']);
      assert.deepEqual((await db.query('SELECT from_status,to_status FROM appointment_status_history WHERE appointment_id=$1 ORDER BY edge_no', [appointmentId])).rows.map(row => [row.from_status, row.to_status]), [
        ['pending', 'confirmed'], ['confirmed', 'arrived'], ['arrived', 'in_service']
      ]);
    });

    await t.test('intermediate history failure rolls back all prior edges', async () => {
      const appointmentId = await createAppointment('pending');
      let calls = 0;
      const failingWriter = async (client, entry) => {
        calls += 1;
        await recordStatusHistory(client, entry);
        if (calls === 2) throw new Error('injected history failure');
      };
      const response = await invoke(makeHandler(failingWriter), appointmentId);
      assert.equal(response.statusCode, 500);
      assert.equal((await db.query('SELECT status FROM appointments WHERE id=$1', [appointmentId])).rows[0].status, 'pending');
      assert.deepEqual((await db.query('SELECT status FROM appointment_items WHERE appointment_id=$1 ORDER BY sequence_no', [appointmentId])).rows.map(row => row.status), ['pending', 'pending']);
      assert.equal((await db.query('SELECT COUNT(*)::INTEGER AS count FROM appointment_status_history WHERE appointment_id=$1', [appointmentId])).rows[0].count, 0);
    });

    await t.test('concurrent double submit serializes and records one edge sequence', async () => {
      const appointmentId = await createAppointment('pending');
      const handler = makeHandler();
      const [first, second] = await Promise.all([
        invoke(handler, appointmentId),
        invoke(handler, appointmentId)
      ]);
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(first.body.data.status, 'in_service');
      assert.equal(second.body.data.status, 'in_service');
      assert.equal((await db.query('SELECT COUNT(*)::INTEGER AS count FROM appointment_status_history WHERE appointment_id=$1', [appointmentId])).rows[0].count, 3);
    });

    await t.test('tenant mismatch cannot lock or mutate appointment', async () => {
      const appointmentId = await createAppointment('confirmed');
      const response = await invoke(makeHandler(), appointmentId, ids.otherShop);
      assert.equal(response.statusCode, 404);
      assert.equal((await db.query('SELECT status FROM appointments WHERE id=$1', [appointmentId])).rows[0].status, 'confirmed');
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
