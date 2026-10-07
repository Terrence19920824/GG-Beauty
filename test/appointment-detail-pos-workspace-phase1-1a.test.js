'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const calendarSharedCss = fs.readFileSync(path.join(root, 'public', 'calendar-shared.css'), 'utf8');
const customerBookingQueryPath = path.join(root, 'lib', 'customer-booking-query.js');
const customerBookingQuerySource = fs.readFileSync(customerBookingQueryPath, 'utf8');
const bookingNotificationsPath = path.join(root, 'lib', 'booking-notifications.js');
const bookingNotificationsSource = fs.readFileSync(bookingNotificationsPath, 'utf8');

const i18n = require('../public/shared-i18n.js');
const customerBookingQuery = require('../lib/customer-booking-query');
const bookingNotifications = require('../lib/booking-notifications');

const {
  deriveBillingSummary,
  projectOwnerAppointmentCheckout
} = require('../lib/owner-appointment-checkout-projection');

// Helper to build a mock DOM environment for testing admin.html drawer rendering
function createMockAdminContext(options = {}) {
  const elements = new Map();

  function makeMockElement(id, tag = 'DIV') {
    const listeners = new Map();
    const classList = new Set();
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      children: [],
      _textContent: '',
      _value: '',
      get value() { return this._value; },
      set value(v) { this._value = String(v == null ? '' : v); },
      get className() { return Array.from(classList).join(' '); },
      set className(val) {
        classList.clear();
        String(val || '').split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
      },
      get textContent() {
        return this.children.length
          ? this.children.map(child => child.textContent).join('')
          : this._textContent;
      },
      set textContent(value) {
        this.children = [];
        this._textContent = String(value == null ? '' : value);
      },
      _innerHTML: '',
      get innerHTML() {
        return this._innerHTML;
      },
      set innerHTML(val) {
        this._innerHTML = String(val || '');
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.children = children;
        this._textContent = '';
        this._innerHTML = '';
      },
      hidden: false,
      disabled: false,
      style: {},
      classList: {
        add(...cls) { cls.forEach(c => classList.add(c)); },
        remove(...cls) { cls.forEach(c => classList.delete(c)); },
        contains(c) { return classList.has(c); },
        has(c) { return classList.has(c); }
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
        arr.forEach(h => h(event));
      },
      click() {
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
      },
      focus() {},
      querySelector(selector) {
        return findDescendant(this, node => matchesSelector(node, selector));
      },
      querySelectorAll(selector) {
        const results = [];
        collectDescendants(this, node => matchesSelector(node, selector), results);
        return results;
      }
    };
    return el;
  }

  function matchesSelector(node, selector) {
    if (!node || !selector) return false;
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return node.classList && node.classList.contains(selector.slice(1));
    return node.tagName && node.tagName.toLowerCase() === selector.toLowerCase();
  }

  function collectDescendants(node, predicate, results) {
    if (!node || !node.children) return;
    for (const child of node.children) {
      if (predicate(child)) results.push(child);
      collectDescendants(child, predicate, results);
    }
  }

  const standardIds = [
    'loginOverlay', 'adminContent', 'loginMessage', 'ownerLoginIdentifier',
    'adminPassword', 'ownerShopSlug', 'totalCount', 'pendingCount',
    'todayCount', 'adminLanguageZh', 'adminLanguageEn', 'content',
    'appointmentDrawer', 'appointmentDrawerBackdrop', 'drawerTitle',
    'drawerCloseBtn', 'drawerBody', 'drawerFooter', 'adminToast'
  ];

  standardIds.forEach(id => {
    elements.set(id, makeMockElement(id));
  });

  const alerts = [];
  const requests = [];

  const context = {
    console,
    Date,
    Intl,
    JSON,
    setTimeout,
    clearTimeout,
    Math,
    RegExp,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
    ggI18n: i18n,
    ownerSelfService: {
      _state: { locale: options.locale || 'zh-CN' },
      setLocale(loc) { this._state.locale = loc; },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    prompt: () => '',
    alert: msg => alerts.push(msg),
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      return {
        status: 200,
        ok: true,
        async json() { return { success: true, data: [] }; }
      };
    },
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement(tag) { return makeMockElement('', tag); },
      querySelector(sel) { return null; },
      querySelectorAll(sel) { return []; },
      addEventListener() {}
    }
  };
  context.globalThis = context;
  context.window = context;

  const scriptMatch = adminHtml.match(/<script(?:\s+type="application\/javascript")?>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    vm.runInNewContext(scriptMatch[1], context, { filename: 'public/admin.html' });
  }

  return { context, elements, alerts, requests };
}

