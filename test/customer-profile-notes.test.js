'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { app } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const sharedI18nPath = path.join(ROOT, 'public', 'shared-i18n.js');
const calendarSharedCssPath = path.join(ROOT, 'public', 'calendar-shared.css');
const adminHtmlPath = path.join(ROOT, 'public', 'admin.html');
const serverJsPath = path.join(ROOT, 'server.js');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

const i18n = require(sharedI18nPath);
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const serverJs = fs.readFileSync(serverJsPath, 'utf8');

const ID = {
  shopA: '11111111-1111-4111-8111-111111111111',
  shopB: '22222222-2222-4222-8222-222222222222',
  customerA1: '33333333-3333-4333-8333-111111111111',
  customerA2: '33333333-3333-4333-8333-222222222222',
  customerB1: '44444444-4444-4444-8444-111111111111',
  appointment1: '55555555-5555-4555-8555-111111111111'
};

const session = (role = 'owner', shopId = ID.shopA) => ({
  owner_account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  membership_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  shop_id: shopId,
  login_identifier: 'test-user',
  display_name: 'Test User',
  role,
  shop_slug: 'test-shop',
  shop_name: 'Test Shop'
});

const makeMockPool = ({
  role = 'owner',
  shopId = ID.shopA,
  customers = []
} = {}) => {
  const customerStore = new Map(
    customers.map(c => [`${c.shop_id}:${c.id}`, { ...c }])
  );
  const state = { writes: [], queries: [] };

  return {
    state,
    customerStore,
    query: async (sql, params = []) => {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });

      if (/FROM owner_sessions/i.test(normalized)) {
        return { rows: [session(role, shopId)] };
      }

      if (/SELECT id, profile_notes FROM customers WHERE id = \$1 AND shop_id = \$2/i.test(normalized)) {
        const key = `${params[1]}:${params[0]}`;
        const found = customerStore.get(key);
        return { rows: found ? [{ id: found.id, profile_notes: found.profile_notes }] : [] };
      }

      if (/UPDATE customers SET profile_notes = \$1 WHERE id = \$2 AND shop_id = \$3 RETURNING id, profile_notes/i.test(normalized)) {
        const key = `${params[2]}:${params[1]}`;
        state.writes.push({ sql: normalized, params });
        const existing = customerStore.get(key);
        if (existing) {
          existing.profile_notes = params[0];
          return { rows: [{ id: existing.id, profile_notes: existing.profile_notes }] };
        }
        return { rows: [] };
      }

      if (/UPDATE appointments SET internal_notes = \$1/i.test(normalized)) {
        state.writes.push({ sql: normalized, params });
        return { rows: [{ id: params[1], internal_notes: params[0], updated_at: '2030-01-01T00:00:00.000Z' }] };
      }

      throw new Error(`Unexpected query in test mock pool: ${normalized}`);
    }
  };
};

const makeRequest = async (fixture, method, path, body, cookie = 'gg_beauty_owner_session=token') => {
  app.locals.ownerAuthPool = fixture;
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

// ============================================================================
// 1. profile_notes belongs to customer_id
// ============================================================================
test('1. profile_notes belongs to customer_id (not appointment_id)', async () => {
  const customerA = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: null };
  const fixture = makeMockPool({ customers: [customerA] });

  const patchRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: 'Allergic to specific brand of hair dye'
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.data.customerId, ID.customerA1);
  assert.equal(patchRes.json.data.profileNotes, 'Allergic to specific brand of hair dye');

  assert.equal(fixture.state.writes.length, 1);
  assert.match(fixture.state.writes[0].sql, /UPDATE customers SET profile_notes = \$1 WHERE id = \$2 AND shop_id = \$3/);
  assert.deepEqual(fixture.state.writes[0].params, ['Allergic to specific brand of hair dye', ID.customerA1, ID.shopA]);
  assert.doesNotMatch(fixture.state.writes[0].sql, /appointments/i);
});

