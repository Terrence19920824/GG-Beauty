'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { app } = require('../server');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  locationA: '55555555-5555-4555-8555-555555555555',
  staffOriginal: '66666666-6666-4666-8666-111111111111',
  staffTarget: '66666666-6666-4666-8666-222222222222',
  staffUnskilled: '66666666-6666-4666-8666-333333333333',
  serviceA: '77777777-7777-4777-8777-111111111111',
  serviceB: '77777777-7777-4777-8777-222222222222',
  appointmentA: '88888888-8888-4888-8888-111111111111',
  appointmentOther: '88888888-8888-4888-8888-222222222222'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shopA,
  login_identifier: 'test_admin',
  display_name: 'Test Admin',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const makeMockPool = ({
  role = 'owner',
  validSession = true,
  appointmentShopId = ID.shopA,
  appointmentStatus = 'confirmed',
  staffSelectionType = 'specific',
  hasSkills = true,
  isWorking = true,
  offDutyReason = null, // 'day_off' | 'not_scheduled' | 'outside_hours'
  hasConflict = false
} = {}) => {
  const state = {
    queries: [],
    releases: 0,
    appointmentUpdates: [],
    itemUpdates: [],
    assignmentUpdates: [],
    auditInserts: [],
    checkoutWrites: []
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.queries.push({ sql: normalized, params });

      // Detect any accidental checkout/payment writes
      if (/checkout|invoice|payment|pos/i.test(normalized) && /insert|update|delete/i.test(normalized)) {
        state.checkoutWrites.push({ sql: normalized, params });
      }

      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) {
        return { rows: [] };
      }

      if (/^SET LOCAL lock_timeout/.test(normalized)) {
        return { rows: [] };
      }

      if (/^SELECT .* FROM appointments/i.test(normalized)) {
        if (appointmentShopId !== params[1]) return { rows: [] };
        return {
          rows: [{
            id: ID.appointmentA,
            shop_id: ID.shopA,
            location_id: ID.locationA,
            staff_id: ID.staffOriginal,
            service_id: ID.serviceA,
            start_at: '2026-10-01T02:00:00.000Z',
            end_at: '2026-10-01T03:00:00.000Z',
            status: appointmentStatus,
            override_conflict: false,
            staff_selection_type: staffSelectionType
          }]
        };
      }

      if (/^SELECT id, timezone, is_active FROM locations/i.test(normalized)) {
        return {
          rows: [{
            id: ID.locationA,
            timezone: 'Asia/Singapore',
            is_active: true
          }]
        };
      }

      if (/^SELECT id, service_id, sequence_no, service_name_snapshot, duration_minutes_snapshot, price_snapshot/i.test(normalized)) {
        return {
          rows: [
            {
              id: 'item-uuid-1',
              service_id: ID.serviceA,
              sequence_no: 1,
              service_name_snapshot: 'Signature Haircut',
              duration_minutes_snapshot: 60,
              price_snapshot: '88.00',
              start_at: '2026-10-01T02:00:00.000Z',
              end_at: '2026-10-01T03:00:00.000Z'
            }
          ]
        };
      }

      if (/^SELECT \(\(\$1::DATE \+ \$2::TIME\) AT TIME ZONE \$3\) AS new_start_at/i.test(normalized)) {
        return {
          rows: [{
            new_start_at: '2026-10-02T06:30:00.000Z',
            new_end_at: '2026-10-02T07:30:00.000Z'
          }]
        };
      }

      if (/^SELECT id, name, is_active FROM staff WHERE id = \$1 AND shop_id = \$2/i.test(normalized)) {
        if (params[0] === ID.staffTarget || params[0] === ID.staffOriginal || params[0] === ID.staffUnskilled) {
          return { rows: [{ id: params[0], name: 'Target Staff', is_active: true }] };
        }
        return { rows: [] };
      }

      if (/^SELECT id FROM staff_location_assignments/i.test(normalized)) {
        return { rows: [{ id: 'assign-loc-1' }] };
      }

      if (/^SELECT service_id FROM staff_services/i.test(normalized)) {
        if (hasSkills) {
          return { rows: [{ service_id: ID.serviceA }] };
        }
        return { rows: [] }; // skill mismatch
      }

      if (/^SELECT override_type, start_time, end_time, approval_status FROM staff_schedule_overrides/i.test(normalized)) {
        if (offDutyReason === 'day_off') {
          return { rows: [{ override_type: 'day_off', start_time: null, end_time: null, approval_status: 'approved' }] };
        }
        return { rows: [] };
      }

      if (/^SELECT start_time, end_time FROM staff_location_working_hours/i.test(normalized)) {
        if (offDutyReason === 'not_scheduled') {
          return { rows: [] };
        }
        return { rows: [{ start_time: '09:00:00', end_time: '19:00:00' }] };
      }

      if (/SELECT \(\(\$1::TIMESTAMPTZ AT TIME ZONE \$3\)::TIME >= \$4::TIME/i.test(normalized)) {
        if (offDutyReason === 'outside_hours') {
          return { rows: [{ is_contained: false }] };
        }
        return { rows: [{ is_contained: true }] };
      }

      if (/SELECT p\.id AS appointment_id, p\.appointment_no/i.test(normalized)) {
        if (hasConflict) {
          return {
            rows: [{
              appointment_id: ID.appointmentOther,
              appointment_no: 'GG-CONF123',
              start_at: '2026-10-02T06:00:00.000Z',
              end_at: '2026-10-02T07:00:00.000Z',
              customer_name: 'Existing Client'
            }]
          };
        }
        return { rows: [] };
      }

      if (/^UPDATE appointments SET staff_id = \$1/i.test(normalized)) {
        state.appointmentUpdates.push({ params });
        return {
          rows: [{
            id: params[4],
            shop_id: params[5],
            location_id: params[6],
            staff_id: params[0],
            start_at: params[1],
            end_at: params[2],
            override_conflict: params[3]
          }]
        };
      }

      if (/^UPDATE appointment_items SET start_at = start_at \+/i.test(normalized)) {
        state.itemUpdates.push({ params });
        return { rows: [{ id: 'item-uuid-1' }] };
      }

      if (/^UPDATE appointment_item_staff_assignments a SET staff_id = \$1/i.test(normalized)) {
        state.assignmentUpdates.push({ params });
        return { rows: [{ id: 'assign-uuid-1' }] };
      }

      if (/^INSERT INTO appointment_edit_history/i.test(normalized)) {
        state.auditInserts.push({ params });
        return { rows: [{ id: 'audit-uuid-1', created_at: new Date().toISOString() }] };
      }

      throw new Error(`Unexpected query in mock: ${normalized}`);
    },
    release() {
      state.releases += 1;
    }
  };

  const pool = {
    async query(sql) {
      if (/FROM owner_sessions/i.test(sql)) {
        return { rows: validSession ? [sessionRow(role)] : [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    }
  };

  return { pool, state };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
};

const sendAdjustRequest = (baseUrl, appointmentId, body, { authenticated = true } = {}) =>
  fetch(`${baseUrl}/api/owner/appointments/${appointmentId}/adjust`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { cookie: 'gg_beauty_owner_session=test-owner-token' } : {})
    },
    body: JSON.stringify(body)
  });