function findDescendant(node, predicate) {
  if (!node || !node.children) return null;
  for (const child of node.children) {
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

function findAllDescendants(node, predicate) {
  const matches = [];
  function search(curr) {
    if (!curr || !curr.children) return;
    for (const child of curr.children) {
      if (predicate(child)) matches.push(child);
      search(child);
    }
  }
  search(node);
  return matches;
}

// -------------------------------------------------------------
// Test Suite: APPOINTMENT DETAIL POS WORKSPACE PHASE 1.1A
// -------------------------------------------------------------

test('1. i18n purity: Phase 1.1A keys exist and follow single-language purity', () => {
  const phaseKeys = [
    'colCustomerAndAppointment',
    'colAppointmentItems',
    'colOrderSummary',
    'itemStatus',
    'subtotal',
    'discount',
    'notCheckedOut',
    'unbilledCount',
    'billingCoverageUnavailable',
    'payBill',
    'payBillUnavailable',
    'notAssigned',
    'staffOnly',
    'notProvided',
    'customerAssets',
    'membershipCard',
    'pointsBalance',
    'storedValueBalance',
    'packageRemaining',
    'membershipExpiry'
  ];

  for (const key of phaseKeys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `Missing zh-CN translation for ${key}`);
    assert.ok(en, `Missing en translation for ${key}`);

    // zh-CN purity: strip template placeholders like {count} before testing for ASCII words >= 3 chars
    const zhClean = zh.replace(/\{[a-zA-Z0-9_]+\}/g, '');
    assert.doesNotMatch(zhClean, /[a-zA-Z]{3,}/, `zh-CN translation for ${key} contains English: "${zh}"`);
    // en purity: no Chinese characters
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en translation for ${key} contains Chinese: "${en}"`);
  }
});

test('2. CSS responsive rules: 3-column >=1180px, 2-column 768-1179px, 1-column <768px, >=44px touch targets', () => {
  assert.match(calendarSharedCss, /\.pos-workspace-columns\s*\{/, 'Must define .pos-workspace-columns');
  assert.match(calendarSharedCss, /@media\s*\(min-width:\s*1180px\)[\s\S]*?\.pos-workspace-columns\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(calendarSharedCss, /@media\s*\(min-width:\s*768px\)\s+and\s+\(max-width:\s*1179px\)[\s\S]*?\.drawer-workspace-col-right\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
  assert.match(calendarSharedCss, /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pos-workspace-columns\s*\{[\s\S]*?grid-template-columns:\s*1fr/);

  // Pay bill button touch target >= 44px
  assert.match(calendarSharedCss, /\.drawer-pay-bill-btn\s*\{[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
});

test('3. Three-column workspace rendering structure: column headers and container exist', () => {
  for (const locale of ['zh-CN', 'en']) {
    const { context, elements } = createMockAdminContext({ locale });
    const appointment = {
      id: '11111111-1111-4111-8111-111111111111',
      appointment_no: 'A-20261007-001',
      status: 'confirmed',
      start_at: '2026-10-07T10:00:00Z',
      end_at: '2026-10-07T11:00:00Z',
      customer_name: 'Alice',
      customer_phone: '+6591234567',
      items: [{ item_id: 'item-1', sequence_no: 1, service_name_snapshot: 'Facial', duration_minutes_snapshot: 60, price_snapshot_minor: '8000' }]
    };

    context.renderAppointmentDrawer(appointment);
    const drawerBody = elements.get('drawerBody');

    const col1 = findDescendant(drawerBody, el => el.classList && el.classList.contains('drawer-workspace-col-left'));
    const col2 = findDescendant(drawerBody, el => el.classList && el.classList.contains('drawer-workspace-col-middle'));
    const col3 = findDescendant(drawerBody, el => el.classList && el.classList.contains('drawer-workspace-col-right'));

    assert.ok(col1, 'Column 1 (Customer & Appointment) must be rendered');
    assert.ok(col2, 'Column 2 (Appointment Items) must be rendered');
    assert.ok(col3, 'Column 3 (Order Summary) must be rendered');

    assert.ok(col1.textContent.includes(i18n.t('colCustomerAndAppointment', locale)));
    assert.ok(col2.textContent.includes(i18n.t('colAppointmentItems', locale)));
    assert.ok(col3.textContent.includes(i18n.t('colOrderSummary', locale)));
  }
});

test('4. Left column & True Read-Only: notes are static text (no textarea/save/PATCH), adjust entry is absent, birthday displayed', () => {
  const { context, elements, requests } = createMockAdminContext({ locale: 'zh-CN' });

  // Case A: Missing birthday -> shows "未填写", notes rendered as static text with no textarea or save buttons
  context.renderAppointmentDrawer({
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    booking_source: 'online',
    booking_channel: 'instagram',
    customer_name: 'Bob',
    customer_phone: '+6591234567',
    date_of_birth: null,
    profile_notes: 'Prefers tea over coffee',
    internal_notes: 'VIP Client',
    customer_special_request: 'Quiet room'
  });

  const bodyA = elements.get('drawerBody');
  assert.ok(bodyA.textContent.includes('Bob'));
  assert.ok(bodyA.textContent.includes('未填写'), 'Missing birthday must show 未填写');
  assert.ok(bodyA.textContent.includes('仅员工可见'), 'Internal notes must display 仅员工可见');
  assert.ok(bodyA.textContent.includes('Quiet room'));
  assert.ok(bodyA.textContent.includes('Prefers tea over coffee'));
  assert.ok(bodyA.textContent.includes('VIP Client'));

  // Strict Read-Only Assertions: No textarea anywhere in drawer
  const textareaA = findDescendant(bodyA, el => el.tagName === 'TEXTAREA' || el.id === 'drawerInternalNotesInput' || el.id === 'drawerProfileNotesInput');
  assert.strictEqual(textareaA, null, 'Workspace must NOT contain any textarea inputs');

  // No save buttons anywhere in drawer
  const saveBtnA = findDescendant(bodyA, el => String(el.className || '').includes('save') || String(el.id || '').includes('save'));
  assert.strictEqual(saveBtnA, null, 'Workspace must NOT contain any save buttons');

  // No PATCH / mutation requests triggered
  assert.strictEqual(requests.filter(r => r.opts?.method === 'PATCH').length, 0, 'No PATCH calls must be initiated');

  // Static note elements must exist with specialized classes
  const profileNotesVal = findDescendant(bodyA, el => el.classList && el.classList.contains('drawer-profile-notes-value'));
  assert.ok(profileNotesVal, 'Profile notes static element must exist');
  assert.strictEqual(profileNotesVal.textContent, 'Prefers tea over coffee');

  const internalNotesVal = findDescendant(bodyA, el => el.classList && el.classList.contains('drawer-internal-notes-value'));
  assert.ok(internalNotesVal, 'Internal notes static element must exist');
  assert.strictEqual(internalNotesVal.textContent, 'VIP Client');

  const specialReqVal = findDescendant(bodyA, el => el.classList && el.classList.contains('drawer-special-request-value'));
  assert.ok(specialReqVal, 'Special request static element must exist');
  assert.strictEqual(specialReqVal.textContent, 'Quiet room');

  // Case B: Real birthday provided -> shows actual birthday
  context.renderAppointmentDrawer({
    id: '22222222-2222-4222-8222-222222222222',
    status: 'pending',
    customer_name: 'Charlie',
    customer_phone: '+6591234568',
    date_of_birth: '1992-06-18'
  });
  const bodyB = elements.get('drawerBody');
  assert.ok(bodyB.textContent.includes('1992-06-18'), 'Real birthday must be displayed');

  // Case C: Adjust Appointment entry point is completely absent across ALL statuses
  for (const st of ['pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show']) {
    context.renderAppointmentDrawer({
      id: `33333333-3333-4333-8333-0000000000${st.length}`,
      status: st,
      customer_name: 'Adjust Test',
      customer_phone: '+6591234560',
      items: [{ item_id: 'item-1', sequence_no: 1, service_name_snapshot: 'Facial' }]
    });
    const adjustBtn = elements.get('drawerAdjustBtn') || findDescendant(elements.get('drawerBody'), el => el.id === 'drawerAdjustBtn');
    assert.strictEqual(adjustBtn, null, `Adjust appointment button must NOT exist in workspace for status: ${st}`);
  }
});

test('5. Customer asset tiles: member_code alone does NOT render membership card tile; real tier/status/expiry renders tile with expiry; no fake 0 or mock tiles', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  // Case A: ONLY member_code present (membership_enabled: true, but no tier/status/expiry)
  context.renderAppointmentDrawer({
    id: '44444444-4444-4444-8444-444444444441',
    status: 'confirmed',
    customer_name: 'Only Member Code',
    customer_phone: '+6591234561',
    member_code: 'MEM-ONLY-999',
    membership_enabled: true
    // no membership_tier_name, tier_code, status, or expires_at
  });
  const bodyA = elements.get('drawerBody');
  // Member code is visible in customer info section
  assert.ok(bodyA.textContent.includes('MEM-ONLY-999'), 'Customer profile section must show member_code');
  // But membership card asset tile must NOT be rendered
  const membershipTileA = findDescendant(bodyA, el => el.classList && el.classList.contains('drawer-asset-membership'));
  assert.strictEqual(membershipTileA, null, 'Membership card tile must NOT render when only member_code is present');

  // Case B: Real membership data with tier, code, status, and expires_at
  context.renderAppointmentDrawer({
    id: '44444444-4444-4444-8444-444444444442',
    status: 'confirmed',
    customer_name: 'Full Member',
    customer_phone: '+6591234562',
    member_code: 'MEM-VIP-888',
    membership_enabled: true,
    membership_tier_name: 'Gold Diamond VIP',
    membership_status: 'active',
    membership_expires_at: '2028-11-30T00:00:00.000Z'
  });
  const bodyB = elements.get('drawerBody');
  const membershipTileB = findDescendant(bodyB, el => el.classList && el.classList.contains('drawer-asset-membership'));
  assert.ok(membershipTileB, 'Membership card tile MUST render when authentic membership data exists');
  assert.ok(membershipTileB.textContent.includes('Gold Diamond VIP'), 'Tile must display tier name');
  assert.ok(membershipTileB.textContent.includes('MEM-VIP-888'), 'Tile must display member code');
  assert.ok(membershipTileB.textContent.includes('有效'), 'Tile must display active status');
  assert.ok(membershipTileB.textContent.includes('2028-11-30'), 'Tile must display formatted expiry date');

  // Case C: Non-mock, authentic asset values; never fake 0 or mock tiles
  context.renderAppointmentDrawer({
    id: '44444444-4444-4444-8444-444444444443',
    status: 'confirmed',
    customer_name: 'Assets Test',
    customer_phone: '+6591234563',
    points_enabled: true,
    points_balance: 1250,
    stored_value_enabled: true,
    stored_value_balance_minor: 18000,
    packages_enabled: true,
    package_remaining: 5
  });
  const bodyC = elements.get('drawerBody');
  const pointsTile = findDescendant(bodyC, el => el.classList && el.classList.contains('drawer-asset-points'));
  assert.ok(pointsTile, 'Points tile must render when points_enabled is true');
  assert.ok(pointsTile.textContent.includes('1250'), 'Points tile must display exact points balance');

  const svTile = findDescendant(bodyC, el => el.classList && el.classList.contains('drawer-asset-stored-value'));
  assert.ok(svTile, 'Stored value tile must render when stored_value_enabled is true');
  assert.ok(svTile.textContent.includes('$180.00'), 'Stored value tile must display formatted currency');

  const pkgTile = findDescendant(bodyC, el => el.classList && el.classList.contains('drawer-asset-package'));
  assert.ok(pkgTile, 'Package tile must render when packages_enabled is true');
  assert.ok(pkgTile.textContent.includes('5'), 'Package tile must display remaining package count');

  // Case D: Disabled features or null/undefined balances MUST NOT generate tiles (no fake 0s)
  context.renderAppointmentDrawer({
    id: '44444444-4444-4444-8444-444444444444',
    status: 'confirmed',
    customer_name: 'Disabled Assets',
    customer_phone: '+6591234564',
    membership_enabled: false,
    points_enabled: false,
    stored_value_enabled: false,
    packages_enabled: false
  });
  const bodyD = elements.get('drawerBody');
  const assetSectionD = findDescendant(bodyD, el => el.classList && el.classList.contains('drawer-asset-section'));
  assert.strictEqual(assetSectionD, null, 'Must NOT render any asset section when features are disabled');
});

test('6. Middle column: multi-service ordering, prices, duration, primary/assistant staff, item status, and strictly NO edit/add controls', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });
  const appointment = {
    id: '55555555-5555-4555-8555-555555555555',
    status: 'in_service',
    items: [
      {
        item_id: 'item-2',
        sequence_no: 2,
        service_name_snapshot: 'Hair Treatment',
        duration_minutes_snapshot: 45,
        price_snapshot_minor: '12000',
        status: 'pending',
        staff_assignments: [{ role: 'primary', staff_name: 'Kelly' }]
      },
      {
        item_id: 'item-1',
        sequence_no: 1,
        service_name_snapshot: 'Haircut',
        duration_minutes_snapshot: 30,
        price_snapshot_minor: '5000',
        status: 'in_service',
        staff_assignments: [
          { role: 'primary', staff_name: 'John' },
          { role: 'assistant', staff_name: 'Alex' }
        ]
      }
    ]
  };

  context.renderAppointmentDrawer(appointment);
  const drawerBody = elements.get('drawerBody');

  const itemCards = findAllDescendants(drawerBody, el => el.classList && el.classList.contains('drawer-item-card'));
  assert.equal(itemCards.length, 2, 'Must render two service item cards');

  // Verify sorted by sequence_no
  assert.ok(itemCards[0].textContent.includes('#1'));
  assert.ok(itemCards[0].textContent.includes('Haircut'));
  assert.ok(itemCards[0].textContent.includes('John'));
  assert.ok(itemCards[0].textContent.includes('Alex'));
  assert.ok(itemCards[0].textContent.includes('30 分钟'));
  assert.ok(itemCards[0].textContent.includes('$50.00'));

  assert.ok(itemCards[1].textContent.includes('#2'));
  assert.ok(itemCards[1].textContent.includes('Hair Treatment'));
  assert.ok(itemCards[1].textContent.includes('Kelly'));
  assert.ok(itemCards[1].textContent.includes('未分配')); // assistant staff missing -> '未分配'

  // Strictly NO add item / add product / edit / delete buttons
  const addServiceBtn = findDescendant(drawerBody, el => el.id === 'drawerAddServiceBtn');
  assert.equal(addServiceBtn, null, 'Must NOT contain Add Service button');

  const anyAddOrEditBtn = findDescendant(drawerBody, el => {
    const text = (el.textContent || '').toLowerCase();
    return text.includes('添加项目') || text.includes('add service') || text.includes('添加产品') || text.includes('修改项目');
  });
  assert.equal(anyAddOrEditBtn, null, 'Must NOT contain any add or edit service/product controls');
});

test('7. Right column: unbilled count, checkout states, disabled pay bill button without POST triggers', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  // Case A: Not checked out with unbilled count = 1
  context.renderAppointmentDrawer({
    id: '66666666-6666-4666-8666-666666666661',
    status: 'arrived',
    items: [{ item_id: 'item-1', sequence_no: 1, service_name_snapshot: 'Massage' }],
    checkout: null,
    billing_summary: {
      appointment_service_item_count: 1,
      billed_service_item_count: 0,
      unbilled_service_item_count: 1
    }
  });

  const bodyA = elements.get('drawerBody');
  assert.ok(bodyA.textContent.includes('尚未结账'));
  assert.ok(bodyA.textContent.includes(i18n.t('unbilledCount', 'zh-CN', { count: 1 })));

  const payBtnA = findDescendant(bodyA, el => el.classList && el.classList.contains('drawer-pay-bill-btn'));
  assert.ok(payBtnA, 'Pay bill button must exist');
  assert.equal(payBtnA.disabled, true, 'Pay bill button must be disabled in Phase 1.1A');

  // Case B: Valid checked out
  context.renderAppointmentDrawer({
    id: '66666666-6666-4666-8666-666666666662',
    status: 'completed',
    items: [{ item_id: 'item-1', sequence_no: 1, service_name_snapshot: 'Massage' }],
    checkout: {
      exists: true,
      payment_state: 'paid',
      reconciliation_valid: true,
      actual_total_minor: 10000,
      discount_total_minor: 1000,
      final_due_minor: 9000,
      recorded_paid_minor: 9000,
      outstanding_minor: 0
    },
    billing_summary: {
      appointment_service_item_count: 1,
      billed_service_item_count: 1,
      unbilled_service_item_count: 0
    }
  });

  const bodyB = elements.get('drawerBody');
  assert.ok(bodyB.textContent.includes('$100.00')); // Subtotal
  assert.ok(bodyB.textContent.includes('$10.00'));  // Discount
  assert.ok(bodyB.textContent.includes('$90.00'));   // Final due

  // Case C: Reconciled invalid -> shows checkoutStateInconsistent
  context.renderAppointmentDrawer({
    id: '66666666-6666-4666-8666-666666666663',
    status: 'completed',
    items: [{ item_id: 'item-1', sequence_no: 1, service_name_snapshot: 'Massage' }],
    checkout: {
      exists: true,
      reconciliation_valid: false,
      payment_state: 'inconsistent'
    }
  });

  const bodyC = elements.get('drawerBody');
  assert.ok(bodyC.textContent.includes(i18n.t('checkoutStateInconsistent', 'zh-CN')));

  // Case D: Legacy fallback (billing coverage unavailable)
  context.renderAppointmentDrawer({
    id: '66666666-6666-4666-8666-666666666664',
    status: 'completed',
    items: [],
    checkout: null,
    billing_summary: {
      appointment_service_item_count: null,
      billed_service_item_count: null,
      unbilled_service_item_count: null
    }
  });

  const bodyD = elements.get('drawerBody');
  assert.ok(bodyD.textContent.includes('计费覆盖状态不可用'));
});

test('8. DOB Privacy & DTO Security: customer booking query, booking creation response, and notification serialization never leak date_of_birth', async () => {
  // --------------------------------------------------------------------------
  // Part A: /api/customer/my-bookings via lib/customer-booking-query.js
  // --------------------------------------------------------------------------
  // 1. Source analysis: verify SQL in customer-booking-query does NOT select date_of_birth
  assert.doesNotMatch(customerBookingQuerySource, /\bdate_of_birth\b/i, 'customer-booking-query.js SQL must not reference date_of_birth');
  assert.doesNotMatch(customerBookingQuerySource, /\bbirthday\b/i, 'customer-booking-query.js SQL must not reference birthday');

  // 2. Execution test: presentCustomerBookings / queryCustomerBookings must strip or omit date_of_birth even if database returns it
  const mockPoolCustomer = {
    async query() {
      return {
        rows: [
          {
            id: '77777777-7777-4777-8777-777777777771',
            appointment_no: 'APP-CUSTOMER-001',
            start_at: '2026-10-15T02:00:00.000Z',
            end_at: '2026-10-15T03:00:00.000Z',
            status: 'confirmed',
            created_at: '2026-10-01T00:00:00.000Z',
            items: [{ sequenceNo: 1, name: 'Facial', durationMinutes: 60, staffName: 'Emily' }],
            // Injected database field that must never leak
            date_of_birth: '1995-08-25',
            customer_date_of_birth: '1995-08-25'
          }
        ]
      };
    }
  };

  const customerBookings = await customerBookingQuery.queryCustomerBookings(mockPoolCustomer, {
    shopId: '88888888-8888-4888-8888-888888888888',
    phoneNormalized: '+6591234567',
    rawPhone: '91234567'
  });

  assert.equal(customerBookings.length, 1);
  const presentedAppt = customerBookings[0];
  assert.strictEqual(presentedAppt.appointmentNo, 'APP-CUSTOMER-001');
  assert.strictEqual(presentedAppt.status, 'confirmed');
  assert.strictEqual(presentedAppt.date_of_birth, undefined, 'Customer booking DTO must not expose date_of_birth');
  assert.strictEqual(presentedAppt.customer_date_of_birth, undefined, 'Customer booking DTO must not expose customer_date_of_birth');
  assert.strictEqual('date_of_birth' in presentedAppt, false);

  // --------------------------------------------------------------------------
  // Part B: Customer booking response in server.js (/api/new-db)
  // --------------------------------------------------------------------------
  // Verify multi-service customer response payload
  const multiServiceMatch = serverJs.match(/app\.post\(\s*['"]\/api\/new-db['"][\s\S]*?createMultiServiceBooking[\s\S]*?res\.json\(\{\s*success:\s*true,\s*message:\s*['"]预约成功['"],\s*data:\s*\{([\s\S]*?)\}\s*\}\);/);
  assert.ok(multiServiceMatch, 'Must find multi-service response in /api/new-db');
  const multiServiceDataBlock = multiServiceMatch[1];
  assert.doesNotMatch(multiServiceDataBlock, /date_of_birth/i, 'Multi-service response data must not include date_of_birth');

  // Verify single-service customer response payload
  const singleServiceMatch = serverJs.match(/createSingleServiceCompatibilityRows[\s\S]*?res\.json\(\{\s*success:\s*true,\s*message:\s*['"]预约成功['"],\s*data:\s*\{([\s\S]*?)\}\s*\}\);/);
  assert.ok(singleServiceMatch, 'Must find single-service response in /api/new-db');
  const singleServiceDataBlock = singleServiceMatch[1];
  assert.doesNotMatch(singleServiceDataBlock, /date_of_birth/i, 'Single-service response data must not include date_of_birth');

  // Verify customer my-bookings endpoint in server.js does not leak date_of_birth
  const myBookingsRouteMatch = serverJs.match(/app\.get\(\s*['"]\/api\/customer\/my-bookings['"][\s\S]*?res\.json\(\{([\s\S]*?)\}\);/);
  if (myBookingsRouteMatch) {
    assert.doesNotMatch(myBookingsRouteMatch[1], /date_of_birth/i, 'my-bookings route must not add date_of_birth');
  }

  // --------------------------------------------------------------------------
  // Part C: Notification serialization in lib/booking-notifications.js
  // --------------------------------------------------------------------------
  // 1. Source analysis: verify query in booking-notifications does NOT select date_of_birth
  assert.doesNotMatch(bookingNotificationsSource, /\bdate_of_birth\b/i, 'booking-notifications.js must not query date_of_birth');

  // 2. Execution test: listNotifications must not leak date_of_birth in notification or embedded appointment
  const mockPoolNotification = {
    async query(sql) {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: 0 }] };
      }
      return {
        rows: [
          {
            id: '99999999-9999-4999-8999-999999999991',
            appointment_id: '77777777-7777-4777-8777-777777777771',
            event_type: 'booking_created',
            is_read: false,
            read_at: null,
            created_at: '2026-10-01T00:00:00.000Z',
            appointment_no: 'APP-NOTIF-001',
            start_at: '2026-10-15T02:00:00.000Z',
            end_at: '2026-10-15T03:00:00.000Z',
            appointment_status: 'confirmed',
            customer_name: 'Sarah Tan',
            service_name: 'Pedicure',
            staff_name: 'Jessica',
            // Injected field that must never leak
            date_of_birth: '1988-12-05'
          }
        ]
      };
    }
  };

  const { notifications } = await bookingNotifications.listNotifications(mockPoolNotification, {
    shopId: '88888888-8888-4888-8888-888888888888',
    recipientType: 'shop'
  });

  assert.equal(notifications.length, 1);
  const notifItem = notifications[0];
  assert.strictEqual(notifItem.date_of_birth, undefined, 'Notification object must not contain date_of_birth');
  assert.strictEqual(notifItem.appointment.date_of_birth, undefined, 'Notification appointment object must not contain date_of_birth');
  assert.strictEqual('date_of_birth' in notifItem, false);
  assert.strictEqual('date_of_birth' in notifItem.appointment, false);

  // --------------------------------------------------------------------------
  // Part D: Owner appointments endpoint sets no-store cache header
  // --------------------------------------------------------------------------
  const appointmentsDbRoute = serverJs.slice(
    serverJs.indexOf("'/api/appointments-db'"),
    serverJs.indexOf("app.post(\n  '/api/admin/update-status-db'")
  );
  assert.match(appointmentsDbRoute, /res\.setHeader\('Cache-Control',\s*'no-store,\s*private,\s*max-age=0'\)/);
  assert.match(appointmentsDbRoute, /TO_CHAR\(c\.date_of_birth,\s*'YYYY-MM-DD'\)\s+AS\s+date_of_birth/);
});