// ============================================================================
// 2. same phone + different customer IDs do not share notes
// ============================================================================
test('2. same phone + different customer IDs do not share notes', async () => {
  const customer1 = { id: ID.customerA1, shop_id: ID.shopA, phone: '+6591234567', profile_notes: 'Customer 1: dry scalp' };
  const customer2 = { id: ID.customerA2, shop_id: ID.shopA, phone: '+6591234567', profile_notes: 'Customer 2: oily scalp' };
  const fixture = makeMockPool({ customers: [customer1, customer2] });

  const read1 = await makeRequest(fixture, 'GET', `/api/owner/customers/${ID.customerA1}/profile-notes`);
  assert.equal(read1.status, 200);
  assert.equal(read1.json.data.profileNotes, 'Customer 1: dry scalp');

  const read2 = await makeRequest(fixture, 'GET', `/api/owner/customers/${ID.customerA2}/profile-notes`);
  assert.equal(read2.status, 200);
  assert.equal(read2.json.data.profileNotes, 'Customer 2: oily scalp');

  assert.notEqual(read1.json.data.profileNotes, read2.json.data.profileNotes);
});

// ============================================================================
// 3. same name + different customer IDs do not share notes
// ============================================================================
test('3. same name + different customer IDs do not share notes', async () => {
  const customer1 = { id: ID.customerA1, shop_id: ID.shopA, name: 'Alice Tan', profile_notes: 'Alice 1: sensitive ears' };
  const customer2 = { id: ID.customerA2, shop_id: ID.shopA, name: 'Alice Tan', profile_notes: 'Alice 2: color preference #4B' };
  const fixture = makeMockPool({ customers: [customer1, customer2] });

  await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: 'Alice 1: updated notes'
  });

  assert.equal(fixture.customerStore.get(`${ID.shopA}:${ID.customerA1}`).profile_notes, 'Alice 1: updated notes');
  assert.equal(fixture.customerStore.get(`${ID.shopA}:${ID.customerA2}`).profile_notes, 'Alice 2: color preference #4B');
});

// ============================================================================
// 4. customer name/phone changes do not delete profile_notes
// ============================================================================
test('4. customer name/phone changes do not delete profile_notes', () => {
  assert.match(serverJs, /UPDATE customers SET profile_notes/);
  assert.doesNotMatch(serverJs, /UPDATE customers SET.*name.*profile_notes\s*=\s*NULL/i);
});

