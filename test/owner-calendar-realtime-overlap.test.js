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

const sampleStaff = [
  { id: '11111111-1111-4000-8000-000000000001', name: 'Alice', is_active: true },
  { id: '22222222-2222-4000-8000-000000000002', name: 'Bob', is_active: true }
];

const todaySingapore = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());

const getTodaySingaporeIso = (hour = 9, minute = 15) => {
  const [y, m, d] = todaySingapore.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hour - 8, minute, 0));
  return dt.toISOString();
};

function parseMockButtons(contentHtml) {
  const buttons = [];
  const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match;
  while ((match = buttonRegex.exec(contentHtml)) !== null) {
    buttons.push({ textContent: match[2].replace(/<[^>]*>/g, '').trim() });
  }
  return buttons;
}

const createTestContext = (initialStorage = {}) => {
  const elements = new Map();
  const storage = new Map(Object.entries(initialStorage));
  const intervals = [];

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
      setAttribute(k, v) { attrs.set(k.toLowerCase(), String(v)); },
      getAttribute(k) { return attrs.get(k.toLowerCase()) || null; },
      removeAttribute(k) { attrs.delete(k.toLowerCase()); },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      click() {
        const list = (listeners.get('click') || []).slice();
        for (const fn of list) fn({ type: 'click', target: this, preventDefault() {} });
      },
      querySelector() { return null; },
      querySelectorAll() { return []; }
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
  const contentEl = {
    id: 'content',
    get innerHTML() { return _contentHtml; },
    set innerHTML(val) { _contentHtml = String(val || ''); },
    get textContent() { return _contentHtml.replace(/<[^>]*>/g, ''); },
    set textContent(val) { _contentHtml = String(val || ''); },
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    querySelector(selector) {
      if (selector === '.owner-calendar-body') {
        if (!_contentHtml.includes('owner-calendar-body')) return null;
        return {
          querySelector(sub) {
            if (sub === '.owner-calendar-live-line') {
              if (!_contentHtml.includes('owner-calendar-live-line')) return null;
              return {
                style: {},
                querySelector() { return { textContent: '' }; },
                remove() {
                  _contentHtml = _contentHtml.replace(/<div class="owner-calendar-live-line"[\s\S]*?<\/div>/, '');
                }
              };
            }
            return null;
          },
          appendChild(childEl) {
            _contentHtml += `<div class="owner-calendar-live-line" style="${childEl.style?.top || ''}"></div>`;
          }
        };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.owner-calendar-appointment') return [];
      if (selector === 'tbody tr') return [];
      return [];
    }
  };
  elements.set('content', contentEl);

  const mockLocalStorage = {
    getItem: (k) => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };

  let currentApiAppointments = [];
  let currentApiStaff = sampleStaff;
  let customServerNow = `${todaySingapore}T02:00:00.000Z`; // 10:00 Singapore time

  const context = {
    console,
    Date,
    Intl,
    JSON,
    ggI18n: i18n,
    localStorage: mockLocalStorage,
    sessionStorage: mockLocalStorage,
    performance: { now: () => 1000 },
    setInterval: (fn, ms) => {
      const id = { fn, ms, unref: () => {} };
      intervals.push(id);
      return id;
    },
    clearInterval: (id) => {
      const idx = intervals.indexOf(id);
      if (idx !== -1) intervals.splice(idx, 1);
    },
    ownerSelfService: {
      _state: { locale: 'zh-CN', activeView: 'calendar' },
      setLocale(loc) { this._state.locale = loc; },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    alert: () => {},
    fetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments-db')) {
        return { status: 200, ok: true, json: async () => ({ success: true, data: currentApiAppointments }) };
      }
      if (urlStr.includes('/api/owner/staff')) {
        return { status: 200, ok: true, json: async () => ({ success: true, data: currentApiStaff }) };
      }
      if (urlStr.includes('/api/owner/calendar-context')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            data: {
              server_now: customServerNow,
              timezone: 'Asia/Singapore',
              location_id: '00000000-0000-0000-0000-000000000001'
            }
          })
        };
      }
      return { status: 200, ok: true, json: async () => ({ success: true }) };
    },
    document: {
      getElementById(id) { return elements.get(id); },
      querySelectorAll(selector) { return []; },
      createElement(tag) { return makeMockElement(tag); },
      addEventListener() {},
      removeEventListener() {}
    },
    window: {
      sessionStorage: mockLocalStorage,
      localStorage: mockLocalStorage,
      addEventListener() {},
      removeEventListener() {}
    },
    FEATURE_CHECKOUT_ENABLED: false
  };

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  vm.runInNewContext(scriptMatch[1], context, { filename: 'public/admin.html' });
  if (typeof context.setupCalendarToolbar === 'function') {
    context.setupCalendarToolbar();
  }

  const load = async (appts = currentApiAppointments, staff = currentApiStaff) => {
    currentApiAppointments = appts;
    currentApiStaff = staff;
    await context.loadAppointments();
  };

  return {
    context,
    elements,
    intervals,
    load,
    setServerNow: (iso) => { customServerNow = iso; }
  };
};