const runRequest = async (fixture, appointmentId, body, options) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => sendAdjustRequest(baseUrl, appointmentId, body, options));
};

// =========================================================================
// Unit / Integration Tests for Owner Appointment Edit Phase 1A
// =========================================================================

test('1. unauthenticated request returns 401 before any database mutation', async () => {
  const fixture = makeMockPool();
  const res = await runRequest(
    fixture,
    ID.appointmentA,
    { newDate: '2026-10-02', newTime: '14:30', newStaffId: ID.staffTarget },
    { authenticated: false }
  );
  assert.equal(res.status, 401);
  assert.equal(fixture.state.appointmentUpdates.length, 0);
  assert.equal(fixture.state.auditInserts.length, 0);
});

test('2. tenant isolation: appointment in different shop returns 404', async () => {
  const fixture = makeMockPool({ appointmentShopId: ID.shopB });
  const res = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.code, 'APPOINTMENT_NOT_FOUND');
  assert.equal(fixture.state.appointmentUpdates.length, 0);
});

test('3. status not editable: completed appointment returns 409', async () => {
  const fixture = makeMockPool({ appointmentStatus: 'completed' });
  const res = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'APPOINTMENT_STATUS_NOT_EDITABLE');
});

test('4. disallowed mutation: passing serviceIds or price in Phase 1A returns 400', async () => {
  const fixture = makeMockPool();
  // Trying to pass serviceIds
  const res1 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    serviceIds: [ID.serviceB]
  });
  assert.equal(res1.status, 400);
  const json1 = await res1.json();
  assert.equal(json1.code, 'NO_SERVICE_OR_PRICE_CHANGE_ALLOWED');

  // Trying to pass price
  const res2 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    price: 99.0
  });
  assert.equal(res2.status, 400);
  const json2 = await res2.json();
  assert.equal(json2.code, 'NO_SERVICE_OR_PRICE_CHANGE_ALLOWED');

  assert.equal(fixture.state.appointmentUpdates.length, 0);
});

