'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const preflightSql = fs.readFileSync(path.join(ROOT, 'migrations', '090_booking_notifications_preflight_readonly.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(ROOT, 'migrations', '091_booking_notifications_schema.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(ROOT, 'migrations', '092_booking_notifications_verification_readonly.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '091_booking_notifications_rollback.sql'), 'utf8');

test('PostgreSQL 17 booking notifications migration lifecycle is idempotent and safe', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-booking-notif-'));
  const data = path.join(temp, 'data');
  const port = 57400 + Math.floor(Math.random() * 400);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
  const connectionString = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Client({ connectionString });
      try {
        await candidate.connect();
        db = candidate;
        break;
      } catch (error) {
        await candidate.end().catch(() => {});
        if (attempt === 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(db, 'local PostgreSQL test server must accept a connection');

    // Create prerequisite tables
    await db.query(`
      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL
      );
      CREATE TABLE public.staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
        name TEXT NOT NULL
      );
      CREATE TABLE public.appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
        staff_id UUID NULL REFERENCES public.staff(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'confirmed'
      );
    `);

    // 1. Preflight succeeds
    await db.query(preflightSql);

    // 2. Schema migration creates table and constraints
    await db.query(schemaSql);

    // 3. Verification succeeds
    await db.query(verifySql);

    // 4. Idempotency: re-running schema migration succeeds without error
    await db.query(schemaSql);

    // 5. Insert test data & verify constraints
    const shopRes = await db.query("INSERT INTO public.shops (name) VALUES ('Test Shop') RETURNING id");
    const shopId = shopRes.rows[0].id;

    const staffRes = await db.query("INSERT INTO public.staff (shop_id, name) VALUES ($1, 'Staff 1') RETURNING id", [shopId]);
    const staffId = staffRes.rows[0].id;

    const apptRes = await db.query("INSERT INTO public.appointments (shop_id, staff_id, status) VALUES ($1, $2, 'confirmed') RETURNING id", [shopId, staffId]);
    const apptId = apptRes.rows[0].id;

    // Insert shop-level notification
    await db.query(`
      INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
      VALUES ($1, $2, 'booking_created', 'shop', NULL, $3)
    `, [shopId, apptId, `booking_created:${apptId}:shop`]);

    // Insert staff-level notification
    await db.query(`
      INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
      VALUES ($1, $2, 'booking_created', 'staff', $3, $4)
    `, [shopId, apptId, staffId, `booking_created:${apptId}:staff:${staffId}`]);

    // Dedupe constraint: duplicate insert must fail with 23505
    await assert.rejects(
      db.query(`
        INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
        VALUES ($1, $2, 'booking_created', 'shop', NULL, $3)
      `, [shopId, apptId, `booking_created:${apptId}:shop`]),
      error => error.code === '23505'
    );

    // Event type check constraint: invalid event type fails with 23514
    await assert.rejects(
      db.query(`
        INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
        VALUES ($1, $2, 'invalid_event', 'shop', NULL, 'test-key-invalid')
      `, [shopId, apptId]),
      error => error.code === '23514'
    );

    // Recipient check constraint: staff recipient with NULL staff_id fails with 23514
    await assert.rejects(
      db.query(`
        INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
        VALUES ($1, $2, 'booking_created', 'staff', NULL, 'test-key-null-staff')
      `, [shopId, apptId]),
      error => error.code === '23514'
    );

    // Recipient check constraint: shop recipient with non-NULL staff_id fails with 23514
    await assert.rejects(
      db.query(`
        INSERT INTO public.booking_notifications (shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key)
        VALUES ($1, $2, 'booking_created', 'shop', $3, 'test-key-shop-with-staff')
      `, [shopId, apptId, staffId]),
      error => error.code === '23514'
    );

    // 6. Rollback
    await db.query(rollbackSql);

    // Table should now be absent
    const tableCheck = await db.query("SELECT to_regclass('public.booking_notifications') AS tbl");
    assert.equal(tableCheck.rows[0].tbl, null);

    // Verification must fail after rollback
    await assert.rejects(db.query(verifySql));
    await db.query('ROLLBACK');

  } finally {
    if (db) await db.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
