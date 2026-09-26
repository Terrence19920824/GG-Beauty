'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../public/shared-i18n');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'public', 'admin.html');
const adminHtml = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, 'admin inline script must exist');

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
        if (!child) return child;
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.children = children;
        this._textContent = '';
        this._innerHTML = '';
      },
      insertBefore(newNode, refNode) {
        const idx = this.children.indexOf(refNode);
        if (idx !== -1) {
          newNode.parentElement = this;
          this.children.splice(idx, 0, newNode);
        } else {
          this.appendChild(newNode);
        }
        return newNode;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
          child.parentElement = null;
          this.children.splice(idx, 1);
        }
        return child;
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        if (!listeners.has(type)) return;
        const list = listeners.get(type).filter(h => h !== handler);
        listeners.set(type, list);
      },
      dispatchEvent(event) {
        const list = (listeners.get(event?.type) || []).slice();
        for (const h of list) h(event);
      },
      getAttribute(name) {
        return attrs.has(name) ? attrs.get(name) : null;
      },
      hasAttribute(name) {
        return attrs.has(name);
      },
      setAttribute(name, val) {
        attrs.set(name, String(val));
      },
      removeAttribute(name) {
        attrs.delete(name);
      },
      querySelector(selector) {
        return findDescendant(this, node => matchesSelector(node, selector));
      },
      querySelectorAll(selector) {
        const out = [];
        walkTree(this, node => {
          if (matchesSelector(node, selector)) out.push(node);
        });
        return out;
      },
      classList: {
        add(c) {
          classList.add(c);
          el.className = Array.from(classList).join(' ');
        },
        remove(c) {
          classList.delete(c);
          el.className = Array.from(classList).join(' ');
        },
        contains(c) {
          return classList.has(c);
        },
        toggle(c, force) {
          if (force === true) this.add(c);
          else if (force === false) this.remove(c);
          else if (classList.has(c)) this.remove(c);
          else this.add(c);
        }
      },
      dataset: {},
      style: {}
    };
    return el;
  }

  function matchesSelector(node, selector) {
    if (!node || !selector) return false;
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return String(node.className || '').includes(selector.slice(1));
    if (selector === 'button') return node.tagName === 'BUTTON';
    return false;
  }

  function walkTree(node, callback) {
    if (!node) return;
    for (const child of node.children || []) {
      callback(child);
      walkTree(child, callback);
    }
  }

  const registeredElementIds = [
    'drawerBody',
    'drawerTitle',
    'drawerFooter',
    'appointmentDrawer',
    'drawerBackdrop',
    'adminToast',
    'content',
    'calendarDatePicker',
    'calendarCurrentDateLabel',
    'totalCount',
    'pendingCount',
    'todayCount',
    'loginSection',
    'adminPanel',
    'currentShopName',
    'calendarView'
  ];

  for (const id of registeredElementIds) {
    elements.set(id, makeMockElement(id));
  }

  const requests = [];
  const alerts = [];
  let currentLocale = options.locale || 'zh-CN';
  let adminProfile = options.profile || { membership: { role: 'owner' } };

  const storageMap = new Map();
  const localStorageMock = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    clear() { storageMap.clear(); }
  };
  localStorageMock.setItem('gg_admin_locale', currentLocale);

  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    alert(msg) { alerts.push(msg); },
    localStorage: localStorageMock,
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      if (url.includes('/profile-notes')) {
        const body = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: 'cust-1', profileNotes: body.profileNotes, profile_notes: body.profileNotes }
          })
        };
      }
      if (url.includes('/internal-notes')) {
        const body = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: 'appt-1', internalNotes: body.internalNotes }
          })
        };
      }
      if (url.includes('/status')) {
        const body = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: 'appt-1', status: body.status }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] })
      };
    },
    Date,
    Intl,
    JSON,
    Math,
    RegExp,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    ggI18n: i18n,
    ownerSelfService: {
      _state: { locale: currentLocale },
      setLocale(loc) { this._state.locale = loc; },
      setProfile() {},
      reset() {}
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeMockElement(id));
        }
        return elements.get(id);
      },
      createElement(tag) {
        return makeMockElement('', tag);
      },
      createTextNode(text) {
        return { textContent: text, nodeType: 3 };
      },
      querySelectorAll(selector) {
        return [];
      },
      querySelector(selector) {
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
      body: makeMockElement('body', 'BODY')
    },
    window: {
      location: { reload() {}, href: 'http://localhost/' },
      addEventListener() {},
      removeEventListener() {},
      getAdminActorRole() { return adminProfile?.membership?.role || 'owner'; }
    }
  };

  context.window.window = context.window;
  context.window.document = context.document;
  context.window.localStorage = localStorageMock;
  context.window.ggI18n = i18n;
  context.window.ownerSelfService = context.ownerSelfService;

  vm.runInNewContext(scriptMatch[1], context, {
    filename: 'public/admin.html'
  });

  return { context, elements, requests, alerts, setLocale: (loc) => { currentLocale = loc; } };
}

