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
const serverJsPath = path.join(root, 'server.js');

const i18n = require(sharedI18nPath);
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const serverJs = fs.readFileSync(serverJsPath, 'utf8');

const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'admin.html inline script must exist');

function makeMockElement(id = '', tag = 'DIV') {
  const listeners = new Map();
  const classList = new Set();
  const attrs = new Map();
  return {
    id,
    tagName: tag.toUpperCase(),
    children: [],
    _textContent: '',
    get textContent() {
      return this.children.length
        ? this.children.map(c => c.textContent).join('')
        : this._textContent;
    },
    set textContent(value) {
      this.children = [];
      this._textContent = String(value == null ? '' : value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
      this._textContent = '';
    },
    hidden: false,
    disabled: false,
    maxLength: 0,
    value: '',
    style: {},
    get className() {
      return Array.from(classList).join(' ');
    },
    set className(val) {
      classList.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
    },
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
    focus() {}
  };
}

function createMockAdminContext(options = {}) {
  const elements = new Map();
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
    'adminToast'
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
      _state: { locale: options.locale || 'zh-CN', role: options.role || 'owner' },
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
          return { success: true, data: options.initialAppointments || [] };
        }
      };
    },
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      },
      createElement(tag) {
        return makeMockElement('', tag);
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    }
  };

  vm.runInNewContext(scriptMatch[1], context, {
    filename: 'public/admin.html'
  });

  return { context, elements, alerts, requests };
}

function findDescendant(element, predicate) {
  if (!element) return null;
  if (predicate(element)) return element;
  for (const child of element.children || []) {
    const match = findDescendant(child, predicate);
    if (match) return match;
  }
  return null;
}

function findAllDescendants(element, predicate) {
  const matches = [];
  if (!element) return matches;
  if (predicate(element)) matches.push(element);
  for (const child of element.children || []) {
    matches.push(...findAllDescendants(child, predicate));
  }
  return matches;
}

// =========================================================================
// A. Owner Projection Fields in Database Read Query
// =========================================================================
test('A. Server projections: /api/appointments-db projects customer_id, party snapshots, member_code, and identity_status', () => {
  assert.match(serverJs, /a\.customer_id\s*,/, 'Must project a.customer_id');
  assert.match(serverJs, /a\.booker_customer_id\s*,/, 'Must project a.booker_customer_id');
  assert.match(serverJs, /a\.recipient_customer_id\s*,/, 'Must project a.recipient_customer_id');
  assert.match(serverJs, /a\.booker_name_snapshot\s*,/, 'Must project a.booker_name_snapshot');
  assert.match(serverJs, /a\.booker_phone_snapshot\s*,/, 'Must project a.booker_phone_snapshot');
  assert.match(serverJs, /a\.booker_email_snapshot\s*,/, 'Must project a.booker_email_snapshot');
  assert.match(serverJs, /a\.recipient_name_snapshot\s*,/, 'Must project a.recipient_name_snapshot');
  assert.match(serverJs, /a\.recipient_phone_snapshot\s*,/, 'Must project a.recipient_phone_snapshot');
  assert.match(serverJs, /a\.recipient_email_snapshot\s*,/, 'Must project a.recipient_email_snapshot');
  assert.match(serverJs, /c\.member_code\s*,/, 'Must project c.member_code');
  assert.match(serverJs, /c\.identity_status\s*,/, 'Must project c.identity_status');
});

// =========================================================================
// B. Tenant Isolation in SQL
// =========================================================================
test('B. Tenant isolation: customer and party joins in appointments query enforce shop_id boundary', () => {
  assert.match(serverJs, /JOIN customers c\s+ON c\.id = a\.customer_id\s+AND c\.shop_id = a\.shop_id/,
    'Customer join must strictly enforce tenant boundary c.shop_id = a.shop_id');
  assert.match(serverJs, /JOIN services s\s+ON s\.id = a\.service_id\s+AND s\.shop_id = a\.shop_id/,
    'Services join must strictly enforce tenant boundary s.shop_id = a.shop_id');
  assert.match(serverJs, /JOIN staff st\s+ON st\.id = a\.staff_id\s+AND st\.shop_id = a\.shop_id/,
    'Staff join must strictly enforce tenant boundary st.shop_id = a.shop_id');
});

