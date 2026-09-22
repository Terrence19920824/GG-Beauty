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
const ownerAuthPath = path.join(root, 'lib', 'owner-auth.js');
const frontDeskMigrationPath = path.join(root, 'migrations', '053_owner_front_desk_role.sql');

const i18n = require(sharedI18nPath);
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const serverJs = fs.readFileSync(serverJsPath, 'utf8');
const ownerAuthSource = fs.readFileSync(ownerAuthPath, 'utf8');
const frontDeskMigration = fs.readFileSync(frontDeskMigrationPath, 'utf8');

const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'admin.html inline script must exist');

// 1. Internationalization dictionary completeness and purity
test('1. i18n: all appointment detail and status keys are defined in zh-CN and en', () => {
  const requiredKeys = [
    'appointmentDetails',
    'booker',
    'recipient',
    'bookerSameAsRecipient',
    'notes',
    'noNotes',
    'callCustomer',
    'openWhatsApp',
    'servicesAndStaff',
    'statusUpdatedSuccess',
    'statusUpdateFailed',
    'close',
    'emailNotProvided',
    'noCustomerPhone',
    'markArrived',
    'markInService',
    'markNoShow',
    'markCancelled'
  ];

  for (const key of requiredKeys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');

    assert.ok(zh, `Missing zh-CN translation for: ${key}`);
    assert.ok(en, `Missing en translation for: ${key}`);
    assert.notStrictEqual(zh, key, `zh-CN translation for ${key} must not be identical to key`);
    assert.notStrictEqual(en, key, `en translation for ${key} must not be identical to key`);

    // Pure language checks: zh-CN should not contain English words; en should not contain Chinese characters
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `zh-CN translation for ${key} should not contain English words: "${zh}"`);
    assert.doesNotMatch(en, /[\u4e00-\u9fa5]/, `en translation for ${key} should not contain Chinese characters: "${en}"`);
  }
});