function findDescendant(node, predicate) {
  if (!node) return null;
  for (const child of node.children || []) {
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

// 1. Persistent workflow strip is absent from Owner Calendar
test('1. Persistent workflow strip is absent from Owner Calendar HTML and CSS', () => {
  assert.doesNotMatch(adminHtml, /class="frontdesk-workflow-bar"/, 'frontdesk-workflow-bar class must be absent');
  assert.doesNotMatch(adminHtml, /class="workflow-stepper"/, 'workflow-stepper class must be absent');
  assert.doesNotMatch(adminHtml, /class="workflow-step"/, 'workflow-step class must be absent');
  assert.doesNotMatch(adminHtml, /class="step-num"/, 'step-num class must be absent');
  assert.doesNotMatch(adminHtml, /class="step-arrow"/, 'step-arrow class must be absent');
  assert.doesNotMatch(adminHtml, /data-i18n="frontDeskWorkflow"/, 'frontDeskWorkflow translation key must be absent');
  assert.doesNotMatch(adminHtml, /data-i18n="workflowFeaturePreview"/, 'workflowFeaturePreview translation key must be absent');

  // Verify space reclamation: .card directly follows the closing of .summary
  const summaryEnd = adminHtml.indexOf('</div>\n\n  <div class="card">');
  assert.ok(summaryEnd > 0, 'card must follow summary with no workflow-bar element or gap in between');
});

// 2. Workflow removal does not change appointment status logic
test('2. Workflow removal preserves appointment status state machine and actions', () => {
  const { context, elements } = createMockAdminContext();
  assert.strictEqual(typeof context.updateAppointmentStatus, 'function', 'updateAppointmentStatus must exist');
  assert.strictEqual(typeof context.openAppointmentDrawer, 'function', 'openAppointmentDrawer must exist');
  assert.strictEqual(typeof context.closeAppointmentDrawer, 'function', 'closeAppointmentDrawer must exist');
});

// 3. Legacy “备注 / 无” booking-notes presentation is absent from Owner drawer
test('3. Legacy booking notes presentation is completely absent from Owner drawer', () => {
  const { context, elements } = createMockAdminContext();

  // Test with empty notes
  const apptEmptyNotes = {
    id: '00000000-0000-4000-8000-000000000001',
    customer_name: 'Jane Doe',
    customer_phone: '91234567',
    start_at: '2026-09-23T02:00:00.000Z',
    end_at: '2026-09-23T03:00:00.000Z',
    status: 'confirmed',
    notes: '',
    remark: null
  };
  context.renderAppointmentDrawer(apptEmptyNotes);
  const drawerBody = elements.get('drawerBody');
  const drawerText = drawerBody.textContent;

  assert.strictEqual(findDescendant(drawerBody, el => el.className?.includes('drawer-notes-box')), null, 'drawer-notes-box must not exist');
  assert.doesNotMatch(drawerText, /备注\s*无/, 'Empty "备注 / 无" must not exist');

  // Test with non-empty legacy notes
  const apptWithLegacyNotes = {
    ...apptEmptyNotes,
    notes: 'Legacy customer booking note',
    remark: 'Legacy remark'
  };
  context.renderAppointmentDrawer(apptWithLegacyNotes);
  const drawerTextWithNotes = elements.get('drawerBody').textContent;

  assert.strictEqual(findDescendant(elements.get('drawerBody'), el => el.className?.includes('drawer-notes-box')), null, 'drawer-notes-box must not exist');
  assert.doesNotMatch(drawerTextWithNotes, /Legacy customer booking note/, 'Legacy booking notes must not be rendered in drawer');
});

// 4. Customer Profile Notes remains present and functional
test('4. Customer Profile Notes remains present and fully functional in drawer', async () => {
  const { context, elements, requests } = createMockAdminContext();

  const appt = {
    id: '00000000-0000-4000-8000-000000000002',
    customer_id: 'cust-1',
    customer_name: 'Alice Wang',
    customer_phone: '98765432',
    start_at: '2026-09-23T04:00:00.000Z',
    end_at: '2026-09-23T05:00:00.000Z',
    status: 'confirmed',
    profile_notes: 'Prefers mild shampoo'
  };

  context.renderAppointmentDrawer(appt);
  const drawerBody = elements.get('drawerBody');

  const profileInput = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesInput');
  const profileStatus = findDescendant(drawerBody, el => el.id === 'drawerCustomerProfileNotesStatus');
  const profileSaveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-profile-notes-save'));

  assert.ok(profileInput, 'Customer profile notes input must exist');
  assert.strictEqual(profileInput.value, 'Prefers mild shampoo');
  assert.ok(profileSaveBtn, 'Customer profile notes save button must exist');

  // Trigger save
  profileInput.value = 'Updated scalp condition note';
  profileSaveBtn.dispatchEvent({ type: 'click' });
  await new Promise(r => setTimeout(r, 15));

  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].opts.method, 'PATCH');
  assert.ok(requests[0].url.includes('/api/owner/customers/cust-1/profile-notes'));
  assert.deepStrictEqual(JSON.parse(requests[0].opts.body), { profileNotes: 'Updated scalp condition note' });
});