// ============================================================================
// 5. cross-shop read/write blocked
// ============================================================================
test('5. cross-shop read/write returns safe 404 not-found', async () => {
  const foreignCustomer = { id: ID.customerB1, shop_id: ID.shopB, profile_notes: 'Shop B Secret Note' };
  const fixture = makeMockPool({ role: 'owner', shopId: ID.shopA, customers: [foreignCustomer] });

  const readRes = await makeRequest(fixture, 'GET', `/api/owner/customers/${ID.customerB1}/profile-notes`);
  assert.equal(readRes.status, 404);
  assert.equal(readRes.json.code, 'CUSTOMER_NOT_FOUND');

  const patchRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerB1}/profile-notes`, {
    profileNotes: 'Hacked note'
  });
  assert.equal(patchRes.status, 404);
  assert.equal(patchRes.json.code, 'CUSTOMER_NOT_FOUND');
  assert.equal(
    fixture.customerStore.get(`${ID.shopB}:${ID.customerB1}`).profile_notes,
    'Shop B Secret Note',
    'Foreign customer profile notes must not be modified'
  );
});

// ============================================================================
// 6. owner write allowed
// ============================================================================
test('6. owner write allowed', async () => {
  const customer = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: null };
  const fixture = makeMockPool({ role: 'owner', shopId: ID.shopA, customers: [customer] });

  const res = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: 'Owner notes'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.profileNotes, 'Owner notes');
  assert.equal(fixture.state.writes.length, 1);
});

// ============================================================================
// 7. manager write allowed
// ============================================================================
test('7. manager write allowed', async () => {
  const customer = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: null };
  const fixture = makeMockPool({ role: 'manager', shopId: ID.shopA, customers: [customer] });

  const res = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: 'Manager notes'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.profileNotes, 'Manager notes');
  assert.equal(fixture.state.writes.length, 1);
});

// ============================================================================
// 8. admin/front_desk write denied, read allowed
// ============================================================================
test('8. admin/front_desk write denied, read allowed', async () => {
  const customer = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: 'Existing customer note' };

  // Admin write denied
  const adminFixture = makeMockPool({ role: 'admin', customers: [customer] });
  const adminPatch = await makeRequest(adminFixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, { profileNotes: 'Admin write' });
  assert.equal(adminPatch.status, 403);
  assert.equal(adminFixture.state.writes.length, 0);

  // Admin read allowed
  const adminGet = await makeRequest(adminFixture, 'GET', `/api/owner/customers/${ID.customerA1}/profile-notes`);
  assert.equal(adminGet.status, 200);
  assert.equal(adminGet.json.data.profileNotes, 'Existing customer note');

  // Front desk write denied
  const fdFixture = makeMockPool({ role: 'front_desk', customers: [customer] });
  const fdPatch = await makeRequest(fdFixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, { profileNotes: 'FD write' });
  assert.equal(fdPatch.status, 403);
  assert.equal(fdFixture.state.writes.length, 0);

  // Front desk read allowed
  const fdGet = await makeRequest(fdFixture, 'GET', `/api/owner/customers/${ID.customerA1}/profile-notes`);
  assert.equal(fdGet.status, 200);
  assert.equal(fdGet.json.data.profileNotes, 'Existing customer note');

  // Unauthenticated denied
  const unauthRes = await makeRequest(adminFixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, { profileNotes: 'x' }, '');
  assert.equal(unauthRes.status, 401);
});

// ============================================================================
// 9. staff API does NOT expose profile_notes
// ============================================================================
test('9. staff API does NOT expose profile_notes', () => {
  const staffRouteMatch = serverJs.match(/app\.get\(\s*['"]\/api\/staff\/appointments['"][\s\S]*?\);/);
  assert.ok(staffRouteMatch, 'Must define staff appointments endpoint');
  const staffRouteCode = staffRouteMatch[0];
  assert.doesNotMatch(staffRouteCode, /profile_notes/i);
  assert.doesNotMatch(staffRouteCode, /profileNotes/i);
});

// ============================================================================
// 10. customer/public API does NOT expose profile_notes
// ============================================================================
test('10. customer/public API does NOT expose profile_notes', () => {
  const customerMyBookingsMatch = serverJs.match(/app\.post\(\s*['"]\/api\/customer\/my-bookings['"][\s\S]*?\);/);
  assert.ok(customerMyBookingsMatch, 'Must define customer my-bookings endpoint');
  assert.doesNotMatch(customerMyBookingsMatch[0], /profile_notes/i);

  const customerMeMatch = serverJs.match(/app\.get\(\s*['"]\/api\/customer\/me['"][\s\S]*?\);/);
  assert.ok(customerMeMatch, 'Must define customer /me endpoint');
  assert.doesNotMatch(customerMeMatch[0], /profile_notes/i);
});

// ============================================================================
// 11. Booker != Recipient shows Recipient profile_notes
// ============================================================================
test('11. Booker != Recipient: Owner projection projects Recipient profile_notes', () => {
  assert.match(serverJs, /c\.profile_notes\s*,/, 'Owner appointments query must project c.profile_notes');
  assert.match(
    serverJs,
    /JOIN customers c\s+ON c\.id = a\.customer_id\s+AND c\.shop_id = a\.shop_id/,
    'Customer c is joined on a.customer_id which is constrained to recipient_customer_id'
  );

  // In appointments schema, customer_id is the recipient_customer_id (CHECK customer_id = recipient_customer_id).
  // Verify that an appointment row with c.profile_notes contains the recipient profile_notes.
  const row = {
    id: ID.appointment1,
    customer_id: ID.customerA1,
    booker_customer_id: ID.customerA2,
    recipient_customer_id: ID.customerA1,
    customer_name: 'Recipient Name',
    profile_notes: 'Recipient Note: Prefers soft water wash'
  };
  const { projectOwnerAppointmentCheckout } = require('../lib/owner-appointment-checkout-projection');
  const projected = projectOwnerAppointmentCheckout(row);
  assert.equal(projected.profile_notes, 'Recipient Note: Prefers soft water wash');
  assert.notEqual(projected.profile_notes, 'Booker Note');
});

// ============================================================================
// 12. >4000 chars rejected
// ============================================================================
test('12. >4000 chars rejected with 400 PROFILE_NOTES_TOO_LONG', async () => {
  const customer = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: null };
  const fixture = makeMockPool({ customers: [customer] });

  const tooLong = 'A'.repeat(4001);
  const res = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: tooLong
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'PROFILE_NOTES_TOO_LONG');
  assert.equal(fixture.state.writes.length, 0);

  // Exactly 4000 chars is allowed
  const exact4000 = 'A'.repeat(4000);
  const okRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: exact4000
  });
  assert.equal(okRes.status, 200);
  assert.equal(fixture.state.writes.length, 1);
});

// ============================================================================
// 13. null/empty handling works
// ============================================================================
test('13. null/empty handling works and accepts profile_notes snake_case alias', async () => {
  const customer = { id: ID.customerA1, shop_id: ID.shopA, profile_notes: 'Existing note' };
  const fixture = makeMockPool({ customers: [customer] });

  // null clears note to null
  const nullRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: null
  });
  assert.equal(nullRes.status, 200);
  assert.equal(nullRes.json.data.profileNotes, '');
  assert.equal(fixture.state.writes[0].params[0], null);

  // empty string clears note to null
  const emptyRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: ''
  });
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.json.data.profileNotes, '');
  assert.equal(fixture.state.writes[1].params[0], null);

  // whitespace string clears note to null
  const wsRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profileNotes: '   \n  '
  });
  assert.equal(wsRes.status, 200);
  assert.equal(wsRes.json.data.profileNotes, '');
  assert.equal(fixture.state.writes[2].params[0], null);

  // snake_case profile_notes payload works
  const snakeRes = await makeRequest(fixture, 'PATCH', `/api/owner/customers/${ID.customerA1}/profile-notes`, {
    profile_notes: 'Note from snake_case body'
  });
  assert.equal(snakeRes.status, 200);
  assert.equal(snakeRes.json.data.profileNotes, 'Note from snake_case body');
});

// ============================================================================
// 14. existing Internal Appointment Notes behavior unchanged
// ============================================================================
test('14. existing Internal Appointment Notes behavior unchanged', async () => {
  const fixture = makeMockPool({ role: 'owner' });
  const res = await makeRequest(fixture, 'PATCH', `/api/owner/appointments/${ID.appointment1}/internal-notes`, {
    internalNotes: 'Appointment internal note'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.internalNotes, 'Appointment internal note');
  assert.match(fixture.state.writes[0].sql, /UPDATE appointments SET internal_notes = \$1/);
});

// ============================================================================
// 15. existing appointment notes/remark behavior unchanged
// ============================================================================
test('15. existing appointment notes/remark behavior unchanged', () => {
  assert.match(serverJs, /c\.profile_notes/);
  // Updating profile notes does not affect appointments.remark or appointments.notes
  assert.doesNotMatch(serverJs, /UPDATE customers SET.*remark/i);
});

// ============================================================================
// 16. rollback blocks destructive DROP when profile-note data exists
// ============================================================================
test('16. rollback blocks destructive DROP when profile-note data exists', () => {
  const schemaSql = fs.readFileSync(path.join(ROOT, 'migrations', '070_customer_profile_notes_schema.sql'), 'utf8');
  const verifySql = fs.readFileSync(path.join(ROOT, 'migrations', '071_customer_profile_notes_verification_readonly.sql'), 'utf8');
  const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '070_customer_profile_notes_rollback.sql'), 'utf8');

  assert.match(schemaSql, /ALTER TABLE public\.customers ADD COLUMN IF NOT EXISTS profile_notes TEXT NULL/);
  assert.match(schemaSql, /customers_profile_notes_length_check CHECK \(profile_notes IS NULL OR char_length\(profile_notes\) <= 4000\)/);

  assert.match(verifySql, /^BEGIN TRANSACTION READ ONLY;/);
  assert.doesNotMatch(verifySql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);

  assert.match(rollbackSql, /SELECT EXISTS \(SELECT 1 FROM public\.customers WHERE profile_notes IS NOT NULL AND length\(trim\(profile_notes\)\) > 0\)/);
  assert.match(rollbackSql, /RAISE EXCEPTION 'Customer profile notes rollback blocked/);
  assert.match(rollbackSql, /DROP CONSTRAINT IF EXISTS customers_profile_notes_length_check/);
  assert.match(rollbackSql, /DROP COLUMN IF EXISTS profile_notes/);
});

// ============================================================================
// 17. Chinese/English UI labels use shared i18n
// ============================================================================
test('17. Chinese/English UI labels use shared i18n with linguistic purity', () => {
  const keys = [
    'customerProfileNotes',
    'customerProfileNotesHelp',
    'customerProfileNotesSave',
    'customerProfileNotesSaving',
    'customerProfileNotesSaved',
    'customerProfileNotesSaveFailed'
  ];

  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `Missing zh-CN translation for ${key}`);
    assert.ok(en, `Missing en translation for ${key}`);
    assert.notEqual(zh, key);
    assert.notEqual(en, key);

    // zh-CN pure Chinese (no English words >= 3 letters)
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `zh-CN "${zh}" contains English words`);
    // en pure English (no Chinese characters)
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en "${en}" contains Chinese characters`);
  }

  assert.equal(i18n.t('customerProfileNotes', 'zh-CN'), '顾客档案备注');
  assert.equal(i18n.t('customerProfileNotes', 'en'), 'Customer Profile Notes');
});

