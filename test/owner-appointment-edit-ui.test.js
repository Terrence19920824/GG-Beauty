'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sharedI18nPath = path.join(root, 'public', 'shared-i18n.js');
const calendarSharedCssPath = path.join(root, 'public', 'calendar-shared.css');
const adminHtmlPath = path.join(root, 'public', 'admin.html');

const i18n = require(sharedI18nPath);
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'admin.html inline script must exist');
const adminScript = scriptMatch[1];

// 1. Internationalization dictionary completeness and purity
test('1. i18n: all appointment adjustment keys are defined in zh-CN and en with pure languages', () => {
  const requiredKeys = [
    'adjustAppointment',
    'serviceAndPriceImmutableNotice',
    'newDate',
    'newTime',
    'estimatedEndTime',
    'selectStaff',
    'staffSkillMismatch',
    'customerSpecifiedStaffNotice',
    'reassignmentReason',
    'reassignmentReasonPlaceholder',
    'customerNotified',
    'customerAgreed',
    'conflictNoticeFrontDesk',
    'conflictNoticeOwner',
    'overrideConflict',
    'conflictReason',
    'conflictReasonPlaceholder',
    'saveAdjustment',
    'adjusting',
    'appointmentAdjustedSuccess',
    'reassignmentConsentRequired',
    'reassignmentReasonRequired',
    'conflictReasonRequired',
    'onlyPendingOrConfirmedEditable'
  ];

  for (const key of requiredKeys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `Missing zh-CN translation for: ${key}`);
    assert.ok(en, `Missing en translation for: ${key}`);
    assert.notStrictEqual(zh, key, `zh-CN translation for ${key} must not be identical to key`);
    assert.notStrictEqual(en, key, `en translation for ${key} must not be identical to key`);

    // Pure language checks: zh-CN should not contain English words (>=3 consecutive latin letters)
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `zh-CN translation for ${key} should not contain English words: "${zh}"`);
    // en should not contain Chinese characters
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en translation for ${key} should not contain Chinese characters: "${en}"`);
  }

  // Exact required error messages
  assert.strictEqual(i18n.t('staffSkillMismatch', 'zh-CN'), '该员工不会此项目，不能改派');
  assert.strictEqual(i18n.t('staffSkillMismatch', 'en'), 'This staff member cannot perform this service');
  assert.strictEqual(i18n.t('serviceAndPriceImmutableNotice', 'zh-CN'), '服务项目与价格不可修改');
  assert.strictEqual(i18n.t('serviceAndPriceImmutableNotice', 'en'), 'Service and price cannot be modified');
});

// 2. CSS touch targets and adjustment form styling
test('2. CSS: adjustment form elements have proper styles and >= 44px touch targets', () => {
  assert.match(calendarSharedCss, /\.drawer-adjust-btn\s*\{/, 'Must define .drawer-adjust-btn class');
  assert.match(calendarSharedCss, /\.adjust-form\s*\{/, 'Must define .adjust-form class');
  assert.match(calendarSharedCss, /\.adjust-immutable-banner\s*\{/, 'Must define .adjust-immutable-banner class');
  assert.match(calendarSharedCss, /\.adjust-endtime-box\s*\{/, 'Must define .adjust-endtime-box class');
  assert.match(calendarSharedCss, /\.adjust-alert\.danger\s*\{/, 'Must define .adjust-alert.danger class');
  assert.match(calendarSharedCss, /\.adjust-reassignment-box\s*\{/, 'Must define .adjust-reassignment-box class');
  assert.match(calendarSharedCss, /\.btn-adjust-save\s*\{/, 'Must define .btn-adjust-save class');
  assert.match(calendarSharedCss, /\.btn-adjust-cancel\s*\{/, 'Must define .btn-adjust-cancel class');

  // Verify touch target requirements
  assert.match(calendarSharedCss, /\.drawer-adjust-btn[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.adjust-input[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.adjust-select[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.adjust-checkbox-row[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);

  // Focus-visible and disabled styling
  assert.match(calendarSharedCss, /\.drawer-adjust-btn:focus-visible/);
  assert.match(calendarSharedCss, /\.btn-adjust-save:disabled/);
});

// Helper to create test context with DOM mocks
function createMockAdminContext(options = {}) {
  const elements = new Map();

  function makeMockElement(id, tag = 'DIV') {
    const listeners = new Map();
    const classList = new Set();
    const attrs = new Map();
    let internalId = id;
    let value = '';
    let checked = false;
    let disabled = false;

    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      _textContent: '',
      get id() {
        return internalId;
      },
      set id(val) {
        internalId = String(val || '');
        if (internalId) elements.set(internalId, this);
      },
      get value() {
        return value;
      },
      set value(v) {
        value = String(v == null ? '' : v);
      },
      get checked() {
        return checked;
      },
      set checked(c) {
        checked = Boolean(c);
      },
      get disabled() {
        return disabled;
      },
      set disabled(d) {
        disabled = Boolean(d);
      },
      get selected() {
        return Boolean(attrs.get('selected'));
      },
      set selected(s) {
        if (s) attrs.set('selected', 'selected');
        else attrs.delete('selected');
      },
      get textContent() {
        return this.children.length
          ? this.children.map(child => child.textContent).join('')
          : this._textContent;
      },
      set textContent(v) {
        this.children = [];
        this._textContent = String(v == null ? '' : v);
      },
      appendChild(child) {
        this.children.push(child);
        if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
          if (child.selected || !value) {
            value = child.value || '';
          }
        }
        return child;
      },
      replaceChildren(...children) {
        this.children = [...children];
        this._textContent = '';
      },
      hidden: false,
      style: {},
      classList: {
        add(...cls) { cls.forEach(c => classList.add(c)); },
        remove(...cls) { cls.forEach(c => classList.delete(c)); },
        contains(c) { return classList.has(c); },
        has(c) { return classList.has(c); }
      },
      get className() {
        return Array.from(classList).join(' ');
      },
      set className(v) {
        classList.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
      },
      getAttribute(k) { return attrs.get(k.toLowerCase()) ?? null; },
      setAttribute(k, v) { attrs.set(k.toLowerCase(), String(v)); },
      hasAttribute(k) { return attrs.has(k.toLowerCase()); },
      removeAttribute(k) { attrs.delete(k.toLowerCase()); },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        const arr = listeners.get(type) || [];
        listeners.set(type, arr.filter(h => h !== handler));
      },
      dispatchEvent(event) {
        const arr = listeners.get(event.type) || [];
        for (const h of arr) {
          h(event);
        }
      },
      async click() {
        const evt = { type: 'click', target: this, preventDefault() {}, stopPropagation() {} };
        const arr = listeners.get('click') || [];
        for (const h of arr) {
          await h(evt);
        }
      },
      focus() {},
      querySelector(selector) {
        if (selector.startsWith('#')) {
          const targetId = selector.slice(1);
          return elements.get(targetId) || null;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      }
    };

    if (id) {
      elements.set(id, el);
    }
    return el;
  }

  const standardIds = [
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
    'content',
    'appointmentDrawer',
    'appointmentDrawerBackdrop',
    'drawerTitle',
    'drawerCloseBtn',
    'drawerBody',
    'drawerFooter',
    'adminToast',
    'locationSelector'
  ];

  for (const id of standardIds) {
    makeMockElement(id);
  }

  const documentMock = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      return makeMockElement('', tag);
    },
    addEventListener() {},
    querySelectorAll() { return []; },
    documentElement: { lang: options.locale || 'zh-CN' }
  };

  const sandbox = {
    window: null,
    document: documentMock,
    globalThis: null,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    fetch: async (url, opts = {}) => {
      if (options.fetch) {
        const res = await options.fetch(url, opts);
        if (res) return res;
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: [] };
        }
      };
    },
    ownerSelfService: {
      _state: { locale: options.locale || 'zh-CN' },
      setLocale(loc) { this._state.locale = loc; },
      setProfile(p) {},
      reset() {}
    },
    localStorage: {
      getItem() { return options.locale || 'zh-CN'; },
      setItem() {}
    },
    location: { href: 'http://localhost/' },
    confirm: () => true,
    alert: () => {},
    ggI18n: i18n,
    URL: global.URL,
    Date: global.Date,
    Intl: global.Intl,
    Math: global.Math,
    RegExp: global.RegExp,
    Set: global.Set,
    Map: global.Map,
    Array: global.Array,
    Object: global.Object,
    String: global.String,
    Number: global.Number,
    Boolean: global.Boolean,
    JSON: global.JSON,
    Promise: global.Promise
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(adminScript, sandbox);

  return { sandbox, elements, documentMock, windowMock: sandbox };
}

// 3. UI Entry in Drawer
test('3. UI Entry: adjust button is displayed only for pending and confirmed appointments', () => {
  const { sandbox, elements } = createMockAdminContext();

  const makeAppt = (status) => ({
    id: '11111111-1111-4111-8111-111111111111',
    status,
    customer_name: 'Alice',
    customer_phone: '+6591234567',
    start_at: '2026-09-25T10:00:00.000Z',
    end_at: '2026-09-25T11:00:00.000Z',
    staff_id: '22222222-2222-4222-8222-222222222222',
    staff_name: 'Bob',
    items: [
      {
        service_id: '33333333-3333-4333-8333-333333333333',
        service_name: 'Manicure',
        duration_minutes: 60,
        price_snapshot: 50
      }
    ]
  });

  // Pending -> should have adjust button
  sandbox.renderAppointmentDrawer(makeAppt('pending'));
  const adjustBtnPending = elements.get('drawerAdjustBtn');
  assert.ok(adjustBtnPending, 'drawerAdjustBtn should exist for pending');
  assert.strictEqual(adjustBtnPending.textContent, '调整预约');

  // Confirmed -> should have adjust button
  sandbox.renderAppointmentDrawer(makeAppt('confirmed'));
  const adjustBtnConfirmed = elements.get('drawerAdjustBtn');
  assert.ok(adjustBtnConfirmed, 'drawerAdjustBtn should exist for confirmed');

  // Arrived, in_service, completed, cancelled, no_show -> should NOT have adjust button
  for (const st of ['arrived', 'in_service', 'completed', 'cancelled', 'no_show']) {
    elements.delete('drawerAdjustBtn');
    sandbox.renderAppointmentDrawer(makeAppt(st));
    const btn = elements.get('drawerAdjustBtn');
    assert.strictEqual(btn, undefined, `drawerAdjustBtn should NOT exist for status: ${st}`);
  }
});

// 4. Readonly Services and Price Display in Edit Mode
test('4. Form: services and price are read-only with immutable notice', () => {
  const { sandbox, elements } = createMockAdminContext();

  const appt = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'confirmed',
    customer_name: 'Alice',
    start_at: '2026-09-25T10:00:00.000Z',
    end_at: '2026-09-25T11:00:00.000Z',
    staff_id: '22222222-2222-4222-8222-222222222222',
    staff_name: 'Bob',
    items: [
      {
        service_id: '33333333-3333-4333-8333-333333333333',
        service_name: 'Deluxe Manicure',
        duration_minutes: 60,
        price_snapshot: 68
      }
    ]
  };

  sandbox.setActiveDrawerMode('adjust');
  sandbox.renderAppointmentDrawer(appt);

  const drawerBody = elements.get('drawerBody');
  assert.ok(drawerBody.textContent.includes('服务项目与价格不可修改'), 'Must display immutable banner');
  assert.ok(drawerBody.textContent.includes('Deluxe Manicure'), 'Must display service name');
  assert.ok(drawerBody.textContent.includes('68.00'), 'Must display price snapshot');

  // Ensure no inputs for price or services exist
  assert.strictEqual(elements.get('priceInput'), undefined);
  assert.strictEqual(elements.get('serviceInput'), undefined);
});

// 5. Dynamic End-time Calculation
test('5. End-time: automatically calculates new end time based on original duration', () => {
  const { sandbox, elements } = createMockAdminContext();

  // Test computeAdjustEndTime pure function
  assert.strictEqual(sandbox.computeAdjustEndTime('2026-09-25', '10:00', 45), '10:45');
  assert.strictEqual(sandbox.computeAdjustEndTime('2026-09-25', '14:30', 90), '16:00');
  assert.strictEqual(sandbox.computeAdjustEndTime('2026-09-25', '23:30', 45), '00:15 (+1)');
  assert.strictEqual(sandbox.computeAdjustEndTime('2026-09-25', '00:00', 120), '02:00');

  // Test inside rendered drawer
  const appt = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    start_at: '2026-09-25T02:00:00.000Z', // 10:00 Singapore
    end_at: '2026-09-25T03:15:00.000Z',   // 75 minutes duration
    items: [
      {
        service_id: '33333333-3333-4333-8333-333333333333',
        service_name: 'Full Facial',
        duration_minutes: 75
      }
    ]
  };

  sandbox.setActiveDrawerMode('adjust');
  sandbox.renderAppointmentDrawer(appt);

  const endTimeDisplay = elements.get('adjustEndTimeDisplay');
  assert.ok(endTimeDisplay, 'adjustEndTimeDisplay element must exist');
  assert.strictEqual(endTimeDisplay.textContent, '11:15');

  // Change start time input
  const timeInput = elements.get('adjustTimeInput');
  timeInput.value = '14:00';
  timeInput.dispatchEvent({ type: 'input' });

  assert.strictEqual(endTimeDisplay.textContent, '15:15');
});

// 6. Staff Skill Pre-Check and Hard Block
test('6. Staff skill check: mismatch shows red banner and disables save button', () => {
  const { sandbox, elements } = createMockAdminContext();

  const serviceId = '33333333-3333-4333-8333-333333333333';
  const staffQualified = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Skilled Staff',
    services: [serviceId]
  };
  const staffUnskilled = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Novice Staff',
    services: [] // no skills
  };

  // Provide mock staff snapshot
  sandbox.currentStaffSnapshot = [staffQualified, staffUnskilled];

  const appt = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'confirmed',
    staff_id: staffQualified.id,
    start_at: '2026-09-25T10:00:00.000Z',
    end_at: '2026-09-25T11:00:00.000Z',
    items: [
      {
        service_id: serviceId,
        service_name: 'Laser Treatment',
        duration_minutes: 60
      }
    ]
  };

  sandbox.setActiveDrawerMode('adjust');
  sandbox.renderAppointmentDrawer(appt);

  const staffSelect = elements.get('adjustStaffSelect');
  const skillAlert = elements.get('adjustSkillAlert');
  const saveBtn = elements.get('adjustSaveBtn');

  // Initially qualified staff selected -> no alert, save enabled
  assert.strictEqual(skillAlert.hidden, true);
  assert.strictEqual(saveBtn.disabled, false);

  // Switch to unskilled staff -> alert appears, save disabled
  staffSelect.value = staffUnskilled.id;
  staffSelect.dispatchEvent({ type: 'change' });

  assert.strictEqual(skillAlert.hidden, false);
  assert.strictEqual(skillAlert.textContent, '该员工不会此项目，不能改派');
  assert.strictEqual(saveBtn.disabled, true);

  // Switch back to skilled staff -> alert hides, save re-enabled
  staffSelect.value = staffQualified.id;
  staffSelect.dispatchEvent({ type: 'change' });

  assert.strictEqual(skillAlert.hidden, true);
  assert.strictEqual(saveBtn.disabled, false);
});

// 7. Customer-specified Staff Reassignment Form
test('7. Reassignment: triggers reason and consent checkboxes when requested staff changed', () => {
  const { sandbox, elements } = createMockAdminContext();

  const originalStaffId = '22222222-2222-4222-8222-222222222222';
  const newStaffId = '55555555-5555-4555-8555-555555555555';

  sandbox.currentStaffSnapshot = [
    { id: originalStaffId, name: 'Requested Staff' },
    { id: newStaffId, name: 'Substitute Staff' }
  ];

  const appt = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'confirmed',
    staff_selection_type: 'specific', // Customer requested this staff!
    staff_id: originalStaffId,
    start_at: '2026-09-25T10:00:00.000Z',
    end_at: '2026-09-25T11:00:00.000Z',
    items: [{ service_id: '33333333-3333-4333-8333-333333333333', duration_minutes: 60 }]
  };

  sandbox.setActiveDrawerMode('adjust');
  sandbox.renderAppointmentDrawer(appt);

  const staffSelect = elements.get('adjustStaffSelect');
  const reassignmentBox = elements.get('adjustReassignmentBox');
  const reasonTextarea = elements.get('adjustReassignmentReason');
  const notifiedCheckbox = elements.get('adjustCustomerNotified');
  const agreedCheckbox = elements.get('adjustCustomerAgreed');
  const saveBtn = elements.get('adjustSaveBtn');

  // Initially same staff -> reassignment box hidden
  assert.strictEqual(reassignmentBox.hidden, true);

  // Change to another staff -> reassignment box visible
  staffSelect.value = newStaffId;
  staffSelect.dispatchEvent({ type: 'change' });

  assert.strictEqual(reassignmentBox.hidden, false);
  assert.strictEqual(saveBtn.disabled, true, 'Save should be disabled until reason & consent are given');

  // Enter reason only
  reasonTextarea.value = 'Staff requested day off';
  reasonTextarea.dispatchEvent({ type: 'input' });
  assert.strictEqual(saveBtn.disabled, true);

  // Check notified only
  notifiedCheckbox.checked = true;
  notifiedCheckbox.dispatchEvent({ type: 'change' });
  assert.strictEqual(saveBtn.disabled, true);

  // Check agreed -> save enabled
  agreedCheckbox.checked = true;
  agreedCheckbox.dispatchEvent({ type: 'change' });
  assert.strictEqual(saveBtn.disabled, false);

  // Switch back to original staff -> reassignment box hidden, save enabled
  staffSelect.value = originalStaffId;
  staffSelect.dispatchEvent({ type: 'change' });
  assert.strictEqual(reassignmentBox.hidden, true);
  assert.strictEqual(saveBtn.disabled, false);
});

// 8. Conflict Handling Branch by Role
test('8. Conflict handling: front_desk cannot override; owner/manager can check override + reason', async () => {
  let requestCount = 0;
  let sentPayload = null;

  const mockFetch = async (url, opts) => {
    if (opts && opts.method === 'PATCH') {
      requestCount++;
      sentPayload = JSON.parse(opts.body);
      if (!sentPayload.overrideConflict) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            success: false,
            code: 'APPOINTMENT_COLLISION',
            message: '所选时间与现有预约存在冲突',
            canOverride: sentPayload.__testRole !== 'front_desk'
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      };
    }
    return { ok: true, json: async () => ({ success: true }) };
  };

  // Test 8A: front_desk role
  {
    const { sandbox, elements } = createMockAdminContext({ fetch: mockFetch });
    sandbox.setAdminProfile({ membership: { role: 'front_desk' } });
    sandbox.currentStaffSnapshot = [{ id: '22222222-2222-4222-8222-222222222222', name: 'Bob' }];

    const appt = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'confirmed',
      staff_id: '22222222-2222-4222-8222-222222222222',
      start_at: '2026-09-25T10:00:00.000Z',
      end_at: '2026-09-25T11:00:00.000Z',
      items: [{ service_id: '33333333-3333-4333-8333-333333333333', duration_minutes: 60 }]
    };

    sandbox.setActiveDrawerMode('adjust');
    sandbox.renderAppointmentDrawer(appt);

    const saveBtn = elements.get('adjustSaveBtn');
    await saveBtn.click();

    const conflictBox = elements.get('adjustConflictBox');
    const conflictMsg = elements.get('adjustConflictMessage');
    const overrideFields = elements.get('adjustOverrideFields');

    assert.strictEqual(conflictBox.hidden, false);
    assert.strictEqual(conflictMsg.textContent, '所选时间与现有预约存在冲突，前台角色无权强制重叠安排');
    assert.strictEqual(overrideFields.hidden, true, 'Override fields must be hidden for front_desk');
    assert.strictEqual(saveBtn.disabled, true);
  }

  // Test 8B: owner role
  {
    const { sandbox, elements } = createMockAdminContext({ fetch: mockFetch });
    sandbox.setAdminProfile({ membership: { role: 'owner' } });
    sandbox.currentStaffSnapshot = [{ id: '22222222-2222-4222-8222-222222222222', name: 'Bob' }];

    const appt = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'confirmed',
      staff_id: '22222222-2222-4222-8222-222222222222',
      start_at: '2026-09-25T10:00:00.000Z',
      end_at: '2026-09-25T11:00:00.000Z',
      items: [{ service_id: '33333333-3333-4333-8333-333333333333', duration_minutes: 60 }]
    };

    sandbox.setActiveDrawerMode('adjust');
    sandbox.renderAppointmentDrawer(appt);

    const saveBtn = elements.get('adjustSaveBtn');
    await saveBtn.click();

    const conflictBox = elements.get('adjustConflictBox');
    const conflictMsg = elements.get('adjustConflictMessage');
    const overrideFields = elements.get('adjustOverrideFields');
    const overrideCheckbox = elements.get('adjustOverrideConflict');
    const conflictReasonGroup = elements.get('adjustConflictReasonGroup');
    const conflictReason = elements.get('adjustConflictReason');

    assert.strictEqual(conflictBox.hidden, false);
    assert.strictEqual(conflictMsg.textContent, '所选时间与现有预约存在冲突。如需插单，请勾选强制重叠并填写原因。');
    assert.strictEqual(overrideFields.hidden, false, 'Override fields must be visible for owner');
    assert.strictEqual(saveBtn.disabled, true, 'Save should be disabled before checking override and reason');

    // Check override
    overrideCheckbox.checked = true;
    overrideCheckbox.dispatchEvent({ type: 'change' });
    assert.strictEqual(conflictReasonGroup.hidden, false);

    // Enter reason
    conflictReason.value = 'VIP customer urgent accommodation';
    conflictReason.dispatchEvent({ type: 'input' });
    assert.strictEqual(saveBtn.disabled, false);

    // Click save again
    await saveBtn.click();
    assert.strictEqual(sentPayload.overrideConflict, true);
    assert.strictEqual(sentPayload.conflictReason, 'VIP customer urgent accommodation');
  }
});

// 9. Payload Isolation (Zero Mutation of Services or Price)
test('9. Payload isolation: request body contains only date, time, staff, and reassignment/override fields', async () => {
  let interceptedBody = null;

  const mockFetch = async (url, opts) => {
    if (opts && opts.method === 'PATCH') {
      interceptedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  };

  const { sandbox, elements } = createMockAdminContext({ fetch: mockFetch });
  sandbox.currentStaffSnapshot = [{ id: '22222222-2222-4222-8222-222222222222', name: 'Bob' }];

  const appt = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'confirmed',
    staff_id: '22222222-2222-4222-8222-222222222222',
    start_at: '2026-09-25T10:00:00.000Z',
    end_at: '2026-09-25T11:00:00.000Z',
    items: [
      { service_id: '33333333-3333-4333-8333-333333333333', duration_minutes: 60, price_snapshot: 99 }
    ]
  };

  sandbox.setActiveDrawerMode('adjust');
  sandbox.renderAppointmentDrawer(appt);

  const saveBtn = elements.get('adjustSaveBtn');
  await saveBtn.click();

  assert.ok(interceptedBody, 'Body must have been sent');
  assert.ok(interceptedBody.newDate, 'newDate must exist');
  assert.ok(interceptedBody.newTime, 'newTime must exist');
  assert.ok(interceptedBody.newStaffId, 'newStaffId must exist');

  // Disallowed fields check
  assert.strictEqual(interceptedBody.serviceIds, undefined, 'serviceIds must not be sent');
  assert.strictEqual(interceptedBody.services, undefined, 'services must not be sent');
  assert.strictEqual(interceptedBody.price, undefined, 'price must not be sent');
  assert.strictEqual(interceptedBody.items, undefined, 'items must not be sent');
});