test('5. staff skill mismatch: hard block with exact bilingual message for owner, manager, front_desk', async () => {
  for (const role of ['owner', 'manager', 'front_desk']) {
    const fixture = makeMockPool({ role, hasSkills: false });
    const res = await runRequest(fixture, ID.appointmentA, {
      newDate: '2026-10-02',
      newTime: '14:30',
      newStaffId: ID.staffUnskilled,
      reassignmentReason: 'Staff change',
      customerNotified: true,
      customerAgreed: true,
      overrideConflict: true, // even if owner passes overrideConflict, MUST still fail!
      conflictReason: 'Try bypass'
    });
    assert.equal(res.status, 422);
    const json = await res.json();
    assert.equal(json.code, 'STAFF_SKILL_MISMATCH');
    assert.equal(json.message, '该员工不会此项目，不能改派');
    assert.equal(json.messageEn, 'This staff member cannot perform this service');
    assert.equal(fixture.state.appointmentUpdates.length, 0);
    assert.equal(fixture.state.auditInserts.length, 0);
  }
});

test('6. staff not working: off-duty returns 422 STAFF_NOT_WORKING', async () => {
  // 6a: day off
  const fixture1 = makeMockPool({ offDutyReason: 'day_off' });
  const res1 = await runRequest(fixture1, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Cover',
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res1.status, 422);
  const json1 = await res1.json();
  assert.equal(json1.code, 'STAFF_NOT_WORKING');

  // 6b: not scheduled
  const fixture2 = makeMockPool({ offDutyReason: 'not_scheduled' });
  const res2 = await runRequest(fixture2, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Cover',
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res2.status, 422);
  const json2 = await res2.json();
  assert.equal(json2.code, 'STAFF_NOT_WORKING');

  // 6c: outside working hours
  const fixture3 = makeMockPool({ offDutyReason: 'outside_hours' });
  const res3 = await runRequest(fixture3, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '23:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Cover',
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res3.status, 422);
  const json3 = await res3.json();
  assert.equal(json3.code, 'STAFF_NOT_WORKING');
});

test('7. specified staff reassignment: reason and customer consent strictly required', async () => {
  const fixture = makeMockPool({ staffSelectionType: 'specific' });

  // Missing reassignmentReason
  const res1 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res1.status, 400);
  const json1 = await res1.json();
  assert.equal(json1.code, 'REASSIGNMENT_REASON_REQUIRED');

  // Missing customer consent
  const res2 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Staff sick',
    customerNotified: false,
    customerAgreed: false
  });
  assert.equal(res2.status, 400);
  const json2 = await res2.json();
  assert.equal(json2.code, 'CUSTOMER_CONSENT_REQUIRED');

  // Both reason and consent provided -> succeeds
  const res3 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Original stylist on leave, customer agreed to senior stylist',
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res3.status, 200);
  assert.equal(fixture.state.auditInserts.length, 1);
  assert.equal(fixture.state.auditInserts[0].params[13], 'Original stylist on leave, customer agreed to senior stylist');
  assert.equal(fixture.state.auditInserts[0].params[16], true); // customer_notified
  assert.equal(fixture.state.auditInserts[0].params[17], true); // customer_agreed
});

