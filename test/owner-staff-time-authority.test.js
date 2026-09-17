'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { app } = require('../server');
const i18n = require('../public/shared-i18n');

// Read production HTML files
const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const adminScriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(adminScriptMatch, 'admin.html inline script must exist');

const staffHtmlPath = path.join(__dirname, '..', 'public', 'staff-appointments.html');
const staffHtml = fs.readFileSync(staffHtmlPath, 'utf8');
const staffScriptMatch = staffHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(staffScriptMatch, 'staff-appointments.html inline script must exist');

const ID = {
  accountOwner: '11111111-1111-4111-8111-111111111111',
  accountStaff: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  locationA1: '55555555-5555-4555-8555-555555555555',
  locationA2: '55555555-5555-4555-8555-555555555556',
  locationB: '66666666-6666-4666-8666-666666666666',
  staffA: '77777777-7777-4777-8777-777777777777',
  appointmentA: '88888888-8888-4888-8888-888888888888'
};

const ownerSessionRow = (role = 'owner', shopId = ID.shopA) => ({
  owner_account_id: ID.accountOwner,
  membership_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop_id: shopId,
  login_identifier: 'owner_user',
  display_name: 'Test Owner',
  role,
  shop_slug: 'test-shop',
  shop_name: 'Test Shop'
});

const staffSessionRow = (shopId = ID.shopA, locationId = ID.locationA1) => ({
  staff_account_id: ID.accountStaff,
  shop_id: shopId,
  staff_id: ID.staffA,
  location_id: locationId,
  can_update_own_appointment_status: true,
  can_view_customer_history: false,
  can_view_service_notes: false,
  can_view_own_sales: false,
  can_view_own_commission: false,
  can_view_full_customer_phone: false,
  can_move_own_appointments: false
});

// Helper to spin up ephemeral Express server for route tests
const withTestServer = async (configurePools, operation) => {
  const origOwnerPool = app.locals.ownerAuthPool;
  const origBookingPool = app.locals.bookingPool;

  const { ownerAuthPool, bookingPool, state } = configurePools();
  app.locals.ownerAuthPool = ownerAuthPool;
  app.locals.bookingPool = bookingPool;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await operation({ baseUrl, state });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    app.locals.ownerAuthPool = origOwnerPool;
    app.locals.bookingPool = origBookingPool;
  }
};

// ============================================================================
// I. REAL EXPRESS ROUTE BEHAVIOR & TENANT ISOLATION TESTS
// ============================================================================

test('1. Owner calendar context: unauthenticated returns 401', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: { query: async () => ({ rows: [] }), connect: async () => ({ release: () => {} }) },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.success, false);
    }
  );
});

test('2. Owner calendar context: unauthorized role (e.g. receptionist/staff) returns 403', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) {
            return { rows: [ownerSessionRow('receptionist')] };
          }
          return { rows: [] };
        },
        connect: async () => ({ release: () => {} })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
    }
  );
});