// ============================================================================
// 1. GREEN CURRENT TIME LINE VISUAL RULES
// ============================================================================

test('1. owner-calendar-live-line is defined as green (#10b981) in calendar-shared.css', () => {
  assert.match(css, /\.owner-calendar-live-line\s*\{[^}]*background-color:\s*#10b981/, 'Live line must be green #10b981');
  assert.match(css, /\.owner-calendar-live-line\s*\{[^}]*pointer-events:\s*none/, 'Live line must have pointer-events: none');
  assert.match(css, /\.live-line-dot\s*\{[^}]*background-color:\s*#10b981/, 'Live line dot must be green #10b981');
  assert.match(css, /\.live-line-dot\s*\{[^}]*box-shadow:[^}]*rgba\(\s*16\s*,\s*185\s*,\s*129/, 'Live line dot glow must be green');
  assert.match(css, /\.live-line-badge\s*\{[^}]*background-color:\s*#10b981/, 'Live line badge must be green #10b981');
  assert.match(css, /\.live-line-rule\s*\{[^}]*background-color:\s*#10b981/, 'Live line rule must be green #10b981');
});

// ============================================================================
// 2. POINTER-EVENTS: NONE ON TIME LINE AND ALL CHILDREN
// ============================================================================

test('2. owner-calendar-live-line and all child elements have pointer-events: none', () => {
  assert.match(css, /\.owner-calendar-live-line\s*,\s*\.owner-calendar-live-line\s*\*/, 'Live line selector must target both container and all children');
  assert.match(css, /\.owner-calendar-live-line[\s\S]*?pointer-events:\s*none\s*!important/, 'Live line and its children must never intercept clicks');
});

// ============================================================================
// 3. 60-SECOND AUTO-REFRESH TIMER
// ============================================================================

test('3. startLiveLineTimer schedules update every 60 seconds (60000ms)', async () => {
  const { intervals, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([], sampleStaff);

  const timer = intervals.find(i => i.ms === 60000);
  assert.ok(timer, 'A 60000ms (60s) timer must be scheduled for live line auto-update');
  assert.equal(timer.ms, 60000, 'Live line update interval must be exactly 60000ms');
});

// ============================================================================
// 4. HIDE LIVE LINE WHEN VIEWING NON-TODAY DATES
// ============================================================================

test('4. Live time line is rendered for today but hidden when navigating to yesterday/tomorrow', async () => {
  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([], sampleStaff);

  const contentHtmlToday = elements.get('content').innerHTML;
  assert.match(contentHtmlToday, /owner-calendar-live-line/, 'Live line must be present for today in business hours');

  // Navigate to tomorrow via Next Day button
  elements.get('calendarNextDayBtn').click();

  const contentHtmlFuture = elements.get('content').innerHTML;
  assert.doesNotMatch(contentHtmlFuture, /owner-calendar-live-line/, 'Live line must be hidden for non-today date');

  // Navigate back to today via Prev Day button
  elements.get('calendarPrevDayBtn').click();

  const contentHtmlRestored = elements.get('content').innerHTML;
  assert.match(contentHtmlRestored, /owner-calendar-live-line/, 'Live line must be restored when returning to today');
});

// ============================================================================
// 5. HIDE LIVE LINE OUTSIDE BUSINESS HOURS (09:00 - 21:00)
// ============================================================================

test('5. Live time line is hidden when current time is outside 09:00 - 21:00', async () => {
  const { context, elements, load, setServerNow } = createTestContext({ gg_beauty_owner_view: 'calendar' });

  // 08:30 (before 09:00) -> 00:30 UTC
  setServerNow(`${todaySingapore}T00:30:00.000Z`);
  await load([], sampleStaff);

  let htmlEarly = elements.get('content').innerHTML;
  assert.doesNotMatch(htmlEarly, /owner-calendar-live-line/, 'Live line must not show at 08:30 (before 09:00)');

  // 21:30 (after 21:00) -> 13:30 UTC
  setServerNow(`${todaySingapore}T13:30:00.000Z`);
  await load([], sampleStaff);

  let htmlLate = elements.get('content').innerHTML;
  assert.doesNotMatch(htmlLate, /owner-calendar-live-line/, 'Live line must not show at 21:30 (after 21:00)');

  // 14:00 (inside 09:00-21:00) -> 06:00 UTC
  setServerNow(`${todaySingapore}T06:00:00.000Z`);
  await load([], sampleStaff);

  let htmlValid = elements.get('content').innerHTML;
  assert.match(htmlValid, /owner-calendar-live-line/, 'Live line must show at 14:00 (inside 09:00-21:00)');
  // (840 - 540) * 1.25 = 375px
  assert.match(htmlValid, /top:\s*375\.0px/);
});

// ============================================================================
// 6. OVERLAPPING APPOINTMENTS DISPLAY SIDE-BY-SIDE IN CONCURRENT LANES
// ============================================================================

test('6. Overlapping appointments within same staff column render in concurrent lanes side-by-side', async () => {
  const apptA = {
    id: '00000000-0000-4000-8000-000000000001',
    start_at: getTodaySingaporeIso(10, 0),
    end_at: getTodaySingaporeIso(11, 0),
    customer_name: 'Customer A',
    staff_name: 'Alice',
    staff_id: '11111111-1111-4000-8000-000000000001',
    status: 'confirmed',
    items: []
  };
  const apptB = {
    id: '00000000-0000-4000-8000-000000000002',
    start_at: getTodaySingaporeIso(10, 30),
    end_at: getTodaySingaporeIso(11, 30),
    customer_name: 'Customer B',
    staff_name: 'Alice',
    staff_id: '11111111-1111-4000-8000-000000000001',
    status: 'pending',
    items: []
  };

  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([apptA, apptB], sampleStaff);

  const htmlContent = elements.get('content').innerHTML;

  assert.match(htmlContent, /has-overlap/);
  // Both cards have 50% width
  assert.match(htmlContent, /width:\s*calc\(50\.00%\s*-\s*6px\)/);
  // Lane 0 is left 0%
  assert.match(htmlContent, /left:\s*calc\(0\.00%\s*\+\s*3px\)/);
  // Lane 1 is left 50%
  assert.match(htmlContent, /left:\s*calc\(50\.00%\s*\+\s*3px\)/);
});

// ============================================================================
// 7. PROMINENT OVERLAP BADGE VISIBLE ON SHORT APPOINTMENTS
// ============================================================================

test('7. Overlap badge is prominently rendered near the top of the card before customer name', async () => {
  const shortApptA = {
    id: '00000000-0000-4000-8000-000000000010',
    start_at: getTodaySingaporeIso(14, 0),
    end_at: getTodaySingaporeIso(14, 30), // 30 min short appointment
    customer_name: 'Short Appt One',
    staff_name: 'Alice',
    staff_id: '11111111-1111-4000-8000-000000000001',
    status: 'confirmed',
    items: []
  };
  const shortApptB = {
    id: '00000000-0000-4000-8000-000000000011',
    start_at: getTodaySingaporeIso(14, 15),
    end_at: getTodaySingaporeIso(14, 45), // 30 min short appointment
    customer_name: 'Short Appt Two',
    staff_name: 'Alice',
    staff_id: '11111111-1111-4000-8000-000000000001',
    status: 'pending',
    items: []
  };

  const { elements, load } = createTestContext({ gg_beauty_owner_view: 'calendar' });
  await load([shortApptA, shortApptB], sampleStaff);

  const htmlContent = elements.get('content').innerHTML;

  // Check that calendar-card-conflict exists and contains 重叠
  assert.match(htmlContent, /calendar-card-conflict/);
  assert.match(htmlContent, /重叠/);

  // Check DOM order: overlap badge must appear BEFORE customer name
  const overlapIdx = htmlContent.indexOf('calendar-card-conflict');
  const customerIdx = htmlContent.indexOf('calendar-card-customer');
  assert.ok(overlapIdx !== -1, 'Overlap badge must exist');
  assert.ok(customerIdx !== -1, 'Customer name must exist');
  assert.ok(overlapIdx < customerIdx, 'Overlap badge must appear before customer name for high visibility');
});

// ============================================================================
// 8. BILINGUAL TEXT PURITY (ZH-CN AND EN)
// ============================================================================

test('8. appointmentOverlap and currentTime are 100% pure Chinese and pure English with no slashes', () => {
  for (const key of ['appointmentOverlap', 'currentTime']) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `zh-CN key ${key} must exist`);
    assert.ok(en, `en key ${key} must exist`);
    assert.doesNotMatch(zh, /[a-zA-Z]/, `zh text for ${key} must not contain English characters`);
    assert.doesNotMatch(zh, /\//, `zh text for ${key} must not contain slashes`);
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en text for ${key} must not contain Chinese characters`);
    assert.doesNotMatch(en, /\//, `en text for ${key} must not contain slashes`);
  }
});