// =========================================================================
// C. Phone Privacy: Owner receives unmasked phone, Staff remains masked, Public/Customer does not leak
// =========================================================================
test('C. Phone privacy: Staff route projection remains strictly masked', () => {
  // Staff route /api/staff/appointments must NOT project unmasked phone or raw snapshots
  assert.match(serverJs, /app\.get\(\s*['"]\/api\/staff\/appointments['"]/);
  assert.match(serverJs, /'•••••'\s*\|\|\s*RIGHT/, 'Staff route must use masked customer phone projection');
  assert.match(serverJs, /FROM locations l\s+WHERE l\.id = \$3::UUID\s+AND l\.shop_id = \$1::UUID/);
});

// =========================================================================
// D. Member UI: Verified badge & Member Code
// =========================================================================
test('D1. Member UI: Verified badge renders on card and in drawer only when identity_status === verified_member', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const verifiedAppt = {
    id: '00000000-0000-4000-8000-000000000001',
    recipient_name_snapshot: 'Alice Member',
    customer_phone: '+65 9123 4567',
    identity_status: 'verified_member',
    member_code: 'MEM-8888',
    status: 'pending'
  };

  context.renderAppointmentDrawer(verifiedAppt);
  const drawerBody = elements.get('drawerBody');
  const badgeEl = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-member-badge'));
  assert.ok(badgeEl, 'Verified member badge must be rendered in drawer');
  assert.equal(badgeEl.textContent, '会员', 'Badge text in zh-CN must be 会员');

  const memberCodeEl = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-member-code'));
  assert.ok(memberCodeEl, 'Member code must be rendered in drawer');
  assert.match(memberCodeEl.textContent, /MEM-8888/, 'Accurate member code must be displayed');
});

test('D2. Member UI: Non-verified or missing identity_status does not render verified badge or fabricate code', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const nonMemberAppt = {
    id: '00000000-0000-4000-8000-000000000002',
    recipient_name_snapshot: 'Bob Guest',
    customer_phone: '+65 9123 0000',
    identity_status: 'unverified',
    member_code: null,
    status: 'pending'
  };

  context.renderAppointmentDrawer(nonMemberAppt);
  const drawerBody = elements.get('drawerBody');
  const badgeEl = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-member-badge'));
  assert.equal(badgeEl, null, 'Unverified customer must not show verified badge');

  const codeEl = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-member-code'));
  assert.equal(codeEl, null, 'NULL member_code must not render member code element');
  assert.doesNotMatch(drawerBody.textContent, /null|undefined/, 'Drawer must not display literal null or undefined');
});

// =========================================================================
// E. Services & Pricing Display
// =========================================================================
test('E1. Services display: Multi-service renders all items with formatted price minor units in drawer', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const multiServiceAppt = {
    id: '00000000-0000-4000-8000-000000000003',
    recipient_name_snapshot: 'Grace Ho',
    customer_phone: '+65 9111 2222',
    status: 'confirmed',
    items: [
      {
        item_id: 'item-1',
        service_name_snapshot: 'Deep Facial Cleaning',
        duration_minutes_snapshot: 60,
        price_snapshot_minor: 6800,
        staff_assignments: [{ role: 'primary', staff_name: 'Elena' }]
      },
      {
        item_id: 'item-2',
        service_name_snapshot: 'Eye Spa Treatment',
        duration_minutes_snapshot: 30,
        price_snapshot_minor: 3800,
        staff_assignments: [{ role: 'assistant', staff_name: 'Maya' }]
      }
    ]
  };

  context.renderAppointmentDrawer(multiServiceAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /Deep Facial Cleaning/, 'First service name must render');
  assert.match(text, /60 分钟/, 'First service duration must render');
  assert.match(text, /\$68\.00/, 'First service price must format from minor units without float inaccuracies');
  assert.match(text, /Elena/, 'Primary staff name must render');

  assert.match(text, /Eye Spa Treatment/, 'Second service name must render');
  assert.match(text, /30 分钟/, 'Second service duration must render');
  assert.match(text, /\$38\.00/, 'Second service price must format from minor units');
  assert.match(text, /Maya/, 'Assistant staff name must render');
});

test('E2. Services display: Historical appointment fallback to service_name when items array is empty', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const historicalAppt = {
    id: '00000000-0000-4000-8000-000000000004',
    customer_name: 'Old Customer',
    service_name: 'Classic Manicure',
    duration_minutes: 45,
    price: '48.00',
    staff_name: 'Sarah',
    items: [],
    status: 'completed'
  };

  context.renderAppointmentDrawer(historicalAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /Classic Manicure/, 'Legacy service name must render as fallback');
  assert.match(text, /45 分钟/, 'Legacy duration must render');
  assert.match(text, /\$48\.00/, 'Legacy price must format correctly');
  assert.match(text, /Sarah/, 'Legacy staff name must render');
});