test('8. unspecific staff appointment (no_preference): reassigning staff requires no reason', async () => {
  const fixture = makeMockPool({ staffSelectionType: 'no_preference' });
  const res = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(res.status, 200);
  assert.equal(fixture.state.auditInserts.length, 1);
  assert.equal(fixture.state.auditInserts[0].params[13], null); // no reassignment reason needed
});

test('9. front_desk role conflict rules: can save without conflict, strictly blocked with conflict', async () => {
  // 9a: Conflict-free -> front_desk succeeds
  const fixtureClean = makeMockPool({ role: 'front_desk', hasConflict: false, staffSelectionType: 'no_preference' });
  const resClean = await runRequest(fixtureClean, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(resClean.status, 200);
  const jsonClean = await resClean.json();
  assert.equal(jsonClean.data.overrideConflict, false);

  // 9b: With conflict -> front_desk returns 409 canOverride: false
  const fixtureConflict = makeMockPool({ role: 'front_desk', hasConflict: true, staffSelectionType: 'no_preference' });
  const resConflict = await runRequest(fixtureConflict, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    overrideConflict: true, // front_desk cannot override
    conflictReason: 'Front desk forced'
  });
  assert.equal(resConflict.status, 409);
  const jsonConflict = await resConflict.json();
  assert.equal(jsonConflict.code, 'APPOINTMENT_COLLISION');
  assert.equal(jsonConflict.canOverride, false);
  assert.equal(fixtureConflict.state.appointmentUpdates.length, 0);
});

test('10. owner/manager conflict rules: returns 409 canOverride: true when unforced, requires reason when forced', async () => {
  const fixture = makeMockPool({ role: 'owner', hasConflict: true, staffSelectionType: 'no_preference' });

  // 10a: overrideConflict not set -> 409 with canOverride: true and conflict list
  const res1 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(res1.status, 409);
  const json1 = await res1.json();
  assert.equal(json1.code, 'APPOINTMENT_COLLISION');
  assert.equal(json1.canOverride, true);
  assert.equal(Array.isArray(json1.conflicts), true);
  assert.equal(json1.conflicts.length, 1);

  // 10b: overrideConflict true but empty conflictReason -> 400 CONFLICT_REASON_REQUIRED
  const res2 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    overrideConflict: true,
    conflictReason: '   '
  });
  assert.equal(res2.status, 400);
  const json2 = await res2.json();
  assert.equal(json2.code, 'CONFLICT_REASON_REQUIRED');

  // 10c: overrideConflict true and valid reason -> 200 OK, override_conflict = true
  const res3 = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    overrideConflict: true,
    conflictReason: 'Client waiting on sofa during hair drying phase'
  });
  assert.equal(res3.status, 200);
  const json3 = await res3.json();
  assert.equal(json3.data.overrideConflict, true);
  assert.equal(fixture.state.appointmentUpdates.length, 1);
  assert.equal(fixture.state.appointmentUpdates[0].params[3], true); // override_conflict = true
  assert.equal(fixture.state.auditInserts[0].params[14], true); // override_conflict = true
  assert.equal(fixture.state.auditInserts[0].params[15], 'Client waiting on sofa during hair drying phase');
});

test('11. no service or price modification and no checkout writes occur during adjustment', async () => {
  const fixture = makeMockPool({ staffSelectionType: 'no_preference' });
  const res = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget
  });
  assert.equal(res.status, 200);

  // Assert item update does NOT touch service_id, price_snapshot, or duration_minutes_snapshot
  assert.equal(fixture.state.itemUpdates.length, 1);
  const itemUpdateSql = fixture.state.queries.find(q => /UPDATE appointment_items SET start_at/i.test(q.sql)).sql;
  assert.doesNotMatch(itemUpdateSql, /service_id|price_snapshot|duration_minutes_snapshot|service_name_snapshot/);

  // Assert ZERO writes to checkout / payment / pos tables
  assert.equal(fixture.state.checkoutWrites.length, 0);
  const allSql = fixture.state.queries.map(q => q.sql).join('\n');
  assert.doesNotMatch(allSql, /INSERT INTO checkout|UPDATE checkout|DELETE FROM checkout/i);
});

