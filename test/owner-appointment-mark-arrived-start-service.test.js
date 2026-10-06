'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { app } = require('../server');
const { createCheckoutPos, ALLOWED_CHECKOUT_STATUSES } = require('../lib/checkout-pos');
const checkoutAdapter = require('../public/checkout-ui-adapter');
const i18n = require('../public/shared-i18n');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shop: '33333333-3333-4333-8333-333333333333',
  otherShop: '44444444-4444-4444-8444-444444444444',
  location: '55555555-5555-4555-8555-555555555555',
  appointment: '66666666-6666-4666-8666-666666666666',
  service: '77777777-7777-4777-8777-777777777777',
  staff: '88888888-8888-4888-8888-888888888888'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shop,
  login_identifier: 'OwnerOne',
  display_name: 'Owner One',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const makePool = ({ role = 'owner', validSession = true, tenant = ID.shop, status = 'confirmed' } = {}) => {
  const state = {
    parentStatus: status,
    itemStatuses: [status, status],
    history: [],
    queries: [],
    committed: false,
    rolledBack: false,
    snapshot: null
  };
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.queries.push({ sql: normalized, params });
      if (normalized === 'BEGIN') {
        state.snapshot = {
          parentStatus: state.parentStatus,
          itemStatuses: [...state.itemStatuses],
          history: [...state.history]
        };
        return { rows: [] };
      }
      if (normalized === 'COMMIT') { state.committed = true; return { rows: [] }; }
      if (normalized === 'ROLLBACK') {
        state.parentStatus = state.snapshot.parentStatus;
        state.itemStatuses = [...state.snapshot.itemStatuses];
        state.history = [...state.snapshot.history];
        state.rolledBack = true;
        return { rows: [] };
      }
      if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
      if (/FROM appointments WHERE id = \$1 AND shop_id = \$2 FOR UPDATE$/.test(normalized)) {
        return { rows: params[0] === ID.appointment && params[1] === tenant ? [{
          id: ID.appointment,
          shop_id: ID.shop,
          location_id: ID.location,
          service_id: ID.service,
          staff_id: ID.staff,
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          status: state.parentStatus,
          updated_at: '2030-01-01T00:00:00.000Z'
        }] : [] };
      }
      if (normalized.startsWith('SELECT id FROM appointment_items')) {
        return { rows: [{ id: 'item-1' }, { id: 'item-2' }] };
      }
      if (normalized.startsWith('SELECT assignment.id')) {
        return { rows: [{ id: 'assignment-1' }, { id: 'assignment-2' }] };
      }
      if (normalized.startsWith('WITH parent AS')) {
        return { rows: [{ item_count: 2, assignment_count: 2, structure_valid: true }] };
      }
      if (normalized.startsWith('UPDATE appointments')) {
        assert.equal(params[4], state.parentStatus);
        state.parentStatus = params[0];
        return { rows: [{
          id: ID.appointment,
          status: state.parentStatus,
          start_at: '2030-01-01T02:00:00.000Z',
          end_at: '2030-01-01T03:00:00.000Z',
          updated_at: '2030-01-01T00:01:00.000Z'
        }] };
      }
      if (normalized.startsWith('UPDATE appointment_items')) {
        state.itemStatuses = [params[3], params[3]];
        return { rows: [{ id: 'item-1' }, { id: 'item-2' }] };
      }
      if (normalized.startsWith('INSERT INTO appointment_status_history')) {
        state.history.push([params[2], params[3], params[4], params[5], params[6]]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {}
  };
  return {
    state,
    pool: {
      async query(sql) {
        if (/FROM owner_sessions/.test(sql)) return { rows: validSession ? [sessionRow(role)] : [] };
        throw new Error(`Unexpected pool SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
      },
      async connect() { return client; }
    }
  };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

const sendPost = (action, fixture, { authenticated = true } = {}) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => fetch(`${baseUrl}/api/owner/appointments/${ID.appointment}/${action}`, {
    method: 'POST',
    headers: authenticated ? { cookie: 'gg_beauty_owner_session=raw-owner-token' } : {}
  }));
};

// ---------------------------------------------------------------------
// GATE 1: Server Endpoints (mark-arrived & start-service)
// ---------------------------------------------------------------------

test('Gate 1 - mark-arrived: pending -> confirmed -> arrived atomically', async () => {
  const fixture = makePool({ role: 'owner', status: 'pending' });
  const response = await sendPost('mark-arrived', fixture);
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'arrived');
  assert.deepEqual(fixture.state.itemStatuses, ['arrived', 'arrived']);
  assert.deepEqual(fixture.state.history.map(edge => edge.slice(0, 2)), [
    ['pending', 'confirmed'],
    ['confirmed', 'arrived']
  ]);
  assert.equal(fixture.state.committed, true);
});

test('Gate 1 - mark-arrived: confirmed -> arrived', async () => {
  const fixture = makePool({ role: 'front_desk', status: 'confirmed' });
  const response = await sendPost('mark-arrived', fixture);
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'arrived');
  assert.deepEqual(fixture.state.history.map(edge => edge.slice(0, 2)), [
    ['confirmed', 'arrived']
  ]);
  assert.equal(fixture.state.committed, true);
});

test('Gate 1 - mark-arrived: idempotent for already arrived', async () => {
  const fixture = makePool({ role: 'manager', status: 'arrived' });
  const response = await sendPost('mark-arrived', fixture);
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'arrived');
  assert.equal(fixture.state.history.length, 0);
});

test('Gate 1 - mark-arrived: rejects illegal statuses with 409', async () => {
  for (const illegalStatus of ['in_service', 'completed', 'cancelled', 'no_show']) {
    const fixture = makePool({ role: 'owner', status: illegalStatus });
    const response = await sendPost('mark-arrived', fixture);
    assert.equal(response.status, 409, `Expected 409 for mark-arrived on status ${illegalStatus}`);
    assert.equal(fixture.state.rolledBack, true);
  }
});

test('Gate 1 - start-service: arrived -> in_service', async () => {
  const fixture = makePool({ role: 'owner', status: 'arrived' });
  const response = await sendPost('start-service', fixture);
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'in_service');
  assert.deepEqual(fixture.state.itemStatuses, ['in_service', 'in_service']);
  assert.deepEqual(fixture.state.history.map(edge => edge.slice(0, 2)), [
    ['arrived', 'in_service']
  ]);
  assert.equal(fixture.state.committed, true);
});

test('Gate 1 - start-service: idempotent for already in_service', async () => {
  const fixture = makePool({ role: 'admin', status: 'in_service' });
  const response = await sendPost('start-service', fixture);
  assert.equal(response.status, 200);
  assert.equal(fixture.state.parentStatus, 'in_service');
  assert.equal(fixture.state.history.length, 0);
});

test('Gate 1 - start-service: strictly rejects non-arrived statuses with 409', async () => {
  for (const nonArrivedStatus of ['pending', 'confirmed', 'completed', 'cancelled', 'no_show']) {
    const fixture = makePool({ role: 'owner', status: nonArrivedStatus });
    const response = await sendPost('start-service', fixture);
    assert.equal(response.status, 409, `Expected 409 for start-service on status ${nonArrivedStatus}`);
    assert.equal(fixture.state.rolledBack, true);
  }
});

test('Gate 1 - role security: front_desk allowed, ordinary staff rejected', async () => {
  const fdFixture = makePool({ role: 'front_desk', status: 'arrived' });
  const fdRes = await sendPost('start-service', fdFixture);
  assert.equal(fdRes.status, 200);

  const staffFixture = makePool({ role: 'staff', status: 'arrived' });
  const staffRes = await sendPost('start-service', staffFixture);
  assert.equal(staffRes.status, 403);
});

// ---------------------------------------------------------------------
// GATE 2: Prohibit checkout network failure mock success
// ---------------------------------------------------------------------

test('Gate 2 - submitCheckout fails closed on network rejection and never returns mock success or REC-MOCK receipt', async () => {
  const session = checkoutAdapter.getMockFixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('TypeError: fetch failed (network dropped)');
    };

    await assert.rejects(
      async () => {
        await checkoutAdapter.submitCheckout(session);
      },
      (err) => {
        assert.match(err.message, /fetch failed/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gate 2 - submitCheckout fails closed on HTTP 500/409 server errors without fallback receipt', async () => {
  const session = checkoutAdapter.getMockFixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Database connection failed'
      })
    });

    await assert.rejects(
      async () => {
        await checkoutAdapter.submitCheckout(session);
      },
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.code, 'INTERNAL_SERVER_ERROR');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gate 2 - source code audit: zero mock receipt generation in submitCheckout', () => {
  const adapterSource = fs.readFileSync(path.join(__dirname, '../public/checkout-ui-adapter.js'), 'utf8');
  const submitFnMatch = adapterSource.match(/async function submitCheckout\([\s\S]*?\n  \}/);
  assert.ok(submitFnMatch, 'submitCheckout must exist in checkout-ui-adapter.js');
  const submitFnBody = submitFnMatch[0];
  assert.doesNotMatch(submitFnBody, /REC-MOCK/);
  assert.doesNotMatch(submitFnBody, /isMockReceipt/);
  assert.doesNotMatch(submitFnBody, /chk_mock/);
});

// ---------------------------------------------------------------------
// GATE 3: Server-side appointment status validation in checkout API
// ---------------------------------------------------------------------

test('Gate 3 - ALLOWED_CHECKOUT_STATUSES contains exactly arrived, in_service, completed', () => {
  assert.deepEqual(
    Array.from(ALLOWED_CHECKOUT_STATUSES).sort(),
    ['arrived', 'completed', 'in_service']
  );
  assert.equal(ALLOWED_CHECKOUT_STATUSES.has('pending'), false);
  assert.equal(ALLOWED_CHECKOUT_STATUSES.has('confirmed'), false);
  assert.equal(ALLOWED_CHECKOUT_STATUSES.has('cancelled'), false);
  assert.equal(ALLOWED_CHECKOUT_STATUSES.has('no_show'), false);
  assert.equal(ALLOWED_CHECKOUT_STATUSES.has('void'), false);
});

test('Gate 3 - same appointment_id + same idempotency_key safely replays original checkout', async () => {
  const existingTx = {
    id: 'chk-orig-123456',
    appointment_id: ID.appointment,
    status: 'paid',
    final_due_minor: 5000,
    paid_minor: 5000
  };
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appointment, shop_id: ID.shop, status: 'in_service', customer_id: 'cust-1' }] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const req = {
    params: { appointmentId: ID.appointment },
    body: { idempotencyKey: 'valid_key_0123456789' },
    ownerAuth: { shopId: ID.shop, ownerAccountId: ID.account }
  };
  let resStatus = 200;
  let resBody = null;
  const res = {
    status(n) { resStatus = n; return this; },
    json(v) { resBody = v; return this; }
  };
  await createCheckoutPos({ pool: { connect: async () => client } }).create(req, res);
  assert.equal(resStatus, 200);
  assert.equal(resBody.success, true);
  assert.equal(resBody.idempotent, true);
  assert.equal(resBody.data.id, 'chk-orig-123456');
  assert.equal(resBody.data.final_due_minor, 5000);
});

test('Gate 3 - different appointment_id + same idempotency_key fails closed with 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
  const differentApptId = '99999999-9999-4999-8999-999999999999';
  const existingTx = {
    id: 'chk-orig-123456',
    appointment_id: differentApptId, // already bound to different appointment
    status: 'paid',
    final_due_minor: 5000,
    paid_minor: 5000
  };
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appointment, shop_id: ID.shop, status: 'in_service', customer_id: 'cust-1' }] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  const req = {
    params: { appointmentId: ID.appointment },
    body: { idempotencyKey: 'valid_key_0123456789' },
    ownerAuth: { shopId: ID.shop, ownerAccountId: ID.account }
  };
  let resStatus = 200;
  let resBody = null;
  const res = {
    status(n) { resStatus = n; return this; },
    json(v) { resBody = v; return this; }
  };
  await createCheckoutPos({ pool: { connect: async () => client } }).create(req, res);
  assert.equal(resStatus, 409);
  assert.equal(resBody.success, false);
  assert.equal(resBody.code, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(resBody.data, undefined);
  assert.equal(calls.some(x => x.q === 'ROLLBACK'), true);
});

test('Gate 3 - pending/confirmed/cancelled/no_show using existing idempotency_key fails closed with 409 CHECKOUT_APPOINTMENT_STATUS_INVALID', async () => {
  for (const illegalStatus of ['pending', 'confirmed', 'cancelled', 'no_show', 'void']) {
    const existingTx = {
      id: 'chk-orig-123456',
      appointment_id: ID.appointment,
      status: 'paid',
      final_due_minor: 5000,
      paid_minor: 5000
    };
    const calls = [];
    const client = {
      async query(q, p = []) {
        calls.push({ q, p });
        if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
        if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appointment, shop_id: ID.shop, status: illegalStatus, customer_id: 'cust-1' }] };
        if (/FROM checkout_transactions/.test(q)) return { rows: [existingTx] };
        throw new Error(`Unexpected query: ${q}`);
      },
      release() {}
    };
    const req = {
      params: { appointmentId: ID.appointment },
      body: { idempotencyKey: 'valid_key_0123456789' },
      ownerAuth: { shopId: ID.shop, ownerAccountId: ID.account }
    };
    let resStatus = 200;
    let resBody = null;
    const res = {
      status(n) { resStatus = n; return this; },
      json(v) { resBody = v; return this; }
    };
    await createCheckoutPos({ pool: { connect: async () => client } }).create(req, res);
    assert.equal(resStatus, 409, `Expected 409 for illegal status ${illegalStatus} even with existing key`);
    assert.equal(resBody.success, false);
    assert.equal(resBody.code, 'CHECKOUT_APPOINTMENT_STATUS_INVALID');
    assert.equal(calls.some(x => x.q === 'ROLLBACK'), true);
    // Crucially: checkout_transactions must NOT even be queried because appointment check fails first
    assert.equal(calls.some(x => /FROM checkout_transactions/.test(x.q)), false);
  }
});

test('Gate 3 - source code audit: appointment query occurs before idempotency query in createCheckoutPos', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/checkout-pos.js'), 'utf8');
  const apptIdx = source.indexOf('FROM appointments a');
  const txIdx = source.indexOf('FROM checkout_transactions');
  assert.ok(apptIdx !== -1, 'Appointment query must exist');
  assert.ok(txIdx !== -1, 'Idempotency query must exist');
  assert.ok(apptIdx < txIdx, 'Appointment validation must occur BEFORE idempotency check');
  assert.match(source, /IDEMPOTENCY_KEY_CONFLICT/);
});

// ---------------------------------------------------------------------
// GATE 1 UI: admin.html transitions & action button validation
// ---------------------------------------------------------------------

test('Gate 1 UI - action button matrix: pending/confirmed offer mark-arrived, arrived offers start-service', () => {
  const adminHtml = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');

  // Verify mark-arrived and start-service handler functions exist in admin.html
  assert.match(adminHtml, /async function markArrivedAppointment\(id\)/);
  assert.match(adminHtml, /async function startServiceAppointment\(id\)/);

  // Verify drawer footer transitions
  const drawerFooterSection = adminHtml.slice(
    adminHtml.indexOf('function renderDrawerFooterWithTextContent'),
    adminHtml.indexOf('function getAdminActorRole')
  );
  assert.match(drawerFooterSection, /pending:\s*\[\['mark_arrived',\s*'btn-arrived',\s*'markArrived'\]/);
  assert.match(drawerFooterSection, /confirmed:\s*\[\['mark_arrived',\s*'btn-arrived',\s*'markArrived'\]/);
  assert.match(drawerFooterSection, /arrived:\s*\[\['start_service',\s*'btn-in_service',\s*'markInService'\]/);
  assert.match(drawerFooterSection, /in_service:\s*\[\['completed',\s*'btn-completed',\s*'complete'\]/);

  // Verify action buttons in list/calendar
  const actionBtnSection = adminHtml.slice(
    adminHtml.indexOf('function renderActionButtonsForAppointment'),
    adminHtml.indexOf('function applyAppointmentStatusChangeInPlace')
  );
  assert.match(actionBtnSection, /data-action="mark-arrived"/);
  assert.match(actionBtnSection, /data-action="start-service"/);
  assert.doesNotMatch(actionBtnSection, /data-action="arrive-and-start"/);
});