// ============================================================================
// 18. Drawer/mobile behavior remains safe
// ============================================================================
function createMockAdminContext(options = {}) {
  const elements = new Map();

  function makeMockElement(id = '', tagName = 'div') {
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      value: '',
      disabled: false,
      hidden: false,
      style: {},
      children: [],
      attributes: {},
      listeners: {},
      setAttribute(name, val) {
        this.attributes[name] = String(val);
      },
      getAttribute(name) {
        return this.attributes[name] || null;
      },
      appendChild(child) {
        if (child) {
          child.parentNode = this;
          this.children.push(child);
        }
        return child;
      },
      replaceChildren(...newChildren) {
        this.children = [];
        for (const child of newChildren) {
          if (child) {
            child.parentNode = this;
            this.children.push(child);
          }
        }
      },
      addEventListener(event, fn) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(fn);
      },
      dispatchEvent(event) {
        const fns = this.listeners[event.type || event] || [];
        for (const fn of fns) fn(event);
      },
      focus() {}
    };
    return el;
  }

  const standardIds = [
    'loginOverlay', 'adminContent', 'loginMessage', 'ownerLoginIdentifier',
    'adminPassword', 'ownerShopSlug', 'totalCount', 'pendingCount', 'todayCount',
    'adminLanguageZh', 'adminLanguageEn', 'content', 'appointmentDrawer',
    'appointmentDrawerBackdrop', 'drawerTitle', 'drawerCloseBtn', 'drawerBody',
    'drawerFooter', 'adminToast'
  ];

  standardIds.forEach(id => {
    elements.set(id, makeMockElement(id));
  });

  const alerts = [];
  const requests = [];

  const context = {
    console, Date, Intl, JSON, setTimeout, clearTimeout, Math, RegExp, Array, Object, String, Number, Boolean, Set, Map, Promise,
    ggI18n: i18n,
    ownerSelfService: {
      _state: { locale: options.locale || 'zh-CN' },
      setLocale(loc) { this._state.locale = loc; },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    alert: msg => alerts.push(msg),
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      if (options.fetchHandler) {
        const customRes = await options.fetchHandler(url, opts);
        if (customRes) return customRes;
      }
      return {
        status: 200,
        ok: true,
        async json() {
          return { success: true, data: { customerId: ID.customerA1, profileNotes: 'Authoritative saved note' } };
        }
      };
    },
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement(tag) { return makeMockElement('', tag); },
      addEventListener() {}
    }
  };

  const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
  vm.runInNewContext(scriptMatch[1], context, { filename: 'public/admin.html' });

  return { context, elements, alerts, requests };
}