test('12. appointment_edit_history audit record is fully populated', async () => {
  const fixture = makeMockPool({
    role: 'manager',
    staffSelectionType: 'specific',
    hasConflict: false
  });
  const res = await runRequest(fixture, ID.appointmentA, {
    newDate: '2026-10-02',
    newTime: '14:30',
    newStaffId: ID.staffTarget,
    reassignmentReason: 'Customer requested reschedule',
    customerNotified: true,
    customerAgreed: true
  });
  assert.equal(res.status, 200);

  assert.equal(fixture.state.auditInserts.length, 1);
  const auditParams = fixture.state.auditInserts[0].params;
  // Params mapping:
  // $1: shop_id, $2: location_id, $3: appointment_id
  assert.equal(auditParams[0], ID.shopA);
  assert.equal(auditParams[1], ID.locationA);
  assert.equal(auditParams[2], ID.appointmentA);
  // $4: actor_role, $5: actor_id, $6: actor_name
  assert.equal(auditParams[3], 'manager');
  assert.equal(auditParams[4], ID.account);
  assert.equal(auditParams[5], 'Test Admin');
  // $7: old_start_at, $8: new_start_at, $9: old_end_at, $10: new_end_at
  assert.equal(auditParams[6], '2026-10-01T02:00:00.000Z');
  assert.equal(auditParams[7], '2026-10-02T06:30:00.000Z');
  assert.equal(auditParams[8], '2026-10-01T03:00:00.000Z');
  assert.equal(auditParams[9], '2026-10-02T07:30:00.000Z');
  // $11: old_staff_id, $12: new_staff_id
  assert.equal(auditParams[10], ID.staffOriginal);
  assert.equal(auditParams[11], ID.staffTarget);
  // $13: items_snapshot (JSON)
  const snapshot = JSON.parse(auditParams[12]);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].serviceName, 'Signature Haircut');
  assert.equal(snapshot[0].price, '88.00');
  // $14: reassignment_reason
  assert.equal(auditParams[13], 'Customer requested reschedule');
  // $15: override_conflict, $16: conflict_reason
  assert.equal(auditParams[14], false);
  assert.equal(auditParams[15], null);
  // $17: customer_notified, $18: customer_agreed
  assert.equal(auditParams[16], true);
  assert.equal(auditParams[17], true);
});

// =========================================================================
// PostgreSQL 17 Migration Test Suite (Ephemeral Instance)
// =========================================================================

