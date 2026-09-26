'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');

const ID = { shopA: '33333333-3333-4333-8333-333333333333', shopB: '44444444-4444-4444-8444-444444444444', appointment: '77777777-7777-4777-8777-777777777777' };
const session = role => ({ owner_account_id: '11111111-1111-4111-8111-111111111111', membership_id: '22222222-2222-4222-8222-222222222222', shop_id: ID.shopA, login_identifier: 'owner', display_name: 'Owner', role, shop_slug: 'shop-a', shop_name: 'Shop A' });

const pool = ({ role = 'owner', exists = true } = {}) => {
  const state = { writes: [] };
  return { state, query: async (sql, params = []) => {
    if (/FROM owner_sessions/.test(sql)) return { rows: [session(role)] };
    if (/UPDATE appointments/.test(sql)) { state.writes.push({ sql, params }); return { rows: exists ? [{ id: ID.appointment, internal_notes: params[0], updated_at: '2030-01-01T00:00:00.000Z' }] : [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  }};
};

const request = async (fixture, body, id = ID.appointment) => {
  app.locals.ownerAuthPool = fixture;
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/owner/appointments/${id}/internal-notes`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: 'gg_beauty_owner_session=token' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
};

test('authorized owner saves tenant-scoped internal notes without status or checkout writes', async () => {
  const fixture = pool(); const result = await request(fixture, { internalNotes: 'VIP: avoid lavender' });
  assert.equal(result.status, 200); assert.equal(result.json.data.internalNotes, 'VIP: avoid lavender');
  assert.equal(fixture.state.writes.length, 1); assert.match(fixture.state.writes[0].sql, /WHERE id = \$2 AND shop_id = \$3/);
  assert.deepEqual(fixture.state.writes[0].params, ['VIP: avoid lavender', ID.appointment, ID.shopA]);
  assert.doesNotMatch(fixture.state.writes[0].sql, /status|checkout|payment/i);
});
test('authorized manager can save internal notes', async () => {
  const fixture = pool({ role: 'manager' }); const result = await request(fixture, { internalNotes: 'Manager note' });
  assert.equal(result.status, 200); assert.equal(result.json.data.internalNotes, 'Manager note');
  assert.equal(fixture.state.writes.length, 1);
});
test('admin, front_desk, and unauthenticated callers cannot save internal notes', async () => {
  const admin = pool({ role: 'admin' }); assert.equal((await request(admin, { internalNotes: 'x' })).status, 403); assert.equal(admin.state.writes.length, 0);
  const frontDesk = pool({ role: 'front_desk' }); assert.equal((await request(frontDesk, { internalNotes: 'x' })).status, 403); assert.equal(frontDesk.state.writes.length, 0);
  app.locals.ownerAuthPool = pool();
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, resolve));
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/owner/appointments/${ID.appointment}/internal-notes`, { method: 'PATCH' })).status, 401); } finally { await new Promise(resolve => server.close(resolve)); }
});
test('cross-shop appointment and invalid note payload fail without a write', async () => {
  const missing = pool({ exists: false }); assert.equal((await request(missing, { internalNotes: 'x' })).status, 404); assert.equal(missing.state.writes.length, 1);
  const invalid = pool(); assert.equal((await request(invalid, { internalNotes: 42 })).status, 400); assert.equal(invalid.state.writes.length, 0);
});

test('migration chain adds a separate bounded internal_notes column with a read-only verifier and data-safe rollback', () => {
  const root = path.resolve(__dirname, '..', 'migrations');
  const schema = fs.readFileSync(path.join(root, '064_appointment_internal_notes_schema.sql'), 'utf8');
  const verify = fs.readFileSync(path.join(root, '065_appointment_internal_notes_verification_readonly.sql'), 'utf8');
  const rollback = fs.readFileSync(path.join(root, 'rollback', '064_appointment_internal_notes_rollback.sql'), 'utf8');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS internal_notes TEXT NULL/);
  assert.match(schema, /char_length\(internal_notes\) <= 4000/);
  assert.match(verify, /^BEGIN TRANSACTION READ ONLY;/);
  assert.doesNotMatch(verify, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(rollback, /WHERE internal_notes IS NOT NULL/);
  assert.match(rollback, /RAISE EXCEPTION/);
  assert.match(rollback, /DROP CONSTRAINT IF EXISTS appointments_internal_notes_length_check/);
  assert.match(rollback, /DROP COLUMN IF EXISTS internal_notes/);
  assert.match(rollback, /lock_timeout/);
});
