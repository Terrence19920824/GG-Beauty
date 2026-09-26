'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { syncAppointmentItemStatus, loadAndValidatePhaseAStructure } = require('../lib/appointment-multi-service');
const { recordStatusHistory, canTransition } = require('../lib/appointment-status');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const preflightSql = fs.readFileSync(path.join(ROOT, 'migrations', '066_appointment_status_constraint_preflight_readonly.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(ROOT, 'migrations', '067_appointment_status_constraint_schema.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(ROOT, 'migrations', '068_appointment_status_constraint_verification_readonly.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '067_appointment_status_constraint_rollback.sql'), 'utf8');

const migration043 = fs.readFileSync(path.join(ROOT, 'migrations', '043_appointment_arrival_status_foundation.sql'), 'utf8');

const IDS = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-111111111111',
  customer: '33333333-3333-4333-8333-111111111111',
  staff: '44444444-4444-4444-8444-111111111111',
  appointment1: '55555555-5555-4555-8555-111111111111',
  appointment2: '55555555-5555-4555-8555-222222222222',
  service: '77777777-7777-4777-8777-111111111111',
  item1: '66666666-6666-4666-8666-111111111111',
  item2: '66666666-6666-4666-8666-222222222222'
};

test('PostgreSQL 17 appointment status constraint migration: arrived/in_service persistence, rejection of invalid statuses, and guarded rollback', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-status-constraint-'));
  const data = path.join(temp, 'data');
  const port = 57400 + Math.floor(Math.random() * 400);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
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
    assert.ok(db, 'local PostgreSQL test server must accept connection');

    // 1. Setup base schema matching Production baseline before migration 066
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE shops (id uuid PRIMARY KEY);
      CREATE TABLE locations (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id, id));
      CREATE TABLE staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL);
      CREATE TABLE staff_permissions (shop_id uuid NOT NULL, staff_id uuid NOT NULL);

      CREATE TABLE appointments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        location_id uuid NOT NULL,
        staff_id uuid NOT NULL,
        service_id uuid NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        cancelled_at timestamptz NULL,
        service_completed_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT appointments_check CHECK (end_at > start_at),
        CONSTRAINT appointments_shop_location_id_key UNIQUE (shop_id, location_id, id),
        CONSTRAINT appointments_status_check CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text]))
      );
      CREATE UNIQUE INDEX appointments_shop_id_id_uidx ON appointments (shop_id, id);

      CREATE TABLE appointment_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL,
        location_id uuid NOT NULL,
        appointment_id uuid NOT NULL,
        service_id uuid NULL,
        sequence_no integer NOT NULL DEFAULT 1,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT appointment_items_status_check CHECK (btrim(status) <> ''::text),
        CONSTRAINT appointment_items_parent_fkey FOREIGN KEY (shop_id, location_id, appointment_id)
          REFERENCES appointments (shop_id, location_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE appointment_item_staff_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL,
        location_id uuid NOT NULL,
        appointment_item_id uuid NOT NULL REFERENCES appointment_items(id),
        staff_id uuid NOT NULL REFERENCES staff(id),
        role text NOT NULL DEFAULT 'primary',
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Apply migration 043 (appointment_status_history)
    await db.query(migration043);

    // Seed test fixtures
    await db.query(`INSERT INTO shops (id) VALUES ($1)`, [IDS.shop]);
    await db.query(`INSERT INTO locations (id, shop_id) VALUES ($1, $2)`, [IDS.location, IDS.shop]);
    await db.query(`INSERT INTO staff (id, shop_id) VALUES ($1, $2)`, [IDS.staff, IDS.shop]);

    await db.query(`
      INSERT INTO appointments (id, shop_id, location_id, staff_id, service_id, start_at, end_at, status)
      VALUES ($1, $2, $3, $4, $5, '2026-10-01 10:00:00Z', '2026-10-01 11:00:00Z', 'pending'),
             ($6, $2, $3, $4, $5, '2026-10-01 11:00:00Z', '2026-10-01 12:00:00Z', 'confirmed')
    `, [IDS.appointment1, IDS.shop, IDS.location, IDS.staff, IDS.service, IDS.appointment2]);

    await db.query(`
      INSERT INTO appointment_items (id, shop_id, location_id, appointment_id, service_id, sequence_no, start_at, end_at, status)
      VALUES ($1, $2, $3, $4, $5, 1, '2026-10-01 10:00:00Z', '2026-10-01 11:00:00Z', 'pending'),
             ($6, $2, $3, $7, $5, 1, '2026-10-01 11:00:00Z', '2026-10-01 12:00:00Z', 'confirmed')
    `, [IDS.item1, IDS.shop, IDS.location, IDS.appointment1, IDS.service, IDS.item2, IDS.appointment2]);

    await db.query(`
      INSERT INTO appointment_item_staff_assignments (shop_id, location_id, appointment_item_id, staff_id, role, start_at, end_at)
      VALUES ($1, $2, $3, $4, 'primary', '2026-10-01 10:00:00Z', '2026-10-01 11:00:00Z'),
             ($1, $2, $5, $4, 'primary', '2026-10-01 11:00:00Z', '2026-10-01 12:00:00Z')
    `, [IDS.shop, IDS.location, IDS.item1, IDS.staff, IDS.item2]);

    // 2. Pre-migration check: reproduction of production bug
    // confirmed -> no_show works on old constraint
    await db.query(`UPDATE appointments SET status = 'no_show', updated_at = NOW() WHERE id = $1`, [IDS.appointment2]);
    const resNoShow = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment2]);
    assert.equal(resNoShow.rows[0].status, 'no_show');

    // Reset to confirmed
    await db.query(`UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [IDS.appointment2]);

    // confirmed -> arrived FAILS with 23514 on old constraint!
    await assert.rejects(
      db.query(`UPDATE appointments SET status = 'arrived', updated_at = NOW() WHERE id = $1`, [IDS.appointment2]),
      err => {
        assert.equal(err.code, '23514', 'PostgreSQL must reject arrived with check_violation (23514)');
        return true;
      }
    );

    // 3. Execute Preflight Migration 066
    await db.query(preflightSql);

    // 4. Execute Schema Migration 067
    await db.query(schemaSql);

    // 5. Execute Verification Migration 068
    await db.query(verifySql);

    // 6. Post-migration: verify arrived and in_service lifecycle with full application persistence
    // Test: pending -> confirmed on appointment1
    assert.ok(canTransition('pending', 'confirmed'));
    const structurePending = await loadAndValidatePhaseAStructure(db, { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location });
    assert.equal(structurePending.itemCount, 1);
    await db.query(`UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [IDS.appointment1]);
    await syncAppointmentItemStatus(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location },
      status: 'confirmed',
      expectedItemCount: structurePending.itemCount
    });
    await recordStatusHistory(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop },
      fromStatus: 'pending',
      toStatus: 'confirmed',
      operatorType: 'owner',
      source: 'owner_dashboard'
    });

    const checkConfirmed = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment1]);
    assert.equal(checkConfirmed.rows[0].status, 'confirmed');

    // Test: confirmed -> arrived on appointment1
    assert.ok(canTransition('confirmed', 'arrived'));
    const structureConfirmed = await loadAndValidatePhaseAStructure(db, { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location });
    assert.equal(structureConfirmed.itemCount, 1);
    await db.query(`UPDATE appointments SET status = 'arrived', updated_at = NOW() WHERE id = $1`, [IDS.appointment1]);
    await syncAppointmentItemStatus(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location },
      status: 'arrived',
      expectedItemCount: structureConfirmed.itemCount
    });
    await recordStatusHistory(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop },
      fromStatus: 'confirmed',
      toStatus: 'arrived',
      operatorType: 'owner',
      source: 'owner_dashboard'
    });

    const checkArrived = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment1]);
    assert.equal(checkArrived.rows[0].status, 'arrived');
    const checkItemArrived = await db.query(`SELECT status FROM appointment_items WHERE id = $1`, [IDS.item1]);
    assert.equal(checkItemArrived.rows[0].status, 'arrived');

    // Test: arrived -> in_service on appointment1
    assert.ok(canTransition('arrived', 'in_service'));
    const structureArrived = await loadAndValidatePhaseAStructure(db, { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location });
    assert.equal(structureArrived.itemCount, 1);
    await db.query(`UPDATE appointments SET status = 'in_service', updated_at = NOW() WHERE id = $1`, [IDS.appointment1]);
    await syncAppointmentItemStatus(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location },
      status: 'in_service',
      expectedItemCount: structureArrived.itemCount
    });
    await recordStatusHistory(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop },
      fromStatus: 'arrived',
      toStatus: 'in_service',
      operatorType: 'owner',
      source: 'owner_dashboard'
    });

    const checkInService = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment1]);
    assert.equal(checkInService.rows[0].status, 'in_service');

    // Test: in_service -> completed on appointment1
    assert.ok(canTransition('in_service', 'completed'));
    const structureInService = await loadAndValidatePhaseAStructure(db, { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location });
    assert.equal(structureInService.itemCount, 1);
    await db.query(`UPDATE appointments SET status = 'completed', service_completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [IDS.appointment1]);
    await syncAppointmentItemStatus(db, {
      appointment: { id: IDS.appointment1, shop_id: IDS.shop, location_id: IDS.location },
      status: 'completed',
      expectedItemCount: structureInService.itemCount
    });
    const checkCompleted = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment1]);
    assert.equal(checkCompleted.rows[0].status, 'completed');

    // Test: confirmed -> no_show still works on appointment2
    assert.ok(canTransition('confirmed', 'no_show'));
    await db.query(`UPDATE appointments SET status = 'no_show', updated_at = NOW() WHERE id = $1`, [IDS.appointment2]);
    const checkNoShow = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment2]);
    assert.equal(checkNoShow.rows[0].status, 'no_show');

    // 7. Verify unsupported/arbitrary status values are rejected by PostgreSQL 23514
    for (const invalidStatus of ['awaiting_checkout', 'fake_status', 'cancelled_by_user', '', 'IN_SERVICE']) {
      await assert.rejects(
        db.query(`UPDATE appointments SET status = $1 WHERE id = $2`, [invalidStatus, IDS.appointment2]),
        err => {
          assert.equal(err.code, '23514', `PostgreSQL must reject status "${invalidStatus}" with 23514`);
          return true;
        }
      );
    }

    // 8. Rollback Data Guard Verification
    // Put appointment2 into 'arrived' status
    await db.query(`UPDATE appointments SET status = 'arrived' WHERE id = $1`, [IDS.appointment2]);

    // Rollback MUST be BLOCKED with exception because an appointment has 'arrived' status
    await assert.rejects(
      db.query(rollbackSql),
      err => {
        assert.match(err.message, /Rollback blocked: public\.appointments contains rows with arrived or in_service status/);
        return true;
      }
    );
    await db.query('ROLLBACK');

    // Verify constraint is STILL the expanded 7-status constraint
    const defStillExpanded = (await db.query(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_status_check'
    `)).rows[0].def;
    assert.match(defStillExpanded, /'arrived'/);
    assert.match(defStillExpanded, /'in_service'/);

    // Put appointment2 into 'in_service' status
    await db.query(`UPDATE appointments SET status = 'in_service' WHERE id = $1`, [IDS.appointment2]);

    // Rollback MUST still be BLOCKED with exception because of 'in_service'
    await assert.rejects(
      db.query(rollbackSql),
      err => {
        assert.match(err.message, /Rollback blocked: public\.appointments contains rows with arrived or in_service status/);
        return true;
      }
    );
    await db.query('ROLLBACK');

    // Now resolve appointment2 to 'completed' so no rows have 'arrived' or 'in_service'
    await db.query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [IDS.appointment2]);

    // Now rollback MUST succeed
    await db.query(rollbackSql);

    // Verify post-rollback: constraint was safely restored to 5 statuses
    const defRolledBack = (await db.query(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_status_check'
    `)).rows[0].def;
    assert.doesNotMatch(defRolledBack, /'arrived'/);
    assert.doesNotMatch(defRolledBack, /'in_service'/);

    // Verify 'arrived' is rejected again by PostgreSQL
    await assert.rejects(
      db.query(`UPDATE appointments SET status = 'arrived' WHERE id = $1`, [IDS.appointment2]),
      err => {
        assert.equal(err.code, '23514', 'Post-rollback must reject arrived with 23514');
        return true;
      }
    );

    // 9. Re-apply migration 066, 067, 068 to verify idempotence and re-application
    await db.query(preflightSql);
    await db.query(schemaSql);
    await db.query(verifySql);

    // Re-verify 'arrived' is accepted once again
    await db.query(`UPDATE appointments SET status = 'arrived' WHERE id = $1`, [IDS.appointment2]);
    const checkReArrived = await db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appointment2]);
    assert.equal(checkReArrived.rows[0].status, 'arrived');

  } finally {
    await db?.end().catch(() => {});
    if (!postgres.killed) postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