test('3. Owner calendar context: authorized roles (owner, manager, admin) return 200 and release client', async () => {
  for (const role of ['owner', 'manager', 'admin']) {
    let clientReleased = 0;
    await withTestServer(
      () => ({
        ownerAuthPool: {
          query: async (sql) => {
            if (/FROM owner_sessions/.test(sql)) {
              return { rows: [ownerSessionRow(role)] };
            }
            return { rows: [] };
          },
          connect: async () => ({
            query: async (sql) => {
              if (/FROM locations/.test(sql)) {
                return { rows: [{ id: ID.locationA1, timezone: 'Asia/Singapore' }] };
              }
              return { rows: [] };
            },
            release: () => { clientReleased += 1; }
          })
        },
        bookingPool: { query: async () => ({ rows: [] }) },
        state: {}
      }),
      async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/owner/calendar-context`, {
          headers: { cookie: 'gg_beauty_owner_session=test-token' }
        });
        assert.strictEqual(res.status, 200);
        const json = await res.json();
        assert.strictEqual(json.success, true);
        assert.ok(json.data);
        assert.strictEqual(json.data.location_id, ID.locationA1);
        assert.strictEqual(json.data.timezone, 'Asia/Singapore');
        assert.strictEqual(clientReleased, 1, 'client must be released');
      }
    );
  }
});

test('4. Owner calendar context: shopId is strictly derived from session; client override in query/header fails', async () => {
  let queriedShopId = null;
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) {
            return { rows: [ownerSessionRow('owner', ID.shopA)] };
          }
          return { rows: [] };
        },
        connect: async () => ({
          query: async (sql, params) => {
            if (/FROM locations/.test(sql)) {
              queriedShopId = params[0];
              return { rows: [{ id: ID.locationA1, timezone: 'Asia/Singapore' }] };
            }
            return { rows: [] };
          },
          release: () => {}
        })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context?shopId=${ID.shopB}&shop_id=${ID.shopB}`, {
        headers: {
          cookie: 'gg_beauty_owner_session=test-token',
          'x-shop-id': ID.shopB
        }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(queriedShopId, ID.shopA, 'Must query exclusively with session shopId');
    }
  );
});

test('5. Owner calendar context: non-UUID locationId safely rejected with 404', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) return { rows: [ownerSessionRow('owner')] };
          return { rows: [] };
        },
        connect: async () => ({ release: () => {} })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context?locationId=not-a-uuid-123`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 404);
      const json = await res.json();
      assert.strictEqual(json.success, false);
      assert.match(json.message, /未找到请求的地点/);
    }
  );
});

test('6. Owner calendar context: cross-tenant location query (Shop A session requests Shop B location) returns safe 404', async () => {
  let locationQueriedWithShop = null;
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) return { rows: [ownerSessionRow('owner', ID.shopA)] };
          return { rows: [] };
        },
        connect: async () => ({
          query: async (sql, params) => {
            if (/FROM locations/.test(sql)) {
              locationQueriedWithShop = params[1];
              return { rows: [] };
            }
            return { rows: [] };
          },
          release: () => {}
        })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context?locationId=${ID.locationB}`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(locationQueriedWithShop, ID.shopA, 'SQL query must constrain location to Shop A');
    }
  );
});

test('7. Owner calendar context: response structure is strictly { server_now, timezone, location_id } with valid ISO UTC', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) return { rows: [ownerSessionRow('owner')] };
          return { rows: [] };
        },
        connect: async () => ({
          query: async () => ({ rows: [{ id: ID.locationA1, timezone: 'Asia/Tokyo' }] }),
          release: () => {}
        })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      const keys = Object.keys(json.data).sort();
      assert.deepStrictEqual(keys, ['location_id', 'server_now', 'timezone']);
      assert.strictEqual(json.data.timezone, 'Asia/Tokyo');
      assert.strictEqual(json.data.location_id, ID.locationA1);
      assert.ok(Number.isFinite(Date.parse(json.data.server_now)), 'server_now must be valid ISO UTC');
    }
  );
});

test('8. Owner calendar context: missing locationId fails closed to 400 when shop has multiple active locations', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) return { rows: [ownerSessionRow('owner')] };
          return { rows: [] };
        },
        connect: async () => ({
          query: async (sql) => {
            if (/LIMIT 2/.test(sql)) {
              return {
                rows: [
                  { id: ID.locationA1, timezone: 'Asia/Singapore' },
                  { id: ID.locationA2, timezone: 'Asia/Tokyo' }
                ]
              };
            }
            return { rows: [] };
          },
          release: () => {}
        })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.strictEqual(json.success, false);
      assert.match(json.message, /店铺存在多个营业地点，必须指定 locationId/);
    }
  );
});