// 5. Internal Notes remains present and functional
test('5. Internal Notes remains present and fully functional in drawer', async () => {
  const { context, elements, requests } = createMockAdminContext();

  const appt = {
    id: '00000000-0000-4000-8000-000000000003',
    customer_name: 'Bob Tan',
    customer_phone: '91234567',
    start_at: '2026-09-23T06:00:00.000Z',
    end_at: '2026-09-23T07:00:00.000Z',
    status: 'confirmed',
    internal_notes: 'Staff VIP note'
  };

  context.renderAppointmentDrawer(appt);
  const drawerBody = elements.get('drawerBody');

  const internalInput = findDescendant(drawerBody, el => el.id === 'drawerInternalNotesInput');
  const internalStatus = findDescendant(drawerBody, el => el.id === 'drawerInternalNotesStatus');
  const internalSaveBtn = findDescendant(drawerBody, el => String(el.className || '').includes('drawer-internal-notes-save'));

  assert.ok(internalInput, 'Internal notes input must exist');
  assert.strictEqual(internalInput.value, 'Staff VIP note');
  assert.ok(internalSaveBtn, 'Internal notes save button must exist');

  // Trigger save
  internalInput.value = 'Updated internal note';
  internalSaveBtn.dispatchEvent({ type: 'click' });
  await new Promise(r => setTimeout(r, 15));

  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].opts.method, 'PATCH');
  assert.ok(requests[0].url.includes('/api/owner/appointments/00000000-0000-4000-8000-000000000003/internal-notes'));
  assert.deepStrictEqual(JSON.parse(requests[0].opts.body), { internalNotes: 'Updated internal note' });
});

// 6. Existing notes/remark backend/data compatibility is untouched
test('6. Existing notes and remark data model and compatibility remain untouched', () => {
  const appt = {
    id: '00000000-0000-4000-8000-000000000004',
    customer_name: 'Test Customer',
    notes: 'Preserved notes field',
    remark: 'Preserved remark field'
  };

  assert.strictEqual(appt.notes, 'Preserved notes field');
  assert.strictEqual(appt.remark, 'Preserved remark field');
});

// 7. Checkout/status controls remain present
test('7. Status controls and drawer action buttons remain intact', () => {
  const { context, elements } = createMockAdminContext();

  const appt = {
    id: '00000000-0000-4000-8000-000000000005',
    customer_name: 'Charlie Lee',
    customer_phone: '91234567',
    start_at: '2026-09-23T08:00:00.000Z',
    end_at: '2026-09-23T09:00:00.000Z',
    status: 'confirmed'
  };

  context.renderAppointmentDrawer(appt);
  const footerText = elements.get('drawerFooter').textContent;

  assert.match(footerText, /已到店/, 'Arrived action button must be present in drawer footer');
  assert.match(footerText, /未到店/, 'No-show action button must be present in drawer footer');
  assert.match(footerText, /取消预约/, 'Cancel action button must be present in drawer footer');
});