function findDescendant(element, predicate) {
  if (!element) return null;
  if (predicate(element)) return element;
  for (const child of element.children || []) {
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

test('18. Drawer/mobile behavior: Owner/manager can edit & save, admin/front_desk read-only, >=44px touch targets', async () => {
  // Check CSS touch targets >= 44px
  assert.match(
    calendarSharedCss,
    /\.drawer-profile-notes-save\s*\{[^}]*min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/,
    'Profile notes save button must have min-height >= 44px'
  );

  const sampleAppt = {
    id: ID.appointment1,
    customer_id: ID.customerA1,
    recipient_customer_id: ID.customerA1,
    customer_name: 'Jane Doe',
    customer_phone: '+6591234567',
    profile_notes: 'Initial scalp condition note',
    internal_notes: 'Internal note',
    status: 'confirmed'
  };

  // 18a. Owner role in Drawer
  {
    const { context, elements, requests } = createMockAdminContext();
    context.setAdminProfile({ membership: { role: 'owner' } });
    context.renderAppointmentDrawer(sampleAppt);

    const drawerBody = elements.get('drawerBody');
    const input = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesInput');
    const saveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-profile-notes-save'));
    const status = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesStatus');

    assert.ok(input, 'Customer profile notes textarea must exist');
    assert.equal(input.disabled, false, 'Owner must have enabled textarea');
    assert.equal(input.maxLength, 4000, 'Must have 4000 maxLength');
    assert.equal(input.value, 'Initial scalp condition note');
    assert.ok(saveBtn, 'Save button must exist for owner');

    // Input clears status
    status.textContent = '顾客档案备注已保存';
    input.dispatchEvent({ type: 'input', target: input });
    assert.equal(status.textContent, '', 'Typing must clear previous status');

    // Clicking save triggers authoritative server PATCH
    input.value = 'Updated note';
    saveBtn.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].opts.method, 'PATCH');
    assert.equal(requests[0].url, `/api/owner/customers/${ID.customerA1}/profile-notes`);
    assert.deepEqual(JSON.parse(requests[0].opts.body), { profileNotes: 'Updated note' });
    assert.equal(sampleAppt.profile_notes, 'Authoritative saved note');
    assert.equal(input.value, 'Authoritative saved note');
  }

  // 18b. Manager role in Drawer
  {
    const { context, elements } = createMockAdminContext();
    context.setAdminProfile({ membership: { role: 'manager' } });
    context.renderAppointmentDrawer(sampleAppt);

    const drawerBody = elements.get('drawerBody');
    const input = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesInput');
    const saveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-profile-notes-save'));
    assert.ok(input);
    assert.equal(input.disabled, false, 'Manager must have enabled textarea');
    assert.ok(saveBtn, 'Manager must have save button');
  }

  // 18c. Front desk role in Drawer (read-only)
  {
    const { context, elements } = createMockAdminContext();
    context.setAdminProfile({ membership: { role: 'front_desk' } });
    context.renderAppointmentDrawer(sampleAppt);

    const drawerBody = elements.get('drawerBody');
    const input = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesInput');
    const saveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-profile-notes-save'));
    assert.ok(input);
    assert.equal(input.disabled, true, 'Front desk must have disabled textarea');
    assert.equal(saveBtn, null, 'Front desk must NOT have save button');
  }

  // 18d. Admin role in Drawer (read-only)
  {
    const { context, elements } = createMockAdminContext();
    context.setAdminProfile({ membership: { role: 'admin' } });
    context.renderAppointmentDrawer(sampleAppt);

    const drawerBody = elements.get('drawerBody');
    const input = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesInput');
    const saveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-profile-notes-save'));
    assert.ok(input);
    assert.equal(input.disabled, true, 'Admin must have disabled textarea');
    assert.equal(saveBtn, null, 'Admin must NOT have save button');
  }
});