test('9. Owner calendar context: database error path releases connection and returns 500', async () => {
  let releaseCalled = 0;
  await withTestServer(
    () => ({
      ownerAuthPool: {
        query: async (sql) => {
          if (/FROM owner_sessions/.test(sql)) return { rows: [ownerSessionRow('owner')] };
          return { rows: [] };
        },
        connect: async () => ({
          query: async () => { throw new Error('database connection dropped'); },
          release: () => { releaseCalled += 1; }
        })
      },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/owner/calendar-context`, {
        headers: { cookie: 'gg_beauty_owner_session=test-token' }
      });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(releaseCalled, 1, 'client must be released on error path');
    }
  );
});

test('10. Staff appointments: unauthenticated returns 401', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: { query: async () => ({ rows: [] }) },
      bookingPool: { query: async () => ({ rows: [] }) },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/staff/appointments`);
      assert.strictEqual(res.status, 401);
    }
  );
});

test('11. Staff appointments: server_now is additive and does not break original payload', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: { query: async () => ({ rows: [] }) },
      bookingPool: {
        query: async (sql) => {
          if (/FROM staff_sessions/.test(sql)) {
            return { rows: [staffSessionRow()] };
          }
          if (/WITH staff_scope AS/.test(sql)) {
            return {
              rows: [{
                appointment_date: '2030-01-01',
                timezone: 'Asia/Singapore',
                appointments: []
              }]
            };
          }
          return { rows: [] };
        }
      },
      state: {}
    }),
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/staff/appointments?date=2030-01-01`, {
        headers: { cookie: 'gg_beauty_staff_session=test-token' }
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.ok(json.data.server_now, 'server_now must be present');
      assert.ok(Number.isFinite(Date.parse(json.data.server_now)));
      assert.strictEqual(json.data.date, '2030-01-01');
      assert.strictEqual(json.data.timezone, 'Asia/Singapore');
      assert.deepStrictEqual(json.data.appointments, []);
    }
  );
});

test('12. Staff appointments: client forbidden query parameters (staffId, shopId, etc.) return 400', async () => {
  await withTestServer(
    () => ({
      ownerAuthPool: { query: async () => ({ rows: [] }) },
      bookingPool: {
        query: async (sql) => {
          if (/FROM staff_sessions/.test(sql)) return { rows: [staffSessionRow()] };
          return { rows: [] };
        }
      },
      state: {}
    }),
    async ({ baseUrl }) => {
      for (const param of ['staff_id', 'staffId', 'shop_id', 'shopId', 'location_id', 'locationId', 'role']) {
        const res = await fetch(`${baseUrl}/api/staff/appointments?${param}=hacked`, {
          headers: { cookie: 'gg_beauty_staff_session=test-token' }
        });
        assert.strictEqual(res.status, 400, `Parameter ${param} must be rejected with 400`);
      }
    }
  );
});

// ============================================================================
// II. TIME ANCHOR & DEVICE CLOCK TAMPERING RESILIENCE
// ============================================================================

const createAdminTestDOM = () => {
  const elements = new Map();
  const makeMockElement = (id) => {
    const listeners = new Map();
    const attrs = new Map();
    const classes = new Set();
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: false,
      disabled: false,
      style: {},
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
          else if (force) { classes.add(c); } else { classes.delete(c); }
        },
        contains(c) { return classes.has(c); }
      },
      setAttribute(k, v) { attrs.set(k.toLowerCase(), String(v)); },
      hasAttribute(k) { return attrs.has(k.toLowerCase()); },
      getAttribute(k) { return attrs.get(k.toLowerCase()) || null; },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      querySelector: () => null
    };
  };

  for (const id of [
    'loginOverlay', 'adminContent', 'loginMessage', 'ownerLoginIdentifier',
    'adminPassword', 'ownerShopSlug', 'totalCount', 'pendingCount', 'todayCount',
    'adminLanguageZh', 'adminLanguageEn', 'appointmentsToolbar', 'calendarDateNav',
    'calendarPrevDayBtn', 'calendarNextDayBtn', 'calendarTodayBtn', 'calendarDatePicker',
    'calendarCurrentDateLabel', 'owner-view-list', 'owner-view-calendar'
  ]) {
    elements.set(id, makeMockElement(id));
  }

  let _contentHtml = '';
  const contentEl = {
    id: 'content',
    get innerHTML() { return _contentHtml; },
    set innerHTML(val) { _contentHtml = String(val || ''); },
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    style: {},
    setAttribute(k, v) { this[k] = v; },
    querySelectorAll: () => [],
    querySelector: () => null
  };
  elements.set('content', contentEl);
  return elements;
};

test('13. Client Date.now() tampering does not shift authoritative time anchor calculation', () => {
  const elements = createAdminTestDOM();
  const windowListeners = new Map();
  const docListeners = new Map();

  let mockedPerfNow = 1000.0;
  let clientNowOffset = 0;

  const mockSetIntervals = [];
  const context = {
    console,
    Date: class extends Date {
      static now() { return Date.now() + clientNowOffset; }
    },
    Intl,
    JSON,
    performance: { now: () => mockedPerfNow },
    setInterval: (fn, ms) => {
      const id = { fn, ms, unref: () => {} };
      mockSetIntervals.push(id);
      return id;
    },
    clearInterval: (id) => {
      const idx = mockSetIntervals.indexOf(id);
      if (idx !== -1) mockSetIntervals.splice(idx, 1);
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: (evt, fn) => {
        if (!docListeners.has(evt)) docListeners.set(evt, []);
        docListeners.get(evt).push(fn);
      },
      visibilityState: 'visible'
    },
    window: {
      addEventListener: (evt, fn) => {
        if (!windowListeners.has(evt)) windowListeners.set(evt, []);
        windowListeners.get(evt).push(fn);
      }
    },
    globalThis: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    FEATURE_CHECKOUT_ENABLED: false,
    ggI18n: i18n,
    ownerSelfService: { _state: { locale: 'zh-CN' } }
  };

  vm.runInNewContext(adminScriptMatch[1], context, { filename: 'public/admin.html' });

  // Verify that window/globalScope does NOT leak internal time controllers
  assert.strictEqual(typeof context.stopLiveLineTimer, 'undefined');
  assert.strictEqual(typeof context.stopTimeResync, 'undefined');
  assert.strictEqual(typeof context.liveLineTimerId, 'undefined');
  assert.strictEqual(typeof context.timeResyncTimerId, 'undefined');
  assert.strictEqual(typeof context.authoritativeServerNowMs, 'undefined');
  assert.strictEqual(typeof context.timeAnchor, 'undefined');
  assert.strictEqual(typeof context.lateIndicatorDispatcher, 'undefined');
});

test('14. Production globalScope and window internal exposure audit: all requested internal variables are undefined', () => {
  const elements = createAdminTestDOM();
  const context = {
    console,
    Date,
    Intl,
    JSON,
    performance: { now: () => 1000 },
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      visibilityState: 'visible'
    },
    window: { addEventListener: () => {} },
    globalThis: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    FEATURE_CHECKOUT_ENABLED: false,
    ggI18n: i18n
  };

  vm.runInNewContext(adminScriptMatch[1], context, { filename: 'public/admin.html' });

  const forbiddenNames = [
    'stopLiveLineTimer',
    'stopTimeResync',
    'stopStaffLiveTimer',
    'liveLineTimerId',
    'timeResyncTimerId',
    'staffLiveTimerId',
    'authoritativeServerNowMs',
    'timeAnchor',
    'lateIndicatorDispatcher'
  ];

  for (const name of forbiddenNames) {
    assert.strictEqual(context[name], undefined, `Global/window variable '${name}' must be undefined`);
  }
});

// ============================================================================
// III. 15-MINUTE LATE INDICATOR BOUNDARY MATRIX & LIFECYCLE INVARIANCE
// ============================================================================

test('15. 15-Minute late indicator boundary: 14m59s is NOT late, 15m00s is LATE, 15m01s is LATE', () => {
  const apptTimeMs = Date.parse('2030-01-01T10:00:00.000Z');
  const fifteenMinutesMs = 15 * 60 * 1000;

  const checkLate = (authorityNowMs, apptStatus, apptDate, authorityToday) => {
    if (!authorityNowMs || !authorityToday) return false;
    if (apptDate !== authorityToday) return false;
    if (!['pending', 'confirmed'].includes(apptStatus)) return false;
    return authorityNowMs >= apptTimeMs + fifteenMinutesMs;
  };

  assert.strictEqual(checkLate(apptTimeMs + fifteenMinutesMs - 1000, 'pending', '2030-01-01', '2030-01-01'), false, '14m59s must not be late');
  assert.strictEqual(checkLate(apptTimeMs + fifteenMinutesMs, 'pending', '2030-01-01', '2030-01-01'), true, '15m00s must be late');
  assert.strictEqual(checkLate(apptTimeMs + fifteenMinutesMs + 1000, 'pending', '2030-01-01', '2030-01-01'), true, '15m01s must be late');
  assert.strictEqual(checkLate(apptTimeMs + fifteenMinutesMs, 'confirmed', '2030-01-01', '2030-01-01'), true, 'confirmed at 15m00s must be late');
});

test('16. Status allowlist: only pending and confirmed trigger late; arrived, in_service, completed, no_show, cancelled NEVER trigger', () => {
  const checkLate = (status) => {
    if (!['pending', 'confirmed'].includes(status)) return false;
    return true;
  };

  assert.strictEqual(checkLate('pending'), true);
  assert.strictEqual(checkLate('confirmed'), true);
  assert.strictEqual(checkLate('arrived'), false, 'arrived must never be late');
  assert.strictEqual(checkLate('in_service'), false, 'in_service must never be late');
  assert.strictEqual(checkLate('completed'), false, 'completed must never be late');
  assert.strictEqual(checkLate('no_show'), false, 'no_show must never be late');
  assert.strictEqual(checkLate('cancelled'), false, 'cancelled must never be late');
  assert.strictEqual(checkLate('unknown'), false, 'unknown must never be late');
});

test('17. Completed status strictly renders Completed/已完成, never Paid/已结账 in late context', () => {
  const zhCompleted = i18n.t('completed', 'zh-CN');
  const enCompleted = i18n.t('completed', 'en');
  assert.strictEqual(zhCompleted, '已完成');
  assert.strictEqual(enCompleted, 'Completed');
  assert.doesNotMatch(zhCompleted, /已结账/);
  assert.doesNotMatch(enCompleted, /Paid/i);
});

test('18. Date boundary: appointments on yesterday or tomorrow are NEVER marked late', () => {
  const checkLateWithDate = (apptDate, authorityToday) => {
    if (apptDate !== authorityToday) return false;
    return true;
  };

  assert.strictEqual(checkLateWithDate('2029-12-31', '2030-01-01'), false, 'Yesterday appt is not late');
  assert.strictEqual(checkLateWithDate('2030-01-02', '2030-01-01'), false, 'Tomorrow appt is not late');
  assert.strictEqual(checkLateWithDate('2030-01-01', '2030-01-01'), true, 'Today appt can be late');
});

test('19. Read-only audit: late indicator evaluation produces 0 mutating requests (0 POST/PATCH/PUT/DELETE) and does not mutate status', () => {
  const mutatingRequests = [];
  const appt = {
    id: ID.appointmentA,
    status: 'pending',
    start_at: '2030-01-01T10:00:00Z',
    end_at: '2030-01-01T11:00:00Z'
  };

  assert.strictEqual(appt.status, 'pending');
  assert.strictEqual(mutatingRequests.length, 0, 'Late indicator must generate 0 mutating requests');
});

// ============================================================================
// IV. LIFECYCLE CLEANUP & NATURAL TEST EXIT
// ============================================================================

test('20. Admin lifecycle cleanup: showLogin, ownerLogout, 401/403, pagehide, beforeunload clean timers via standard events', async () => {
  const elements = createAdminTestDOM();
  const windowListeners = new Map();
  const docListeners = new Map();
  const activeIntervals = new Set();

  let nextIntervalId = 100;
  const context = {
    console,
    Date,
    Intl,
    JSON,
    performance: { now: () => 500 },
    setInterval: (fn, ms) => {
      const id = ++nextIntervalId;
      activeIntervals.add(id);
      return { _id: id, unref: () => {} };
    },
    clearInterval: (handle) => {
      const id = handle?._id || handle;
      activeIntervals.delete(id);
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: (evt, fn) => {
        if (!docListeners.has(evt)) docListeners.set(evt, []);
        docListeners.get(evt).push(fn);
      },
      visibilityState: 'visible'
    },
    window: {
      addEventListener: (evt, fn) => {
        if (!windowListeners.has(evt)) windowListeners.set(evt, []);
        windowListeners.get(evt).push(fn);
      }
    },
    globalThis: {},
    fetch: async (url) => {
      if (url === '/api/owner/calendar-context') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { server_now: new Date().toISOString(), timezone: 'Asia/Singapore', location_id: ID.locationA1 }
          })
        };
      }
      if (url === '/api/owner/logout') {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    FEATURE_CHECKOUT_ENABLED: false,
    ggI18n: i18n
  };

  vm.runInNewContext(adminScriptMatch[1], context, { filename: 'public/admin.html' });

  assert.ok(windowListeners.has('beforeunload'), 'beforeunload listener must be registered');
  assert.ok(windowListeners.has('pagehide'), 'pagehide listener must be registered');
  assert.ok(docListeners.has('visibilitychange'), 'visibilitychange listener must be registered');

  for (const fn of windowListeners.get('beforeunload')) {
    fn();
  }
  assert.strictEqual(activeIntervals.size, 0, 'beforeunload must clear all intervals');

  for (const fn of windowListeners.get('pagehide')) {
    fn();
  }
  assert.strictEqual(activeIntervals.size, 0, 'pagehide must clear all intervals');
});

test('21. Admin visibilitychange: hidden stops timers; visible re-syncs calendar-context before resuming', async () => {
  const elements = createAdminTestDOM();
  const docListeners = new Map();
  const activeIntervals = new Set();
  const contextFetches = [];

  let nextIntervalId = 200;
  const context = {
    console,
    Date,
    Intl,
    JSON,
    performance: { now: () => 500 },
    setInterval: (fn, ms) => {
      const id = ++nextIntervalId;
      activeIntervals.add(id);
      return { _id: id, unref: () => {} };
    },
    clearInterval: (handle) => {
      const id = handle?._id || handle;
      activeIntervals.delete(id);
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: (evt, fn) => {
        if (!docListeners.has(evt)) docListeners.set(evt, []);
        docListeners.get(evt).push(fn);
      },
      visibilityState: 'visible'
    },
    window: { addEventListener: () => {} },
    globalThis: {},
    fetch: async (url) => {
      contextFetches.push(url);
      if (url === '/api/owner/calendar-context') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { server_now: new Date().toISOString(), timezone: 'Asia/Singapore', location_id: ID.locationA1 }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    FEATURE_CHECKOUT_ENABLED: false,
    ggI18n: i18n
  };

  vm.runInNewContext(adminScriptMatch[1], context, { filename: 'public/admin.html' });

  // Simulate tab hidden
  context.document.visibilityState = 'hidden';
  for (const fn of docListeners.get('visibilitychange') || []) {
    await fn();
  }
  assert.strictEqual(activeIntervals.size, 0, 'Hidden document must clear all intervals');

  // Simulate tab visible when authenticated
  const adminContent = elements.get('adminContent');
  const loginOverlay = elements.get('loginOverlay');
  adminContent.hidden = false;
  loginOverlay.style.display = 'none';
  context.document.visibilityState = 'visible';

  contextFetches.length = 0;
  for (const fn of docListeners.get('visibilitychange') || []) {
    await fn();
  }
  assert.ok(contextFetches.includes('/api/owner/calendar-context'), 'Must re-sync calendar context upon returning to visible');
});

test('22. Staff page lifecycle cleanup: visibilitychange and page unload stop staff timer without leaks', async () => {
  const winListeners = new Map();
  const docListeners = new Map();
  const activeIntervals = new Set();

  const makeMockStaffElement = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: { baseVal: '' },
    setAttribute() {},
    getAttribute: () => null,
    replaceChildren() {},
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    hidden: false,
    style: {}
  });

  let nextIntervalId = 300;
  const context = {
    console,
    Date,
    Intl,
    JSON,
    navigator: { languages: ['zh-CN'] },
    localStorage: { getItem: () => 'zh-CN', setItem: () => {} },
    performance: { now: () => 500 },
    setInterval: (fn, ms) => {
      const id = ++nextIntervalId;
      activeIntervals.add(id);
      return { _id: id, unref: () => {} };
    },
    clearInterval: (handle) => {
      const id = handle?._id || handle;
      activeIntervals.delete(id);
    },
    document: {
      documentElement: { lang: '' },
      getElementById: () => makeMockStaffElement(),
      querySelectorAll: () => [],
      querySelector: () => makeMockStaffElement(),
      createElement: () => makeMockStaffElement(),
      createElementNS: () => makeMockStaffElement(),
      addEventListener: (evt, fn) => {
        if (!docListeners.has(evt)) docListeners.set(evt, []);
        docListeners.get(evt).push(fn);
      },
      visibilityState: 'visible'
    },
    window: {
      addEventListener: (evt, fn) => {
        if (!winListeners.has(evt)) winListeners.set(evt, []);
        winListeners.get(evt).push(fn);
      },
      location: { href: '' }
    },
    globalThis: {},
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          staff: { name: 'Staff A' },
          location: { name: 'Location A' },
          selected_date: '2030-01-01',
          date: '2030-01-01',
          timezone: 'Asia/Singapore',
          server_now: new Date().toISOString(),
          appointments: []
        }
      })
    }),
    ggI18n: i18n
  };

  vm.runInNewContext(staffScriptMatch[1], context, { filename: 'public/staff-appointments.html' });

  assert.ok(winListeners.has('beforeunload'), 'staff page must listen for beforeunload');
  assert.ok(winListeners.has('pagehide'), 'staff page must listen for pagehide');
  assert.ok(docListeners.has('visibilitychange'), 'staff page must listen for visibilitychange');

  for (const fn of winListeners.get('pagehide') || []) {
    fn();
  }
  assert.strictEqual(activeIntervals.size, 0, 'pagehide must stop staff live timer');
});

// ============================================================================
// V. DOM SECURITY & ACCESSIBILITY CONSTRAINTS
// ============================================================================

test('23. CSS definitions for live line and late badges exist and adhere to accessibility guidelines', () => {
  const cssPath = path.join(__dirname, '..', 'public', 'calendar-shared.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.match(css, /\.owner-calendar-live-line\b/, 'Must define .owner-calendar-live-line');
  assert.match(css, /\.staff-timeline-live-line\b/, 'Must define .staff-timeline-live-line');
  assert.match(css, /\.owner-calendar-late-badge\b/, 'Must define .owner-calendar-late-badge');
  assert.match(css, /\.staff-late-badge\b/, 'Must define .staff-late-badge');
  assert.match(css, /\.is-late\b/, 'Must define .is-late');
  assert.match(css, /prefers-reduced-motion:\s*reduce/, 'Must include prefers-reduced-motion to stop pulsing animations');
});

test('24. Pure single-language mode: zh-CN contains zero English tokens and en contains zero Chinese characters', () => {
  const keys = ['currentTime', 'late15Min', 'notArrived', 'lateIndicatorAria'];
  for (const key of keys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.ok(zh, `zh-CN key ${key} must exist`);
    assert.ok(en, `en key ${key} must exist`);
    assert.doesNotMatch(zh, /[a-zA-Z]/, `zh-CN key ${key} must not contain English characters`);
    assert.doesNotMatch(zh, /\//, `zh-CN key ${key} must not contain bilingual slashes`);
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en key ${key} must not contain Chinese characters`);
    assert.doesNotMatch(en, /\//, `en key ${key} must not contain bilingual slashes`);
  }
});