// =========================================================================
// F. Booker vs Recipient Logic
// =========================================================================
test('F1. Booker vs Recipient: Same person renders same-person indicator without duplicate booker section', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const samePersonAppt = {
    id: '00000000-0000-4000-8000-000000000005',
    customer_id: 'cust-1',
    booker_customer_id: 'cust-1',
    recipient_customer_id: 'cust-1',
    recipient_name_snapshot: 'Same BookerRecipient',
    customer_phone: '+65 9222 3333',
    status: 'pending'
  };

  context.renderAppointmentDrawer(samePersonAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /Same BookerRecipient/, 'Recipient name must be displayed');
  assert.match(text, /预约人同实际顾客/, 'Must show same-person indicator');
  const bookerBox = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-booker-subsection'));
  assert.equal(bookerBox, null, 'Duplicate booker subsection must not be rendered when parties are identical');
});

test('F2. Booker vs Recipient: Distinct parties render Booker subsection and contact links target recipient', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const distinctPartyAppt = {
    id: '00000000-0000-4000-8000-000000000006',
    customer_id: 'cust-recipient',
    booker_customer_id: 'cust-booker',
    recipient_customer_id: 'cust-recipient',
    booker_name_snapshot: 'Mother Booker',
    booker_phone_snapshot: '+65 8111 2222',
    booker_email_snapshot: 'mother@example.com',
    recipient_name_snapshot: 'Daughter Recipient',
    recipient_phone_snapshot: '+65 9333 4444',
    recipient_email_snapshot: 'daughter@example.com',
    status: 'confirmed'
  };

  context.renderAppointmentDrawer(distinctPartyAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /实际顾客/, 'Recipient section must be labeled 实际顾客');
  assert.match(text, /Daughter Recipient/, 'Recipient name must appear');
  assert.match(text, /\+65 9333 4444/, 'Recipient phone must appear');

  const bookerBox = findDescendant(drawerBody, el => el.classList && el.classList.has('drawer-booker-subsection'));
  assert.ok(bookerBox, 'Separate booker subsection must exist');
  assert.match(bookerBox.textContent, /Mother Booker/, 'Booker name must appear in subsection');
  assert.match(bookerBox.textContent, /\+65 8111 2222/, 'Booker phone must appear in subsection');
  assert.match(bookerBox.textContent, /mother@example\.com/, 'Booker email must appear in subsection');

  // Contact links must target the Recipient
  const telLink = findDescendant(drawerBody, el => el.tagName === 'A' && el.classList && el.classList.has('drawer-call-btn'));
  assert.ok(telLink, 'Call button link must exist');
  assert.equal(telLink.href, 'tel:+6593334444', 'Call button must target recipient phone, NOT booker phone');

  const waLink = findDescendant(drawerBody, el => el.tagName === 'A' && el.classList && el.classList.has('drawer-whatsapp-btn'));
  assert.ok(waLink, 'WhatsApp link must exist');
  assert.equal(waLink.href, 'https://wa.me/6593334444', 'WhatsApp link must target recipient phone, NOT booker phone');
});

// =========================================================================
// G. Staff Assignments
// =========================================================================
test('G. Staff assignments: Primary and Assistant roles are distinctly displayed in drawer', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const staffAppt = {
    id: '00000000-0000-4000-8000-000000000007',
    recipient_name_snapshot: 'Test Customer',
    customer_phone: '+65 9000 1111',
    status: 'in_service',
    items: [
      {
        service_name_snapshot: 'Hydra Facial',
        duration_minutes_snapshot: 75,
        price_snapshot_minor: 12000,
        staff_assignments: [
          { role: 'primary', staff_name: 'Lead Specialist Amy' },
          { role: 'assistant', staff_name: 'Assistant Ben' }
        ]
      }
    ]
  };

  context.renderAppointmentDrawer(staffAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /主理:/, 'Primary staff label must appear');
  assert.match(text, /Lead Specialist Amy/, 'Primary staff name must appear');
  assert.match(text, /助理:/, 'Assistant staff label must appear');
  assert.match(text, /Assistant Ben/, 'Assistant staff name must appear');
});