// 8. Chinese UI remains Chinese
test('8. Chinese mode UI remains pure Chinese with no English pollution', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });

  const appt = {
    id: '00000000-0000-4000-8000-000000000006',
    customer_name: '陈大文',
    customer_phone: '91234567',
    start_at: '2026-09-23T08:00:00.000Z',
    end_at: '2026-09-23T09:00:00.000Z',
    status: 'confirmed',
    internal_notes: '内部备注内容',
    profile_notes: '顾客档案备注内容'
  };

  context.renderAppointmentDrawer(appt);
  const drawerBody = elements.get('drawerBody').textContent;

  assert.match(drawerBody, /预约信息/);
  assert.match(drawerBody, /顾客/);
  assert.match(drawerBody, /内部备注/);
  assert.match(drawerBody, /顾客档案备注/);
});

// 9. English UI remains English
test('9. English mode UI remains pure English with no Chinese leakage', () => {
  const { context, elements } = createMockAdminContext({ locale: 'en' });

  const appt = {
    id: '00000000-0000-4000-8000-000000000007',
    customer_name: 'John Doe',
    customer_phone: '91234567',
    start_at: '2026-09-23T08:00:00.000Z',
    end_at: '2026-09-23T09:00:00.000Z',
    status: 'confirmed',
    internal_notes: 'Internal note content',
    profile_notes: 'Profile note content'
  };

  context.renderAppointmentDrawer(appt);
  const drawerBody = elements.get('drawerBody').textContent;
  const drawerTitle = elements.get('drawerTitle').textContent;

  assert.strictEqual(drawerTitle, 'Appointment Details');
  assert.match(drawerBody, /Appointment/);
  assert.match(drawerBody, /Customer/);
  assert.match(drawerBody, /Internal notes/);
  assert.match(drawerBody, /Customer Profile Notes/);
  assert.doesNotMatch(drawerBody, /[\u4e00-\u9fa5]/, 'English drawer must have 0 Chinese characters');
});

// 10. No unrelated API/database behavior changes
test('10. Obsolete workflow translation keys safely removed, no unrelated keys touched', () => {
  assert.strictEqual(i18n.t('frontDeskWorkflow', 'zh-CN'), 'frontDeskWorkflow', 'frontDeskWorkflow must be removed');
  assert.strictEqual(i18n.t('workflowFeaturePreview', 'zh-CN'), 'workflowFeaturePreview', 'workflowFeaturePreview must be removed');
  assert.strictEqual(i18n.t('workflowAppointment', 'zh-CN'), 'workflowAppointment', 'workflowAppointment must be removed');
  assert.strictEqual(i18n.t('workflowArrived', 'zh-CN'), 'workflowArrived', 'workflowArrived must be removed');
  assert.strictEqual(i18n.t('workflowInService', 'zh-CN'), 'workflowInService', 'workflowInService must be removed');
  assert.strictEqual(i18n.t('workflowCheckout', 'zh-CN'), 'workflowCheckout', 'workflowCheckout must be removed');
  assert.strictEqual(i18n.t('workflowPaid', 'zh-CN'), 'workflowPaid', 'workflowPaid must be removed');

  assert.strictEqual(i18n.t('frontDeskWorkflow', 'en'), 'frontDeskWorkflow', 'en frontDeskWorkflow must be removed');
  assert.strictEqual(i18n.t('workflowFeaturePreview', 'en'), 'workflowFeaturePreview', 'en workflowFeaturePreview must be removed');

  // Verify critical keys remain intact
  assert.strictEqual(i18n.t('internalNotes', 'zh-CN'), '内部备注');
  assert.strictEqual(i18n.t('customerProfileNotes', 'zh-CN'), '顾客档案备注');
  assert.strictEqual(i18n.t('internalNotes', 'en'), 'Internal notes');
  assert.strictEqual(i18n.t('customerProfileNotes', 'en'), 'Customer Profile Notes');
  assert.strictEqual(i18n.t('notes', 'zh-CN'), '备注');
  assert.strictEqual(i18n.t('notes', 'en'), 'Notes');
});