// 2. CSS touch targets and drawer styling
test('2. CSS: drawer, backdrop, and action buttons have proper styles and >= 44px touch targets', () => {
  assert.match(calendarSharedCss, /\.appointment-drawer\s*\{/, 'Must define .appointment-drawer class');
  assert.match(calendarSharedCss, /\.drawer-backdrop\s*\{/, 'Must define .drawer-backdrop class');
  assert.match(calendarSharedCss, /\.admin-toast\s*\{/, 'Must define .admin-toast class');

  // Verify >= 44px touch target rules for drawer interactive buttons
  assert.match(calendarSharedCss, /\.drawer-close-btn[\s\S]*?min-width:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.drawer-close-btn[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.drawer-action-link[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);
  assert.match(calendarSharedCss, /\.drawer-status-btn[\s\S]*?min-height:\s*(?:var\(--calendar-touch-min,\s*44px\)|44px)/);

  // Verify focus-visible styling for accessibility
  assert.match(calendarSharedCss, /\.drawer-close-btn:focus-visible/);
  assert.match(calendarSharedCss, /\.drawer-action-link:focus-visible/);
  assert.match(calendarSharedCss, /\.drawer-status-btn:focus-visible/);

  // Verify prefers-reduced-motion support
  assert.match(calendarSharedCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.appointment-drawer/);
});

// 3. HTML Markup structure
test('3. HTML: admin.html includes drawer backdrop, aside dialog, and toast container', () => {
  assert.match(adminHtml, /<div\s+id="appointmentDrawerBackdrop"\s+class="drawer-backdrop"/);
  assert.match(adminHtml, /<aside\s+id="appointmentDrawer"\s+class="appointment-drawer"\s+role="dialog"\s+aria-modal="true"\s+aria-labelledby="drawerTitle"/);
  assert.match(adminHtml, /<div\s+id="adminToast"\s+class="admin-toast"\s+role="status"\s+aria-live="polite"/);
  assert.match(adminHtml, /id="drawerCloseBtn"/);
  assert.match(adminHtml, /class="drawer-close-btn"/);
  assert.match(adminHtml, /<div\s+[^>]*id="drawerBody"/);
  assert.match(adminHtml, /id="drawerFooter"/);
});

// Helper to create test context with DOM mocks
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
        return null;
      },
      querySelectorAll(selector) {
        return [];
      }
    };
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
      if (url.includes('/api/appointments-db')) {
        return {
          status: 200,
          ok: true,
          async json() {
            return { success: true, data: options.initialAppointments || [] };
          }
        };
      }
      return {
        status: 200,
        ok: true,
        async json() {
          return { success: true, data: [] };
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
      querySelector(sel) {
        return null;
      },
      querySelectorAll(sel) {
        return [];
      },
      addEventListener(name, handler) {}
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

// 4. URI Formatter tests (tel: and wa.me)
test('4. URI formatters: formatTelUri and formatWhatsAppUri handle Singapore numbers correctly', () => {
  const { context } = createMockAdminContext();

  assert.strictEqual(context.formatTelUri('9123 4567'), 'tel:91234567');
  assert.strictEqual(context.formatTelUri('+65 9123 4567'), 'tel:+6591234567');
  assert.strictEqual(context.formatTelUri(''), '');
  assert.strictEqual(context.formatTelUri(null), '');

  // Singapore 8-digit mobile (starting with 8 or 9) gets 65 prefix
  assert.strictEqual(context.formatWhatsAppUri('91234567'), 'https://wa.me/6591234567');
  assert.strictEqual(context.formatWhatsAppUri('8123 4567'), 'https://wa.me/6581234567');
  // Already has 65 prefix
  assert.strictEqual(context.formatWhatsAppUri('+65 9123 4567'), 'https://wa.me/6591234567');
  assert.strictEqual(context.formatWhatsAppUri(''), '');
});

// 5. Drawer rendering content tests
test('5. Drawer rendering: displays customer, unmasked phone, email (when present), booker vs recipient, services, staff, date/time, and notes', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const appt = {
    id: '00000000-0000-4000-8000-000000000001',
    customer_name: 'Jane Doe',
    customer_phone: '+65 9876 5432',
    customer_email: 'jane@example.com',
    booker_name_snapshot: 'John Doe',
    booker_phone_snapshot: '+65 8765 4321',
    recipient_name_snapshot: 'Jane Doe',
    recipient_phone_snapshot: '+65 9876 5432',
    start_at: '2026-09-23T02:00:00.000Z', // 10:00 SGT
    end_at: '2026-09-23T03:30:00.000Z',   // 11:30 SGT
    status: 'confirmed',
    notes: 'Allergic to lavender',
    items: [
      {
        service_name_snapshot: 'Luxury Facial',
        staff_name_snapshot: 'Alice Chen',
        duration_minutes: 60
      },
      {
        service_name_snapshot: 'Head Massage',
        staff_name_snapshot: 'Bob Tan',
        duration_minutes: 30
      }
    ]
  };

  context.renderAppointmentDrawer(appt);

  const drawerBody = elements.get('drawerBody');
  const drawerFooter = elements.get('drawerFooter');
  const drawerText = drawerBody.textContent;

  // Customer Name & unmasked phone
  assert.match(drawerText, /Jane Doe/, 'Customer name must be displayed');
  assert.match(drawerText, /\+65 9876 5432/, 'Unmasked phone must be displayed');
  assert.match(drawerText, /jane@example\.com/, 'Email must be displayed when present');

  // Distinct Booker vs Recipient
  assert.match(drawerText, /John Doe/, 'Distinct booker name must be displayed');
  assert.match(drawerText, /\+65 8765 4321/, 'Distinct booker phone must be displayed');

  // Contact actions: tel: and wa.me
  assert.strictEqual(findDescendant(drawerBody, el => el.href === 'tel:+6598765432')?.href, 'tel:+6598765432', 'Tel link must use unmasked phone');
  assert.strictEqual(findDescendant(drawerBody, el => el.href === 'https://wa.me/6598765432')?.href, 'https://wa.me/6598765432', 'WhatsApp link must use unmasked phone with 65');

  // Services and Staff
  assert.match(drawerText, /Luxury Facial/, 'Service 1 name must be rendered');
  assert.match(drawerText, /Alice Chen/, 'Staff 1 name must be rendered');
  assert.match(drawerText, /60 分钟/, 'Service 1 duration must be rendered');
  assert.match(drawerText, /Head Massage/, 'Service 2 name must be rendered');
  assert.match(drawerText, /Bob Tan/, 'Staff 2 name must be rendered');
  assert.match(drawerText, /30 分钟/, 'Service 2 duration must be rendered');

  // Notes
  assert.match(drawerText, /Allergic to lavender/, 'Customer notes must be displayed');

  // Status badge
  assert.ok(findDescendant(drawerBody, el => String(el.className).includes('status-confirmed')), 'Status confirmed badge must be displayed');

  // Footer status action buttons for confirmed: arrived, no_show, cancelled
  assert.match(drawerFooter.textContent, /已到店/, 'Arrived button must exist');
  assert.match(drawerFooter.textContent, /未到店/, 'No-show button must exist');
  assert.match(drawerFooter.textContent, /取消预约/, 'Cancel button must exist');
});

// 6. Booker and Recipient same person
test('6. Drawer rendering: when booker and recipient are same, displays bookerSameAsRecipient notice', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const appt = {
    id: '00000000-0000-4000-8000-000000000002',
    customer_name: 'Alice Smith',
    customer_phone: '91234567',
    customer_email: '', // empty email
    booker_name_snapshot: 'Alice Smith',
    booker_phone_snapshot: '91234567',
    recipient_name_snapshot: 'Alice Smith',
    recipient_phone_snapshot: '91234567',
    start_at: '2026-09-23T04:00:00.000Z',
    end_at: '2026-09-23T05:00:00.000Z',
    status: 'arrived',
    notes: '' // empty notes
  };

  context.renderAppointmentDrawer(appt);

  const drawerBody = elements.get('drawerBody').textContent;

  // Same person notice
  assert.match(drawerBody, /预约人同实际顾客/, 'Must show same person message');
  // Email field should NOT be rendered when empty
  assert.doesNotMatch(drawerBody, /Email/, 'Email row should be omitted when empty');
  // Empty notes should show '无'
  assert.match(drawerBody, /无/, 'Empty notes should show "无" in zh-CN');
});

// 7. XSS sanitization in drawer
test('7. Security: drawer escapes HTML payloads in all fields', () => {
  const { context, elements } = createMockAdminContext();

  const xssPayload = '"><svg onload=alert(1)>';
  const appt = {
    id: '00000000-0000-4000-8000-000000000003',
    customer_name: xssPayload,
    customer_phone: '91234567',
    customer_email: `test@test.com${xssPayload}`,
    booker_name_snapshot: xssPayload,
    recipient_name_snapshot: xssPayload,
    notes: xssPayload,
    items: [
      {
        service_name_snapshot: xssPayload,
        staff_name_snapshot: xssPayload,
        duration_minutes: 30
      }
    ],
    status: 'pending'
  };

  context.renderAppointmentDrawer(appt);

  const drawerBody = elements.get('drawerBody');
  assert.match(drawerBody.textContent, /"><svg onload=alert\(1\)>/, 'Payload must remain text, not markup');
  assert.strictEqual(findDescendant(drawerBody, el => el.tagName === 'SVG'), null, 'Must not create an SVG element from customer data');
});

// 8. Open and Close drawer lifecycle
test('8. Drawer lifecycle: openAppointmentDrawer opens drawer, closeAppointmentDrawer hides it', async () => {
  const appt = {
    id: '00000000-0000-4000-8000-000000000004',
    customer_name: 'Test Customer',
    customer_phone: '91234567',
    status: 'pending'
  };

  const { context, elements } = createMockAdminContext({ initialAppointments: [appt] });
  await context.loadAppointments();

  const drawer = elements.get('appointmentDrawer');
  const backdrop = elements.get('appointmentDrawerBackdrop');

  assert.strictEqual(drawer.classList.contains('open'), false);

  // Open drawer
  context.openAppointmentDrawer(appt.id);

  assert.strictEqual(drawer.classList.contains('open'), true, 'Drawer should have open class');
  assert.strictEqual(backdrop.classList.contains('visible'), true, 'Backdrop should have visible class');
  assert.strictEqual(context.getActiveDrawerAppointmentId(), appt.id, 'Active drawer ID should be set');

  // Close drawer
  context.closeAppointmentDrawer();

  assert.strictEqual(drawer.classList.contains('open'), false, 'Drawer should remove open class');
  assert.strictEqual(backdrop.classList.contains('visible'), false, 'Backdrop should remove visible class');
  assert.strictEqual(context.getActiveDrawerAppointmentId(), null, 'Active drawer ID should be cleared');
});

// 9. In-place status update for arrived, in_service, no_show, cancelled
test('9. In-place partial status update: updates in-memory snapshot and drawer without calling loadAppointments', async () => {
  const appt = {
    id: '00000000-0000-4000-8000-000000000005',
    customer_name: 'Partial Update Test',
    customer_phone: '91234567',
    status: 'confirmed'
  };

  const { context, elements, requests } = createMockAdminContext({
    initialAppointments: [appt],
    fetchHandler: async (url, opts) => {
      if (url === '/api/admin/update-status-db') {
        const body = JSON.parse(opts.body);
        return {
          status: 200,
          ok: true,
          async json() {
            return {
              success: true,
              data: {
                id: body.appointmentId,
                status: body.status,
                updated_at: new Date().toISOString()
              }
            };
          }
        };
      }
      return null;
    }
  });

  await context.loadAppointments();

  let loadAppointmentsCalled = false;
  const originalLoadAppointments = context.loadAppointments;
  context.loadAppointments = async (...args) => {
    loadAppointmentsCalled = true;
    return originalLoadAppointments.apply(context, args);
  };

  // Open drawer for this appointment
  context.openAppointmentDrawer(appt.id);
  assert.strictEqual(context.getActiveDrawerAppointmentId(), appt.id);

  // Partial update 1: mark arrived
  await context.updateAppointmentStatus(appt.id, 'arrived');

  assert.strictEqual(loadAppointmentsCalled, false, 'loadAppointments must NOT be called for arrived');
  assert.ok(findDescendant(elements.get('drawerBody'), el => String(el.className).includes('status-arrived')), 'Drawer body should reflect arrived status');

  // Verify toast notification
  const toast = elements.get('adminToast');
  assert.strictEqual(toast.hidden, false, 'Toast must be visible');
  assert.strictEqual(toast.textContent, i18n.t('statusUpdatedSuccess', 'zh-CN'));

  // Partial update 2: mark in_service
  await context.updateAppointmentStatus(appt.id, 'in_service');
  assert.strictEqual(loadAppointmentsCalled, false, 'loadAppointments must NOT be called for in_service');
  assert.ok(findDescendant(elements.get('drawerBody'), el => String(el.className).includes('status-in_service')));

  // Partial update 3: mark cancelled
  await context.updateAppointmentStatus(appt.id, 'cancelled');
  assert.strictEqual(loadAppointmentsCalled, false, 'loadAppointments must NOT be called for cancelled');
  assert.ok(findDescendant(elements.get('drawerBody'), el => String(el.className).includes('status-cancelled')));
});

// 10. Language purity across locales
test('10. Localization purity: drawer in zh-CN is pure Chinese, drawer in en is pure English', () => {
  const sample = {
    id: '00000000-0000-4000-8000-000000000006',
    customer_name: 'Customer Purity',
    customer_phone: '91234567',
    status: 'pending'
  };

  // Test zh-CN
  {
    const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });
    context.renderAppointmentDrawer(sample);
    const bodyZh = elements.get('drawerBody').textContent;
    const titleZh = elements.get('drawerTitle').textContent;

    assert.strictEqual(titleZh, '预约详情');
    assert.match(bodyZh, /顾客姓名/);
    assert.match(bodyZh, /电话/);
    assert.match(bodyZh, /拨打电话/);
    assert.match(bodyZh, /打开聊天/);
  }

  // Test en
  {
    const { context, elements } = createMockAdminContext({ locale: 'en' });
    context.renderAppointmentDrawer(sample);
    const bodyEn = elements.get('drawerBody').textContent;
    const titleEn = elements.get('drawerTitle').textContent;

    assert.strictEqual(titleEn, 'Appointment Details');
    assert.match(bodyEn, /Customer/);
    assert.match(bodyEn, /Phone/);
    assert.match(bodyEn, /Call/);
    assert.match(bodyEn, /WhatsApp/);
    assert.doesNotMatch(bodyEn, /[\u4e00-\u9fa5]/, 'English drawer must contain no Chinese');
  }
});

// 11. Backend authority: /api/appointments-db provides full phone, /api/staff/appointments masks phone
test('11. Security & Authority: server.js provides full phone on owner route and masks on staff route', () => {
  // Check /api/appointments-db query includes customer_phone without masking
  assert.match(serverJs, /\/api\/appointments-db/);
  assert.match(serverJs, /customer_phone/);

  // Check /api/staff/appointments implements phone masking
  assert.match(serverJs, /\/api\/staff\/appointments/);
  assert.match(serverJs, /maskPhone|•••••/);
});

test('12. Front desk access is authenticated, tenant-scoped, and backed by a schema migration', () => {
  assert.match(ownerAuthSource, /'front_desk'/, 'Authenticated owner sessions must allow a front-desk membership');
  for (const route of ['/api/owner/calendar-context', '/api/appointments-db', '/api/admin/update-status-db']) {
    const segment = serverJs.slice(serverJs.indexOf(route), serverJs.indexOf(route) + 500);
    assert.match(segment, /requireOwnerAuth/, `${route} must require authenticated owner access`);
    assert.match(segment, /front_desk/, `${route} must explicitly permit front desk`);
  }
  assert.match(frontDeskMigration, /BEGIN;[\s\S]*DROP CONSTRAINT owner_shop_memberships_role_check[\s\S]*front_desk[\s\S]*COMMIT;/);
});

test('13. Failed status mutation leaves the current card and drawer state unchanged', async () => {
  const appt = {
    id: '00000000-0000-4000-8000-000000000007',
    customer_name: 'Keep State',
    customer_phone: '91234567',
    status: 'confirmed'
  };
  const { context, elements } = createMockAdminContext({
    initialAppointments: [appt],
    fetchHandler: async url => url === '/api/admin/update-status-db' ? {
      status: 409,
      ok: false,
      async json() { return { success: false, message: 'Status change is no longer valid.' }; }
    } : null
  });
  await context.loadAppointments();
  context.openAppointmentDrawer(appt.id);
  await context.updateAppointmentStatus(appt.id, 'arrived');

  assert.ok(findDescendant(elements.get('drawerBody'), el => String(el.className).includes('status-confirmed')));
  assert.strictEqual(findDescendant(elements.get('drawerBody'), el => String(el.className).includes('status-arrived')), null);
  assert.strictEqual(context.getActiveDrawerAppointmentId(), appt.id);
  assert.ok(elements.get('appointmentDrawer').classList.contains('open'));
  assert.match(elements.get('adminToast').textContent, /Status change is no longer valid/);
});