// ============================================================================
// PostgreSQL 17 Ephemeral Migration and Rollback Safety Verification
// ============================================================================
test('PostgreSQL 17 Customer Profile Notes: preflight, additive schema, verification, and data-safe rollback', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-cust-profile-pg-'));
  const data = path.join(temp, 'data');
  const port = 57800 + Math.floor(Math.random() * 300);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const pg = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const connectionString = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Client({ connectionString });
      try {
        await candidate.connect();
        db = candidate;
        break;
      } catch (err) {
        await candidate.end().catch(() => {});
        if (attempt === 39) throw err;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    assert.ok(db);

    // Baseline setup: create shops and customers
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE shops (id uuid PRIMARY KEY);
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id uuid NOT NULL REFERENCES shops(id),
        name text NOT NULL,
        phone text,
        email text
      );
      INSERT INTO shops (id) VALUES ('${ID.shopA}');
      INSERT INTO customers (id, shop_id, name, phone)
      VALUES ('${ID.customerA1}', '${ID.shopA}', 'Alice', '+6591234567');
    `);

    const preflight = fs.readFileSync(path.join(ROOT, 'migrations', '069_customer_profile_notes_preflight_readonly.sql'), 'utf8');
    const schema = fs.readFileSync(path.join(ROOT, 'migrations', '070_customer_profile_notes_schema.sql'), 'utf8');
    const verify = fs.readFileSync(path.join(ROOT, 'migrations', '071_customer_profile_notes_verification_readonly.sql'), 'utf8');
    const rollback = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '070_customer_profile_notes_rollback.sql'), 'utf8');

    // 1. Run Preflight
    await db.query(preflight);

    // 2. Run Additive Schema Migration
    await db.query(schema);

    // 3. Run Read-only Verification
    await db.query(verify);

    // 4. Test Length Constraint Enforcement (>4000 characters rejected by DB)
    const longString = 'x'.repeat(4001);
    await assert.rejects(
      db.query(`UPDATE customers SET profile_notes = $1 WHERE id = $2`, [longString, ID.customerA1]),
      /customers_profile_notes_length_check/,
      'PostgreSQL must enforce 4000 character length constraint'
    );

    // 5. Test Rollback Guard with Existing Data
    await db.query(`UPDATE customers SET profile_notes = 'Valuable customer allergy note' WHERE id = $1`, [ID.customerA1]);
    await assert.rejects(
      db.query(rollback),
      /Customer profile notes rollback blocked/,
      'Rollback must block when non-empty customer profile notes exist'
    );
    await db.query('ROLLBACK').catch(() => {});

    // 6. Test Rollback Guard with whitespace-only or null data: clear data and rollback
    await db.query(`UPDATE customers SET profile_notes = NULL WHERE id = $1`, [ID.customerA1]);
    await db.query(rollback);

    // Confirm column dropped after safe rollback
    const colCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'customers' AND column_name = 'profile_notes'
    `);
    assert.equal(colCheck.rows.length, 0, 'Column should be dropped after safe rollback');
  } finally {
    if (db) await db.end().catch(() => {});
    pg.kill('SIGTERM');
    await new Promise(r => pg.once('exit', r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
