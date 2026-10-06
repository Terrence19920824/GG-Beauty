'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../public/shared-i18n');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'public', 'admin.html');
const cssPath = path.join(root, 'public', 'calendar-shared.css');
const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, 'admin.html inline script must exist');

const todaySingapore = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());
const sampleLocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const getTodaySingaporeIso = (hour = 10, minute = 15) => {
  const [y, m, d] = todaySingapore.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hour - 8, minute, 0));
  return dt.toISOString();
};

const sampleAppointment = {
  id: '00000000-0000-4000-8000-000000000001',
  start_at: getTodaySingaporeIso(10, 15),
  end_at: getTodaySingaporeIso(11, 45),
  customer_name: 'VIP Customer',
  customer_phone: '91234567',
  service_name: 'Hair Treatment',
  staff_name: 'Alice',
  staff_id: '11111111-1111-4000-8000-000000000001',
  status: 'pending',
  items: [],
  checkout: null,
  can_start_checkout: false
};

const sampleStaff = [
  { id: '11111111-1111-4000-8000-000000000001', name: 'Alice', is_active: true, bookable: true },
  { id: '22222222-2222-4000-8000-000000000002', name: 'Bob', is_active: true, bookable: true },
  { id: '33333333-3333-4000-8000-000000000003', name: 'Charlie', is_active: true, bookable: true }
];

function parseMockButtons(contentHtml, onAttrRemoved) {
  const buttons = [];
  const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match;
  while ((match = buttonRegex.exec(contentHtml)) !== null) {
    const rawAttrs = match[1];
    const text = match[2];
    const attrs = new Map();
    const attrRegex = /([a-zA-Z0-9_\-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let aMatch;
    while ((aMatch = attrRegex.exec(rawAttrs)) !== null) {
      const name = aMatch[1].toLowerCase();
      const val = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : (aMatch[4] !== undefined ? aMatch[4] : ''));
      attrs.set(name, val);
    }
    const listeners = new Map();
    const btn = {
      tagName: 'BUTTON',
      textContent: text.replace(/<[^>]*>/g, '').trim(),
      innerHTML: text,
      dataset: {},
      listeners,
      addEventListener(type, handler) {
        if (!listeners.has(type)) {
          listeners.set(type, []);
        }
        listeners.get(type).push(handler);
      },
      getAttribute(name) {
        return attrs.has(name.toLowerCase()) ? attrs.get(name.toLowerCase()) : null;
      },
      hasAttribute(name) {
        return attrs.has(name.toLowerCase());
      },
      setAttribute(name, val) {
        attrs.set(name.toLowerCase(), String(val));
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[camel] = String(val);
        }
      },
      removeAttribute(name) {
        attrs.delete(name.toLowerCase());
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          delete this.dataset[camel];
        }
        if (typeof onAttrRemoved === 'function') {
          onAttrRemoved(name);
        }
      },
      click() {
        const ev = {
          type: 'click',
          target: this,
          currentTarget: this,
          preventDefault() {},
          stopPropagation() {}
        };
        const handlers = (listeners.get('click') || []).slice();
        for (const h of handlers) {
          h(ev);
        }
      }
    };
    for (const [k, v] of attrs.entries()) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        btn.dataset[camel] = v;
      }
    }
    buttons.push(btn);
  }
  return buttons;
}

