'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOwnerAppointmentServiceAddon } = require('../lib/owner-appointment-service-addon');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const addonSource = read('lib/owner-appointment-service-addon.js');
const serverSource = read('server.js');
const adminSource = read('public/admin.html');
const preflight = read('migrations/087_appointment_item_mutation_commands_preflight_readonly.sql');
const forward = read('migrations/088_appointment_item_mutation_commands_schema.sql');
const verify = read('migrations/089_appointment_item_mutation_commands_verification_readonly.sql');
const rollback = read('migrations/rollback/088_appointment_item_mutation_commands_rollback.sql');
const i18n = require('../public/shared-i18n');

const isUuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
class BookabilityError extends Error {}
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('migration chain is staged, read-only at the edges, tenant-safe and append-only', () => {
  for (const sql of [preflight, verify]) {
    assert.match(sql, /BEGIN TRANSACTION READ ONLY/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  }
  assert.match(forward, /CREATE TABLE public\.appointment_item_mutation_commands/);
  assert.match(forward, /UNIQUE \(shop_id, idempotency_key\)/);
  assert.match(forward, /CHECK \(idempotency_key ~ '\^\[A-Za-z0-9_-\]\{16,128\}\$'\)/);
  assert.match(forward, /CHECK \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(forward, /FOREIGN KEY \(shop_id, location_id, appointment_item_id\)/);
  assert.match(forward, /FOREIGN KEY \(appointment_item_id, appointment_id\)/);
  assert.match(forward, /FOREIGN KEY \(shop_id, staff_id, location_id\)/);
  assert.match(forward, /FOREIGN KEY \(shop_id, operator_membership_id\)/);
  assert.equal((forward.match(/ON DELETE RESTRICT/g) || []).length, 4);
  assert.doesNotMatch(forward, /ON DELETE CASCADE/i);
  assert.match(forward, /BEFORE UPDATE OR DELETE/);
  assert.match(rollback, /rollback refused: audit rows exist/);
  const rollbackLock = rollback.indexOf('LOCK TABLE public.appointment_item_mutation_commands');
  const rollbackEmptyCheck = rollback.indexOf('IF EXISTS (SELECT 1 FROM public.appointment_item_mutation_commands)');
  assert.ok(rollbackLock >= 0 && rollbackEmptyCheck > rollbackLock);
  assert.match(rollback, /LOCK TABLE public\.appointment_item_mutation_commands\s+IN ACCESS EXCLUSIVE MODE/);
  assert.doesNotMatch(forward, /service_locale_snapshot/);
  assert.match(forward, /price_snapshot NUMERIC NOT NULL/);
});

test('API route and command transaction preserve authority and lock order', () => {
  assert.match(serverSource, /app\.get\([\s\S]*?'\/api\/owner\/appointments\/:appointmentId\/service-addons\/options'[\s\S]*?ownerAppointmentServiceAddon\.listOptions/);
  assert.match(serverSource, /app\.get\([\s\S]*?'\/api\/owner\/appointments\/:appointmentId\/service-addons\/staff-options'[\s\S]*?ownerAppointmentServiceAddon\.listStaffOptions/);
  assert.match(serverSource, /app\.post\([\s\S]*?'\/api\/owner\/appointments\/:appointmentId\/service-addons'[\s\S]*?requireOwnerRole\(\['owner', 'manager', 'admin', 'front_desk'\]\)[\s\S]*?ownerAppointmentServiceAddon\.addService/);
  const appointmentLock = addonSource.indexOf('FROM appointments');
  const idempotencyRead = addonSource.indexOf('FROM appointment_item_mutation_commands', appointmentLock);
  const checkoutRead = addonSource.indexOf('FROM checkout_transactions', idempotencyRead);
  const itemLock = addonSource.indexOf('FROM appointment_items', checkoutRead);
  const capabilityLock = addonSource.indexOf('FROM staff_services', itemLock);
  const itemInsert = addonSource.indexOf('INSERT INTO appointment_items', capabilityLock);
  const assignmentInsert = addonSource.indexOf('INSERT INTO appointment_item_staff_assignments', itemInsert);
  const parentUpdate = addonSource.indexOf('UPDATE appointments SET end_at', assignmentInsert);
  const auditInsert = addonSource.indexOf('INSERT INTO appointment_item_mutation_commands', parentUpdate);
  assert.ok([appointmentLock, idempotencyRead, checkoutRead, itemLock, capabilityLock, itemInsert, assignmentInsert, parentUpdate, auditInsert].every(index => index >= 0));
  assert.deepEqual([...new Set([appointmentLock, idempotencyRead, checkoutRead, itemLock, capabilityLock, itemInsert, assignmentInsert, parentUpdate, auditInsert].sort((a, b) => a - b))],
    [appointmentLock, idempotencyRead, checkoutRead, itemLock, capabilityLock, itemInsert, assignmentInsert, parentUpdate, auditInsert]);
  assert.match(addonSource, /FOR UPDATE/);
  assert.match(addonSource, /FOR SHARE/);
  assert.match(addonSource, /'manual_add'/);
  assert.match(addonSource, /assignment\.role='primary'/);
  assert.doesNotMatch(addonSource, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?checkout_/i);
  assert.doesNotMatch(addonSource, /customer_phone|phone_e164|membership_sale|commission/i);
});

test('strict body rejects client price, duration, fingerprint and numeric idempotency keys before opening a transaction', async () => {
  const pool = { async connect() { assert.fail('invalid request must not connect to PostgreSQL'); } };
  const handler = createOwnerAppointmentServiceAddon({ pool, crypto, isUuid, validator: async () => {}, StaffBookabilityError: BookabilityError });
  const base = {
    params: { appointmentId: '11111111-1111-4111-8111-111111111111' },
    ownerAuth: { shopId: '22222222-2222-4222-8222-222222222222', membershipId: '33333333-3333-4333-8333-333333333333', role: 'owner' },
    body: { serviceId: '44444444-4444-4444-8444-444444444444', staffId: '55555555-5555-4555-8555-555555555555', idempotencyKey: 'addon_0123456789abcdef', locale: 'en' }
  };
  for (const extra of [
    { price: 0 },
    { durationMinutes: 1 },
    { requestFingerprint: '0'.repeat(64) },
    { idempotencyKey: 1234567890123456 }
  ]) {
    const res = response();
    await handler.addService({ ...base, body: { ...base.body, ...extra } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_REQUEST');
  }
  const denied = response();
  await handler.addService({ ...base, ownerAuth: { ...base.ownerAuth, role: 'staff' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
});

test('owner UI has a compact authoritative flow and complete Chinese/English errors', () => {
  assert.match(adminSource, /\['arrived', 'in_service'\]\.includes\(canonicalStatus\)/);
  assert.match(adminSource, /service-addons\/options\?locale=/);
  assert.match(adminSource, /service-addons\/staff-options\?serviceId=/);
  assert.doesNotMatch(adminSource, /fetch\('\/api\/owner\/services'/);
  assert.doesNotMatch(adminSource, /\/api\/owner\/staff\/\$\{encodeURIComponent\(member\.id\)\}\/services/);
  assert.match(adminSource, /filterServiceAddonServices\(services, searchInput\.value, categorySelect\.value\)/);
  assert.match(adminSource, /if \(submitting \|\| !serviceSelect\.value \|\| !staffSelect\.value\) return/);
  assert.match(adminSource, /const idempotencyKey = createServiceAddonKey\(\)/);
  assert.match(adminSource, /await loadAppointments\(currentRequestedLocationId\)/);
  assert.match(adminSource, /min-height:\s*44px/);
  for (const key of [
    'activeAddService', 'chooseService', 'chooseStaff', 'confirmAddService',
    'serviceAddonStatusChanged', 'serviceAddonCheckoutExists', 'serviceAddonServiceInactive', 'serviceAddonUnavailable',
    'serviceAddonStaffUnavailable', 'serviceAddonNotCapable', 'serviceAddonConflict',
    'serviceAddonPermissionDenied', 'serviceAddonIdempotencyConflict', 'serviceAddonConcurrent'
  ]) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.notEqual(zh, key);
    assert.notEqual(en, key);
    assert.doesNotMatch(zh, /[A-Za-z]{3,}/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/);
  }
  assert.equal(i18n.t('serviceAddonServiceInactive', 'zh-CN'), '该服务已停用');
  assert.equal(i18n.t('serviceAddonServiceInactive', 'en'), 'This service is unavailable.');
  assert.equal(i18n.t('serviceAddonNotCapable', 'zh-CN'), '该员工不能提供此服务');
  assert.equal(i18n.t('serviceAddonNotCapable', 'en'), 'This staff member cannot perform this service.');
});
