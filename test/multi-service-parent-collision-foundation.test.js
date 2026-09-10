'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadAndValidatePhaseAStructure,
  AppointmentMutationError
} = require('../lib/appointment-multi-service');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const appointment = {
  id: '33333333-3333-4333-8333-333333333333',
  shop_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  staff_id: '44444444-4444-4444-8444-444444444444'
};

const phaseClient = row => ({
  calls: [],
  async query(sql) {
    this.calls.push(sql);
    if (/SELECT id\s+FROM appointment_items/.test(sql)) return { rows: [{ id: 'item' }] };
    if (/SELECT assignment\.id/.test(sql)) return { rows: [] };
    return { rows: [row] };
  }
});

test('Phase A accepts multi-item different primary staff and assistants', async () => {
  const client = phaseClient({ item_count: 2, assignment_count: 3, primary_staff_count: 2, structure_valid: true });
  const result = await loadAndValidatePhaseAStructure(client, appointment);
  assert.deepEqual(result, { itemCount: 2, assignmentCount: 3, primaryStaffCount: 2, solePrimaryStaffId: undefined });
  const sql = client.calls[2];
  assert.match(sql, /assignment_count >= 1/);
  assert.match(sql, /primary_count = 1/);
  assert.match(sql, /assignment\.role IN \('primary', 'assistant'\)/);
  assert.doesNotMatch(sql, /assistant_count = 0/);
});

test('Phase A fails closed for missing/two primary, time, or tenant mismatch result', async () => {
  const client = phaseClient({ item_count: 2, assignment_count: 2, primary_staff_count: 1, structure_valid: false });
  await assert.rejects(
    loadAndValidatePhaseAStructure(client, appointment),
    error => error instanceof AppointmentMutationError && error.code === 'phase_a_structure_invalid'
  );
});

test('single-item parent/primary compatibility remains explicit', () => {
  const source = read('lib/appointment-multi-service.js');
  assert.match(source, /item_validation\.item_count <> 1/);
  assert.match(source, /sole_primary_staff_id =\s*\(SELECT staff_id FROM parent\)/);
});