async function connectPg(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const db = new Client({ connectionString: url });
    try {
      await db.connect();
      return db;
    } catch (error) {
      lastError = error;
      await db.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function withEphemeralPg(t, callback) {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    return t.skip('PostgreSQL 17 unavailable');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-edit-audit-058-'));
  const data = path.join(temp, 'data');
  const port = 58200 + Math.floor(Math.random() * 100);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  let db;

  try {
    db = await connectPg(`postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`);
    // Setup prerequisite schema required by 057
    await db.query(`
      CREATE EXTENSION pgcrypto;
      CREATE TABLE public.shops (id uuid PRIMARY KEY);
      CREATE TABLE public.locations (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id, id));
      CREATE TABLE public.staff (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id, id));
      CREATE TABLE public.appointments (id uuid PRIMARY KEY, shop_id uuid NOT NULL, UNIQUE(shop_id, id));
      CREATE TABLE public.appointment_items (id uuid PRIMARY KEY, shop_id uuid NOT NULL, appointment_id uuid NOT NULL);
      CREATE TABLE public.appointment_item_staff_assignments (id uuid PRIMARY KEY, shop_id uuid NOT NULL, appointment_item_id uuid NOT NULL);
    `);
    await callback(db);
  } finally {
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('13. migration 057 preflight, 058 schema, 059 verification, idempotency, and 058 rollback', { timeout: 120000 }, async t => {
  const sql057 = fs.readFileSync(path.join(ROOT, 'migrations/057_appointment_edit_history_preflight_readonly.sql'), 'utf8');
  const sql058 = fs.readFileSync(path.join(ROOT, 'migrations/058_appointment_edit_history_schema.sql'), 'utf8');
  const sql059 = fs.readFileSync(path.join(ROOT, 'migrations/059_appointment_edit_history_verification_readonly.sql'), 'utf8');
  const sql058Rollback = fs.readFileSync(path.join(ROOT, 'migrations/rollback/058_appointment_edit_history_rollback.sql'), 'utf8');

  await withEphemeralPg(t, async db => {
    // 1. Preflight should pass
    await db.query(sql057);

    // 2. Schema migration should succeed
    await db.query(sql058);

    // 3. Verification should pass
    await db.query(sql059);

    // 4. Schema idempotency (running 058 again should not error)
    await db.query(sql058);
    await db.query(sql059);

    // 5. Test constraint enforcement on appointment_edit_history
    const shopResult = await db.query(`INSERT INTO public.shops (id) VALUES (gen_random_uuid()) RETURNING id`);
    const shopId = shopResult.rows[0].id;
    await db.query(`INSERT INTO public.locations (id, shop_id) VALUES ('${ID.locationA}', '${shopId}')`);
    await db.query(`INSERT INTO public.staff (id, shop_id) VALUES ('${ID.staffOriginal}', '${shopId}'), ('${ID.staffTarget}', '${shopId}')`);
    await db.query(`INSERT INTO public.appointments (id, shop_id) VALUES ('${ID.appointmentA}', '${shopId}')`);

    // Valid insert
    await db.query(`
      INSERT INTO public.appointment_edit_history (
        shop_id, location_id, appointment_id,
        actor_role, actor_id, actor_name,
        old_start_at, new_start_at, old_end_at, new_end_at,
        old_staff_id, new_staff_id,
        items_snapshot, override_conflict, conflict_reason
      ) VALUES (
        '${shopId}', '${ID.locationA}', '${ID.appointmentA}',
        'owner', '${ID.account}', 'Owner',
        '2026-10-01 10:00Z', '2026-10-02 10:00Z', '2026-10-01 11:00Z', '2026-10-02 11:00Z',
        '${ID.staffOriginal}', '${ID.staffTarget}',
        '[]'::jsonb, true, 'Valid reason'
      )
    `);

    // Violate duration preservation check -> must reject
    await assert.rejects(
      db.query(`
        INSERT INTO public.appointment_edit_history (
          shop_id, location_id, appointment_id,
          actor_role, actor_id, actor_name,
          old_start_at, new_start_at, old_end_at, new_end_at,
          old_staff_id, new_staff_id
        ) VALUES (
          '${shopId}', '${ID.locationA}', '${ID.appointmentA}',
          'owner', '${ID.account}', 'Owner',
          '2026-10-01 10:00Z', '2026-10-02 10:00Z', '2026-10-01 11:00Z', '2026-10-02 12:00Z',
          '${ID.staffOriginal}', '${ID.staffTarget}'
        )
      `),
      /appointment_edit_history_duration_preserved_check/
    );

    // Violate conflict reason check (override_conflict = true but conflict_reason is NULL) -> must reject
    await assert.rejects(
      db.query(`
        INSERT INTO public.appointment_edit_history (
          shop_id, location_id, appointment_id,
          actor_role, actor_id, actor_name,
          old_start_at, new_start_at, old_end_at, new_end_at,
          old_staff_id, new_staff_id,
          override_conflict, conflict_reason
        ) VALUES (
          '${shopId}', '${ID.locationA}', '${ID.appointmentA}',
          'owner', '${ID.account}', 'Owner',
          '2026-10-01 10:00Z', '2026-10-02 10:00Z', '2026-10-01 11:00Z', '2026-10-02 11:00Z',
          '${ID.staffOriginal}', '${ID.staffTarget}',
          true, null
        )
      `),
      /appointment_edit_history_conflict_reason_check/
    );

    // 6. Rollback should succeed
    await db.query(sql058Rollback);

    // Verify table dropped
    const tableExists = await db.query(`SELECT to_regclass('public.appointment_edit_history') IS NOT NULL AS exists`);
    assert.equal(tableExists.rows[0].exists, false);

    // Preflight passes again after rollback
    await db.query(sql057);
  });
});