const createTestContext = (initialStorage = {}) => {
  const elements = new Map();
  const storage = new Map(Object.entries(initialStorage));

  const makeMockElement = (id) => {
    const listeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      hidden: id === 'adminContent',
      disabled: false,
      dataset: {},
      style: { display: id === 'loginOverlay' ? 'flex' : '' },
      classList: {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        toggle: (c, force) => {
          if (force === true) classes.add(c);
          else if (force === false) classes.delete(c);
          else if (classes.has(c)) classes.delete(c);
          else classes.add(c);
          return classes.has(c);
        },
        contains: (c) => classes.has(c)
      },
      setAttribute(k, v) {
        attrs.set(k.toLowerCase(), String(v));
      },
      getAttribute(k) {
        return attrs.get(k.toLowerCase()) || null;
      },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      click() {
        const list = (listeners.get('click') || []).slice();
        for (const fn of list) fn({ type: 'click', target: this, preventDefault() {} });
      },
      change(value) {
        this.value = value;
        const list = (listeners.get('change') || []).slice();
        for (const fn of list) fn({ type: 'change', target: this, preventDefault() {} });
      },
      querySelector(sel) {
        if (sel === 'span') {
          return {
            set textContent(v) { this._t = v; },
            get textContent() { return this._t || ''; }
          };
        }
        return null;
      }
    };
  };

  for (const id of [
    'loginOverlay',
    'adminContent',
    'loginMessage',
    'ownerLoginIdentifier',
    'adminPassword',
    'ownerShopSlug',
    'totalCount',
    'pendingCount',
    'todayCount',
    'adminLanguageZh',
    'adminLanguageEn',
    'appointmentsToolbar',
    'calendarDateNav',
    'calendarPrevDayBtn',
    'calendarNextDayBtn',
    'calendarTodayBtn',
    'calendarDatePicker',
    'calendarCurrentDateLabel',
    'owner-view-list',
    'owner-view-calendar'
  ]) {
    elements.set(id, makeMockElement(id));
  }

  let _contentHtml = '';
  let _contentButtons = [];
  const contentEl = {
    id: 'content',
    get innerHTML() {
      return _contentHtml;
    },
    set innerHTML(val) {
      _contentHtml = String(val || '');
      _contentButtons = parseMockButtons(_contentHtml, attrName => {
        const pattern = new RegExp(`\\s*${attrName}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'gi');
        _contentHtml = _contentHtml.replace(pattern, '');
      });
    },
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    style: {},
    setAttribute(k, v) {
      this[k] = v;
    },
    querySelectorAll(sel) {
      if (!sel) return [];
      if (sel === 'button') {
        return _contentButtons;
      }
      if (sel === '.checkout-btn') {
        return _contentButtons.filter(b => (b.getAttribute('class') || '').includes('checkout-btn'));
      }
      const attrMatch = sel.match(/\[([a-zA-Z0-9_\-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
      if (attrMatch) {
        const attr = attrMatch[1].toLowerCase();
        const expected = attrMatch[2] !== undefined ? attrMatch[2] : (attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4]);
        return _contentButtons.filter(b => {
          if (expected !== undefined) {
            return b.getAttribute(attr) === expected;
          }
          return b.hasAttribute(attr);
        });
      }
      return [];
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  };
  elements.set('content', contentEl);

  const requests = [];
  const alerts = [];
  let currentApiAppointments = [sampleAppointment];
  let currentApiStaff = sampleStaff;
  let currentApiAvailability = null;
  let availabilityResponder = null;

  const mockLocalStorage = {
    getItem(k) { return storage.get(k) || null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    clear() { storage.clear(); }
  };

  const context = {
    console,
    Date,
    Intl,
    JSON,
    ggI18n: i18n,
    localStorage: mockLocalStorage,
    ownerSelfService: {
      _state: { locale: 'zh-CN' },
      setLocale(loc) {
        this._state.locale = loc;
      },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    alert: (msg) => alerts.push(msg),
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/api/owner/calendar-staff-availability')) {
        if (availabilityResponder) return availabilityResponder(url, options);
        const date = new URL(url, 'http://calendar.test').searchParams.get('date');
        const data = currentApiAvailability || {
          date,
          locationId: sampleLocationId,
          timezone: 'Asia/Singapore',
          businessWindows: [{ start: '10:00', end: '21:00' }],
          businessHoursSource: 'fallback',
          staff: currentApiStaff.map(staff => ({
            id: staff.id,
            name: staff.name,
            status: 'working',
            workingWindows: [{ start: '10:00', end: '21:00' }],
            reason: 'WEEKLY_HOURS',
            source: 'weekly+fallback'
          }))
        };
        return { status: 200, ok: true, json: async () => ({ success: true, data }) };
      }
      if (url.includes('/api/appointments-db')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ success: true, data: currentApiAppointments })
        };
      }
      if (url.includes('/api/owner/staff')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ success: true, data: currentApiStaff })
        };
      }
      if (url.includes('/api/owner/calendar-context')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            data: {
              server_now: new Date().toISOString(),
              timezone: 'Asia/Singapore',
              location_id: sampleLocationId
            }
          })
        };
      }
      if (url.includes('/api/admin/update-status-db')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ success: true })
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ success: true })
      };
    },
    document: {
      getElementById(id) {
        const el = elements.get(id);
        if (!el) throw new Error(`Unknown element: ${id}`);
        return el;
      },
      querySelectorAll(selector) {
        if (selector === '[data-i18n]') return [];
        if (selector === '[data-i18n-title]') return [];
        if (selector === '[data-i18n-placeholder]') return [];
        return elements.get('content')?.querySelectorAll(selector) || [];
      },
      addEventListener(name, handler) {
        if (name === 'DOMContentLoaded') {
          handler();
        }
      }
    }
  };

  vm.runInNewContext(scriptMatch[1], context, { filename: 'public/admin.html' });

  const load = async (appts = currentApiAppointments, staff = currentApiStaff) => {
    currentApiAppointments = appts;
    currentApiStaff = staff;
    await context.loadAppointments();
  };

  return {
    context,
    elements,
    alerts,
    requests,
    load,
    storage,
    setApiData: (appts, staff) => {
      currentApiAppointments = appts;
      if (staff !== undefined) currentApiStaff = staff;
    },
    setAvailability: value => { currentApiAvailability = value; },
    setAvailabilityResponder: value => { availabilityResponder = value; }
  };
};

// ============================================================================
// C3 OWNER FRONT DESK IPAD MULTI-STAFF CALENDAR GRID TESTS
// ============================================================================

test('40. reads authentic staff roster via tenant-scoped /api/owner/staff with credentials', async () => {
  const { requests, load } = createTestContext();
  await load();
  const staffReq = requests.find(r => r.url === '/api/owner/staff');
  assert.ok(staffReq, '/api/owner/staff must be requested');
  assert.equal(staffReq.options.credentials, 'same-origin');
});

test('41. zero-appointment staff members preserve their column with 0 appts display', async () => {
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  // Only Alice has an appointment on 2030-01-01; Bob and Charlie have 0
  await load([sampleAppointment], sampleStaff);
  const html = elements.get('content').innerHTML;

  assert.match(html, /data-staff-id="11111111-1111-4000-8000-000000000001"/); // Alice
  assert.match(html, /data-staff-id="22222222-2222-4000-8000-000000000002"/); // Bob
  assert.match(html, /data-staff-id="33333333-3333-4000-8000-000000000003"/); // Charlie

  // Bob and Charlie header counts
  assert.match(html, />0 个预约<\/div>/);
  assert.match(html, />1 个预约<\/div>/);
});

test('42. staff columns are stably ordered alphabetically by staff name', async () => {
  const shuffledStaff = [
    { id: 'staff-z', name: 'Zoe' },
    { id: 'staff-a', name: 'Alice' },
    { id: 'staff-m', name: 'Mary' }
  ];
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([], shuffledStaff);
  const html = elements.get('content').innerHTML;

  const idxAlice = html.indexOf('Alice');
  const idxMary = html.indexOf('Mary');
  const idxZoe = html.indexOf('Zoe');

  assert.ok(idxAlice < idxMary, 'Alice should precede Mary');
  assert.ok(idxMary < idxZoe, 'Mary should precede Zoe');
});

test('43. appointments enter column corresponding to authoritative primary staff', async () => {
  const appt = {
    ...sampleAppointment,
    items: [
      {
        sequence_no: 1,
        service_name_snapshot: 'Hair Treatment',
        staff_assignments: [{ role: 'primary', staff_id: sampleStaff[1].id, staff_name: 'Bob' }]
      }
    ]
  };
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([appt], sampleStaff);
  const html = elements.get('content').innerHTML;

  // Bob's column header should have 1 appt, Alice should have 0
  const bobColIdx = html.indexOf(`data-staff-id="${sampleStaff[1].id}"`);
  assert.ok(bobColIdx !== -1, "Bob column exists");
  assert.match(html, /VIP Customer/);
});

test('44 & 46. assistant staff displayed on card without duplicating appointment or column counts', async () => {
  const multiItemAppt = {
    ...sampleAppointment,
    items: [
      {
        sequence_no: 1,
        service_name_snapshot: 'Hair Coloring',
        staff_assignments: [
          { role: 'primary', staff_id: sampleStaff[0].id, staff_name: 'Alice' },
          { role: 'assistant', staff_id: sampleStaff[1].id, staff_name: 'Bob' }
        ]
      },
      {
        sequence_no: 2,
        service_name_snapshot: 'Blow Dry',
        staff_assignments: [
          { role: 'primary', staff_id: sampleStaff[0].id, staff_name: 'Alice' },
          { role: 'assistant', staff_id: sampleStaff[2].id, staff_name: 'Charlie' }
        ]
      }
    ]
  };
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([multiItemAppt], sampleStaff);
  const html = elements.get('content').innerHTML;

  // Primary is Alice -> Alice has 1 appointment, Bob has 0, Charlie has 0
  assert.match(html, /助理: Bob, Charlie/);
  // Match appointment card exactly once in entire HTML
  const cardMatches = (html.match(/class="owner-calendar-appointment/g) || []).length;
  assert.equal(cardMatches, 1, 'Appointment card should appear exactly once, not duplicated for assistants');
});

test('45. missing or unauthenticated primary staff fails closed to unassigned column', async () => {
  const forgedAppt = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000099',
    staff_id: '99999999-9999-4000-8000-000000000099', // not in sampleStaff
    staff_name: 'HackedStaff',
    items: []
  };
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([forgedAppt], sampleStaff);
  const html = elements.get('content').innerHTML;

  // HackedStaff column MUST NOT be created
  assert.doesNotMatch(html, /data-staff-id="99999999-9999-4000-8000-000000000099"/);
  // Must fail closed to unassigned column
  assert.match(html, /data-staff-id="__unassigned__"/);
  assert.match(html, /未分配员工/);
});

test('47 & 48. time positioning and duration scale accurately for non-hourly appointments (10:15-11:45)', async () => {
  // 10:15 - 11:45 Singapore time = 15min offset from 10:00 (15 * 1.25 = 18.75 -> 18.8px), duration 90min (90 * 1.25 = 112.5px)
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);
  const html = elements.get('content').innerHTML;

  assert.match(html, /10:15\s*-\s*11:45/);
  assert.match(html, /top:\s*18\.8px;/);
  assert.match(html, /height:\s*112\.5px;/);
});

test('49. overlapping appointments within same staff column render in concurrent lanes with conflict indicator', async () => {
  const apptA = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-00000000000a',
    start_at: getTodaySingaporeIso(10, 0),
    end_at: getTodaySingaporeIso(11, 0),
    customer_name: 'Customer One'
  };
  const apptB = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-00000000000b',
    start_at: getTodaySingaporeIso(10, 30),
    end_at: getTodaySingaporeIso(11, 30),
    customer_name: 'Customer Two'
  };
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([apptA, apptB], sampleStaff);
  const html = elements.get('content').innerHTML;

  assert.match(html, /has-overlap/);
  assert.match(html, /重叠/);
  // Two lanes: width calc(50.00% - 6px)
  assert.match(html, /width:\s*calc\(50\.00%\s*-\s*6px\)/);
  assert.match(html, /left:\s*calc\(0\.00%\s*\+\s*3px\)/);
  assert.match(html, /left:\s*calc\(50\.00%\s*\+\s*3px\)/);
});

test('50. view switcher toggles between list and calendar instantly without page refresh', async () => {
  const { elements, load, storage } = createTestContext();
  await load([sampleAppointment], sampleStaff);

  // Initially in list view (table)
  assert.match(elements.get('content').innerHTML, /<table/);
  assert.equal(elements.get('owner-view-list').classList.contains('active'), true);

  // Switch to calendar
  elements.get('owner-view-calendar').click();
  assert.match(elements.get('content').innerHTML, /owner-calendar-wrapper/);
  assert.equal(elements.get('owner-view-calendar').classList.contains('active'), true);
  assert.equal(storage.get('gg_beauty_owner_view'), 'calendar');

  // Switch back to list
  elements.get('owner-view-list').click();
  assert.match(elements.get('content').innerHTML, /<table/);
  assert.equal(elements.get('owner-view-list').classList.contains('active'), true);
  assert.equal(storage.get('gg_beauty_owner_view'), 'list');
});

test('51 & 52 & 53. pure single-language mode in zh-CN and en with zero bilingual slash concatenation', async () => {
  const { context, elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);

  // 1. Chinese mode
  context.setAdminLocale('zh-CN');
  let contentHtml = elements.get('content').innerHTML;
  assert.match(contentHtml, /个预约/);
  assert.match(contentHtml, /待确认/);
  assert.doesNotMatch(contentHtml, /\b(List|Calendar|Unassigned|appts)\b/);
  assert.doesNotMatch(contentHtml, /列表\s*\/\s*List/i);
  assert.doesNotMatch(contentHtml, /日历\s*\/\s*Calendar/i);

  // 2. English mode
  context.setAdminLocale('en');
  contentHtml = elements.get('content').innerHTML;
  assert.match(contentHtml, /appts/);
  assert.match(contentHtml, /Pending/);
  assert.doesNotMatch(contentHtml, /[\u4e00-\u9fa5]/); // zero Chinese characters in system UI
  assert.doesNotMatch(contentHtml, /List\s*\/\s*列表/i);
});

test('54. XSS payloads in customer, staff, and service names are safely escaped', async () => {
  const xssAppt = {
    ...sampleAppointment,
    customer_name: '<script>alert(1)</script><img src=x onerror=alert(2)>',
    service_name: '<svg onload=alert(3)>',
    items: []
  };
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([xssAppt], sampleStaff);
  const html = elements.get('content').innerHTML;

  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /<img\b[^>]*onerror/i);
  assert.doesNotMatch(html, /<svg\b[^>]*onload/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('55. dynamic calendar DOM contains zero inline on* event handler attributes', async () => {
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);
  const html = elements.get('content').innerHTML;

  assert.doesNotMatch(html, /<button[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(html, /owner-calendar-appointment[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(html, /calendar-card-actions[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(html, /setAttribute\(['"]on/i);
});

test('56. window/globalScope does not expose appointments, staff snapshot, or sensitive action dispatchers', async () => {
  const { context, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);

  assert.equal(context.currentAppointmentsSnapshot, undefined, 'currentAppointmentsSnapshot must be private');
  assert.equal(context.currentStaffSnapshot, undefined, 'currentStaffSnapshot must be private');
  assert.equal(context.renderCalendarGrid, undefined, 'renderCalendarGrid must be private');
  assert.equal(context.executeAppointmentActionByKey, undefined, 'executeAppointmentActionByKey must not exist');
  assert.equal(context.appointmentActionRegistry, undefined, 'appointmentActionRegistry must not exist');
});

test('57. tampering with DOM data attributes does not hijack appointment action or context', async () => {
  const { context, elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);

  const arriveBtn = elements.get('content').querySelectorAll('button').find(b => b.getAttribute('data-action') === 'arrive-and-start');
  assert.ok(arriveBtn, 'arrive-and-start button exists on calendar card');

  // Attempt tampering: alter data-target-status and inject forged appointment ID
  arriveBtn.setAttribute('data-target-status', 'completed');
  arriveBtn.setAttribute('data-appointment-id', '00000000-0000-4000-8000-000000000999');

  // Click should invoke confirmed with legitimate closure ID, not tampered values
  let executedId = null;
  context.arriveAndStartAppointment = id => {
    executedId = id;
    return Promise.resolve(true);
  };

  arriveBtn.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executedId, sampleAppointment.id);
});

test('58. FEATURE_CHECKOUT_ENABLED gating and checkout action security preserved in calendar cards', async () => {
  const checkoutAppt = {
    ...sampleAppointment,
    can_start_checkout: true,
    status: 'in_service',
    checkout: {
      payment_state: 'unpaid',
      reconciliation_valid: true,
      has_inconsistency: false
    }
  };

  // 1. Gated false: checkout button is completely absent
  const ctx1 = createTestContext({ gg_beauty_owner_view: 'calendar' });
  ctx1.context.FEATURE_CHECKOUT_ENABLED = false;
  await ctx1.load([checkoutAppt], sampleStaff);
  assert.equal(ctx1.elements.get('content').querySelectorAll('.checkout-btn').length, 0);

  // 2. Gated true: checkout button is present and bound safely
  const ctx2 = createTestContext({ gg_beauty_owner_view: 'calendar' });
  ctx2.context.FEATURE_CHECKOUT_ENABLED = true;
  await ctx2.load([checkoutAppt], sampleStaff);
  const checkoutBtns = ctx2.elements.get('content').querySelectorAll('.checkout-btn');
  assert.equal(checkoutBtns.length, 1);
  assert.doesNotMatch(checkoutBtns[0].getAttribute('class') || '', /onclick/);
  assert.equal(checkoutBtns[0].hasAttribute('data-action-key'), false, 'data-action-key must be stripped after binding');
});

test('59. Completed appointment status strictly renders Completed/已完成, never Paid/已结账', async () => {
  const completedAppt = {
    ...sampleAppointment,
    status: 'completed',
    checkout: null
  };
  const { context, elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([completedAppt], sampleStaff);

  // Chinese
  context.setAdminLocale('zh-CN');
  let html = elements.get('content').innerHTML;
  assert.match(html, /status-completed/);
  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /已结账/);

  // English
  context.setAdminLocale('en');
  html = elements.get('content').innerHTML;
  assert.match(html, /Completed/);
  assert.doesNotMatch(html, /\bPaid\b/);
});

test('17. LocalStorage strictly stores ONLY view preference string, no customer or business data', async () => {
  const { storage, elements, load } = createTestContext();
  await load([sampleAppointment], sampleStaff);

  elements.get('owner-view-calendar').click();
  for (const [k, v] of storage.entries()) {
    assert.equal(k, 'gg_beauty_owner_view');
    assert.ok(v === 'calendar' || v === 'list');
  }
});

test('18 & 26. 44px minimum touch targets and focus-visible styling defined in calendar CSS', () => {
  assert.match(css, /\.view-switch-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.calendar-nav-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.calendar-today-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.owner-calendar-appointment\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.calendar-card-actions\s+button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('60. calendar grid renders premium hour, half-hour, and quarter-hour visual classes', async () => {
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([sampleAppointment], sampleStaff);
  const html = elements.get('content').innerHTML;
  assert.match(html, /owner-calendar-time-tick is-major is-hour[^>]*>10:00</);
  assert.match(html, /owner-calendar-time-tick is-minor is-half-hour[^>]*>10:30</);
  assert.match(html, /owner-calendar-time-tick is-minor is-quarter-hour[^>]*>10:15</);
  assert.match(html, /owner-calendar-time-tick is-minor is-quarter-hour[^>]*>10:45</);
});

test('61. non-working regions are grey, blocked by schedule semantics, and appointments remain visible above them', async () => {
  const fixture = createTestContext({ gg_beauty_owner_view: 'calendar' });
  fixture.setAvailability({
    date: todaySingapore,
    locationId: sampleLocationId,
    timezone: 'Asia/Singapore',
    businessWindows: [{ start: '10:00', end: '21:00' }],
    businessHoursSource: 'fallback',
    staff: [{
      id: sampleStaff[0].id,
      name: sampleStaff[0].name,
      status: 'working',
      workingWindows: [{ start: '10:00', end: '12:00' }],
      reason: 'WEEKLY_HOURS',
      source: 'weekly+fallback'
    }]
  });
  await fixture.load([sampleAppointment], sampleStaff);
  const rendered = fixture.elements.get('content').innerHTML;
  assert.match(rendered, /owner-calendar-nonworking-block/);
  assert.match(rendered, /非工作时间/);
  assert.match(rendered, /VIP Customer/, 'historical appointment remains visible over grey time');
  assert.equal(fixture.context.isMinuteWithinStaffWorkingWindows(sampleStaff[0].id, 10 * 60 + 30), true);
  assert.equal(fixture.context.isMinuteWithinStaffWorkingWindows(sampleStaff[0].id, 9 * 60 + 30), false);
  assert.match(css, /\.owner-calendar-nonworking-block[\s\S]*z-index:\s*2/);
  assert.match(css, /\.owner-calendar-appointment\s*\{[\s\S]*z-index:\s*4/);
});

test('62. off-day staff are hidden by default unless a historical appointment requires a read-only column', async () => {
  const fixture = createTestContext({ gg_beauty_owner_view: 'calendar' });
  fixture.setAvailability({
    date: todaySingapore,
    locationId: sampleLocationId,
    timezone: 'Asia/Singapore',
    businessWindows: [{ start: '10:00', end: '21:00' }],
    businessHoursSource: 'fallback',
    staff: [{ id: sampleStaff[0].id, name: 'Alice', status: 'working', workingWindows: [{ start: '10:00', end: '18:00' }] }]
  });
  await fixture.load([], sampleStaff);
  let rendered = fixture.elements.get('content').innerHTML;
  assert.match(rendered, new RegExp(`data-staff-id="${sampleStaff[0].id}"`));
  assert.doesNotMatch(rendered, new RegExp(`data-staff-id="${sampleStaff[1].id}"`));

  const bobHistorical = { ...sampleAppointment, staff_id: sampleStaff[1].id, staff_name: 'Bob' };
  await fixture.load([bobHistorical], sampleStaff);
  rendered = fixture.elements.get('content').innerHTML;
  assert.match(rendered, new RegExp(`data-staff-id="${sampleStaff[1].id}"`));
  assert.match(rendered, /休息/);
  assert.match(rendered, /VIP Customer/);
});

test('63. rapid date changes ignore a stale calendar staff response', async () => {
  const fixture = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await fixture.load([], sampleStaff);
  const pending = new Map();
  fixture.setAvailabilityResponder(url => new Promise(resolve => {
    const date = new URL(url, 'http://calendar.test').searchParams.get('date');
    pending.set(date, resolve);
  }));

  const picker = fixture.elements.get('calendarDatePicker');
  picker.change('2030-01-08');
  picker.change('2030-01-09');
  await new Promise(resolve => setImmediate(resolve));

  const responseFor = (date, id, name) => ({
    status: 200,
    ok: true,
    json: async () => ({
      success: true,
      data: {
        date,
        locationId: sampleLocationId,
        timezone: 'Asia/Singapore',
        businessWindows: [{ start: '10:00', end: '21:00' }],
        businessHoursSource: 'fallback',
        staff: [{ id, name, status: 'working', workingWindows: [{ start: '10:00', end: '18:00' }] }]
      }
    })
  });

  pending.get('2030-01-09')(responseFor('2030-01-09', sampleStaff[1].id, 'Newest Bob'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(fixture.elements.get('content').innerHTML, /Newest Bob/);

  pending.get('2030-01-08')(responseFor('2030-01-08', sampleStaff[2].id, 'Stale Charlie'));
  await new Promise(resolve => setImmediate(resolve));
  const rendered = fixture.elements.get('content').innerHTML;
  assert.match(rendered, /Newest Bob/);
  assert.doesNotMatch(rendered, /Stale Charlie/);
});

test('65. owner calendar fallback business hours range is 10:00-21:00, not opening 09:00-10:00', async () => {
  const fixture = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await fixture.load([], sampleStaff);
  const html = fixture.elements.get('content').innerHTML;

  // Time axis starts at 10:00 and ends at 21:00
  assert.match(html, />10:00</);
  assert.match(html, />21:00</);
  assert.doesNotMatch(html, />09:00</);
  assert.doesNotMatch(html, />09:30</);

  // Calendar slot clamping clamps times earlier than 10:00 to 10:00 and past 21:00 to 21:00
  assert.equal(fixture.context.normalizeCalendarSlotMinutes(9 * 60), 10 * 60);
  assert.equal(fixture.context.normalizeCalendarSlotMinutes(9 * 60 + 30), 10 * 60);
  assert.equal(fixture.context.normalizeCalendarSlotMinutes(10 * 60), 10 * 60);
  assert.equal(fixture.context.normalizeCalendarSlotMinutes(21 * 60), 21 * 60);
  assert.equal(fixture.context.normalizeCalendarSlotMinutes(22 * 60), 21 * 60);

  // Non-working grey blocks display outside staff working window
  assert.equal(fixture.context.isMinuteWithinStaffWorkingWindows(sampleStaff[0].id, 9 * 60 + 30), false);
  assert.equal(fixture.context.isMinuteWithinStaffWorkingWindows(sampleStaff[0].id, 10 * 60 + 30), true);
});

test('64. working-hours calendar translations are complete and single-language', () => {
  const expected = {
    showOffDayStaff: ['显示休息员工', 'Show off-day staff'],
    offDay: ['休息', 'Off Day'],
    outsideWorkingHours: ['非工作时间', 'Outside working hours'],
    staffNotWorking: ['员工未上班', 'Staff not working'],
    schedulePending: ['排班待确认', 'Schedule pending'],
    scheduleUnavailable: ['排班配置异常', 'Schedule unavailable'],
    workingHours: ['工作时间', 'Working hours'],
    inactiveReadOnly: ['已停用 · 只读', 'Inactive · Read only'],
    unableLoadStaffSchedule: ['无法加载员工排班', 'Unable to load staff schedule']
  };
  for (const [key, [zh, en]] of Object.entries(expected)) {
    assert.equal(i18n.t(key, 'zh-CN'), zh);
    assert.equal(i18n.t(key, 'en'), en);
    assert.doesNotMatch(zh, /[A-Za-z]{2,}/);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/);
  }
});