test('staff read model includes any canonical primary or assistant assignment', () => {
  const source = read('server.js');
  assert.match(source, /EXISTS \(\s*SELECT 1\s*FROM appointment_items item\s*JOIN appointment_item_staff_assignments assignment/);
  assert.match(source, /assignment\.staff_id = scope\.staff_id/);
});

test('owner read model exposes canonical per-item assignment truth', () => {
  const source = read('server.js');
  assert.match(source, /AS staff_assignments/);
  assert.match(source, /'sequenceNo', item\.sequence_no/);
  assert.match(source, /'role', assignment\.role/);
});

test('staff whole move fails closed for multiple primary staff', () => {
  const source = read('server.js');
  assert.match(source, /JOIN appointment_item_staff_assignments participant_assignment/);
  assert.match(source, /participant_assignment\.staff_id = \$3/);
  assert.doesNotMatch(source, /WHERE id = \$1\s+AND shop_id = \$2\s+AND staff_id = \$3\s+AND location_id = \$4/);
  assert.match(source, /phaseAStructure\.primaryStaffCount !== 1/);
  assert.match(source, /phaseAStructure\.solePrimaryStaffId !==\s*req\.staffAuth\.staffId/);
  assert.match(source, /多员工预约不能由员工移动整笔时间/);
  assert.match(source, /for \(const assignment of moveAssignments\.rows\)/);
  assert.match(source, /excludeAppointmentId: appointment\.id/);
});

test('legacy customer write remains atomic parent plus item plus primary assignment', () => {
  const server = read('server.js');
  const helper = read('lib/appointment-multi-service.js');
  assert.match(server, /runInTransaction\([\s\S]*INSERT INTO appointments[\s\S]*createSingleServiceCompatibilityRows/);
  assert.match(helper, /INSERT INTO appointment_items/);
  assert.match(helper, /INSERT INTO appointment_item_staff_assignments/);
  assert.match(helper, /'primary'/);
});

test('025 is read-only and fail-closed across canonical invariants', () => {
  const sql = read('migrations/025_multi_service_parent_collision_preflight_readonly.sql');
  assert.match(sql, /BEGIN TRANSACTION READ ONLY/);
  assert.match(sql, /Parent-only appointment detected/);
  assert.match(sql, /Item primary count invalid/);
  assert.match(sql, /Parent span mismatch/);
  assert.match(sql, /Blocking assignment overlap detected/);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
});

test('026 hardens only the consistency function/parent trigger and drops the exact parent exclusion', () => {
  const sql = read('migrations/026_multi_service_parent_collision_compatibility.sql');
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /lock_timeout='5s'/);
  assert.match(sql, /statement_timeout='30s'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.assignment_collision_consistency_check\(\)/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER assignment_collision_parent_consistency_trigger/);
  assert.match(sql, /AFTER INSERT OR UPDATE ON public\.appointments/);
  assert.match(sql, /ALTER TABLE public\.appointments DROP CONSTRAINT prevent_staff_double_booking/);
  assert.doesNotMatch(sql, /DROP COLUMN|DROP INDEX|UPDATE\s+public|INSERT INTO|DELETE FROM/i);
  assert.equal((sql.match(/ALTER TABLE public\.appointments DROP CONSTRAINT/g) || []).length, 1);
});

test('027 verifies assignment authority and legacy compatibility read-only', () => {
  const sql = read('migrations/027_multi_service_parent_collision_verification_readonly.sql');
  assert.match(sql, /BEGIN TRANSACTION READ ONLY/);
  assert.match(sql, /Parent full-span collision constraint still exists/);
  assert.match(sql, /Single-item parent primary compatibility mismatch/);
  assert.match(sql, /Blocking assignment overlap detected/);
  assert.doesNotMatch(sql, /previous_end_at|start_at IS DISTINCT FROM previous_end_at/);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
});

test('022 tenant FK preflight is read-only and fail-closed', () => {
  const sql = read('migrations/022_appointments_staff_tenant_fk_preflight_readonly.sql');
  assert.match(sql,/BEGIN TRANSACTION READ ONLY/);
  assert.match(sql,/appointments_staff_id_fkey/);
  assert.match(sql,/staff_shop_id_id_uidx/);
  assert.match(sql,/Cross-shop appointment staff link detected/);
  assert.doesNotMatch(sql,/^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
});

test('023 tenant FK repair validates composite before dropping legacy', () => {
  const sql = read('migrations/023_appointments_staff_tenant_fk_repair.sql');
  assert.match(sql,/BEGIN;[\s\S]*lock_timeout='5s'[\s\S]*statement_timeout='30s'/);
  const add=sql.indexOf('ADD CONSTRAINT appointments_staff_tenant_safe_fkey');
  const validate=sql.indexOf('VALIDATE CONSTRAINT appointments_staff_tenant_safe_fkey');
  const drop=sql.indexOf('DROP CONSTRAINT appointments_staff_id_fkey');
  const rename=sql.indexOf('RENAME CONSTRAINT appointments_staff_tenant_safe_fkey TO appointments_staff_id_fkey');
  assert.ok(add<validate && validate<drop && drop<rename);
  assert.doesNotMatch(sql,/UPDATE\s+(?:public\.)?appointments|INSERT INTO|DELETE FROM|DROP COLUMN/i);
});

test('024 tenant FK verification is read-only and exact', () => {
  const sql = read('migrations/024_appointments_staff_tenant_fk_verification_readonly.sql');
  assert.match(sql,/BEGIN TRANSACTION READ ONLY/);
  assert.match(sql,/FOREIGN KEY \(shop_id, staff_id\) REFERENCES staff\(shop_id, id\) ON DELETE RESTRICT/);
  assert.match(sql,/Legacy single-column appointments staff FK still exists/);
  assert.doesNotMatch(sql,/^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
});