// =========================================================================
// H. I18N Completeness and Bilingual Purity
// =========================================================================
test('H. I18N completeness: All newly added keys exist with pure bilingual fidelity', () => {
  const newKeys = [
    'member',
    'memberCode',
    'appointmentInfo',
    'customer',
    'serviceItems',
    'primaryStaffTitle',
    'assistantStaffTitle',
    'paidAmount',
    'finalDue',
    'outstandingAmount'
  ];

  for (const k of newKeys) {
    const zh = i18n.t(k, 'zh-CN');
    const en = i18n.t(k, 'en');

    assert.ok(zh, `Missing zh-CN translation for ${k}`);
    assert.ok(en, `Missing en translation for ${k}`);
    assert.notEqual(zh, k, `zh-CN translation for ${k} cannot be key itself`);
    assert.notEqual(en, k, `en translation for ${k} cannot be key itself`);

    // zh-CN pure Chinese
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `zh-CN "${zh}" contains English text`);
    // en pure English (no Han ideographs)
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en "${en}" contains Chinese characters`);
  }
});

// =========================================================================
// I. Internal Notes Permissions
// =========================================================================
test('I. Internal Notes: Owner/manager can edit, admin/front_desk disabled, 4000 character limit enforced', () => {
  // Owner role
  const { context: ownerCtx, elements: ownerElements } = createMockAdminContext();
  ownerCtx.setAdminProfile({ membership: { role: 'owner' } });
  const appt = {
    id: '00000000-0000-4000-8000-000000000008',
    customer_name: 'VIP Client',
    customer_phone: '+65 9000 2222',
    internal_notes: 'Prefers quiet environment',
    status: 'pending'
  };

  ownerCtx.renderAppointmentDrawer(appt);
  const ownerBody = ownerElements.get('drawerBody');
  const ownerInput = findDescendant(ownerBody, el => el.id === 'drawerInternalNotesInput');
  assert.ok(ownerInput, 'Internal notes input must exist');
  assert.equal(ownerInput.disabled, false, 'Owner must have editable internal notes');
  assert.equal(ownerInput.maxLength, 4000, 'Must enforce 4000 char maxLength');
  assert.equal(ownerInput.value, 'Prefers quiet environment', 'Must populate existing internal notes');

  // Front desk role
  const { context: fdCtx, elements: fdElements } = createMockAdminContext();
  fdCtx.setAdminProfile({ membership: { role: 'front_desk' } });
  fdCtx.renderAppointmentDrawer(appt);
  const fdBody = fdElements.get('drawerBody');
  const fdInput = findDescendant(fdBody, el => el.id === 'drawerInternalNotesInput');
  assert.ok(fdInput, 'Internal notes input must exist for front desk');
  assert.equal(fdInput.disabled, true, 'Front desk must NOT be allowed to edit internal notes');
});

// =========================================================================
// J. Completed != Paid & Financial Projection Display
// =========================================================================
test('J1. Completed != Paid: Completed appointment without checkout is never labeled Paid', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const completedNoCheckoutAppt = {
    id: '00000000-0000-4000-8000-000000000009',
    customer_name: 'Customer Completed',
    customer_phone: '+65 9111 0000',
    status: 'completed',
    checkout: null
  };

  context.renderAppointmentDrawer(completedNoCheckoutAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /已完成/, 'Completed appointment must render as 已完成');
  assert.doesNotMatch(text, /已结账/, 'Completed appointment without checkout must NEVER render as 已结账');
});

test('J2. Financial projection: Read-only checkout details rendered when checkout projection exists', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const checkoutAppt = {
    id: '00000000-0000-4000-8000-000000000010',
    customer_name: 'Customer With Checkout',
    customer_phone: '+65 9111 5555',
    status: 'completed',
    checkout: {
      exists: true,
      checkout_id: 'chk-1',
      checkout_status: 'paid',
      payment_state: 'paid',
      final_due_minor: 12000,
      recorded_paid_minor: 12000,
      outstanding_minor: 0,
      reconciliation_valid: true
    }
  };

  context.renderAppointmentDrawer(checkoutAppt);
  const drawerBody = elements.get('drawerBody');
  const text = drawerBody.textContent;

  assert.match(text, /收银/, 'Checkout section must render');
  assert.match(text, /\$120\.00/, 'Final due amount must render correctly');
  assert.match(text, /已结账/, 'Paid checkout status must render');
});

// =========================================================================
// K. Responsive Short Cards & CSS Rules
// =========================================================================
test('K. CSS: Responsive short card rules hide phone and actions when card is compact', () => {
  assert.match(calendarSharedCss, /\.owner-calendar-appointment\.is-short\s*\.calendar-card-phone[\s\S]*?display:\s*none/);
  assert.match(calendarSharedCss, /\.owner-calendar-appointment\.is-short\s*\.calendar-card-assistant/);
  assert.match(calendarSharedCss, /\.owner-calendar-appointment\.is-short\s*\.calendar-card-actions/);
  assert.match(calendarSharedCss, /\.owner-calendar-appointment\.is-ultra-short\s*\.calendar-card-member-badge[\s\S]*?display:\s*none/);
});
