'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const i18n = require('../public/shared-i18n');
const { createCheckoutPos, ABSTRACT_PAYMENT_METHODS, DB_PAYMENT_METHOD_MAP } = require('../lib/checkout-pos');
const { projectOwnerAppointmentCheckout } = require('../lib/owner-appointment-checkout-projection');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

function makeMockElement(className = '', tagName = 'div') {
  const listeners = new Map();
  const classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
  const attributes = new Map();

  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    id: '',
    type: 'button',
    disabled: false,
    value: '',
    _textContent: '',
    get className() { return Array.from(classes).join(' '); },
    set className(val) {
      classes.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach(cls => classes.add(cls));
    },
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join('');
    },
    set textContent(value) {
      this._textContent = String(value ?? '');
      this.children = [];
    },
    get innerHTML() { return this.textContent; },
    set innerHTML(value) { this.textContent = value; },
    classList: {
      contains: cls => classes.has(cls),
      add: (...clss) => clss.forEach(cls => classes.add(cls)),
      remove: (...clss) => clss.forEach(cls => classes.delete(cls)),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (classes.has(cls)) { classes.delete(cls); return false; }
          classes.add(cls); return true;
        }
        if (force) { classes.add(cls); return true; }
        classes.delete(cls); return false;
      }
    },
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : (name === 'class' ? Array.from(classes).join(' ') : null)),
    setAttribute: (name, value) => {
      attributes.set(name, String(value));
      if (name === 'class') {
        classes.clear();
        String(value).split(/\s+/).filter(Boolean).forEach(cls => classes.add(cls));
      }
    },
    removeAttribute: name => {
      attributes.delete(name);
      if (name === 'class') classes.clear();
    },
    appendChild(child) {
      if (!child) return child;
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    append(...nodes) {
      nodes.forEach(node => this.appendChild(typeof node === 'string' ? { textContent: node, children: [] } : node));
    },
    prepend(...nodes) {
      nodes.reverse().forEach(node => {
        const item = typeof node === 'string' ? { textContent: node, children: [] } : node;
        this.children.unshift(item);
        item.parentElement = this;
      });
    },
    replaceChildren(...nodes) {
      this.children = [];
      this._textContent = '';
      this.append(...nodes);
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
      }
    },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async dispatchEvent(eventLike) {
      const type = typeof eventLike === 'string' ? eventLike : eventLike?.type;
      const list = listeners.get(type) || [];
      const eventObj = typeof eventLike === 'string' ? { type, preventDefault() {}, stopPropagation() {} } : eventLike;
      for (const handler of list) {
        await handler(eventObj);
      }
    },
    click() {
      return this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    },
    showModal() { this.open = true; },
    close() { this.open = false; }
  };

  return element;
}

function createMockAdminContext({ locale = 'en', role = 'owner', fetchHandler } = {}) {
  const elements = new Map();
  const requests = [];
  const documentBody = makeMockElement('', 'body');

  for (const id of [
    'appointmentDrawer', 'drawerBackdrop', 'drawerTitle', 'drawerStatusBadge',
    'drawerBody', 'drawerFooter', 'adminToastContainer', 'mainScheduleBody',
    'locationFilter'
  ]) {
    const el = makeMockElement('', id === 'drawerFooter' ? 'footer' : 'div');
    el.id = id;
    elements.set(id, el);
    documentBody.appendChild(el);
  }

  const context = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Boolean,
    Array,
    Object,
    String,
    Set,
    Map,
    Promise,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Intl,
    crypto,
    currentAdminRole: role,
    currentAdminShopId: '11111111-1111-4111-8111-111111111111',
    currentAdminMembershipId: '22222222-2222-4222-8222-222222222222',
    currentAdminLocale: locale,
    ggI18n: i18n,
    FEATURE_CHECKOUT_ENABLED: true,
    ownerSelfService: { _state: { locale } },
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      if (typeof fetchHandler === 'function') {
        const customResponse = await fetchHandler(url, opts);
        if (customResponse) return customResponse;
      }
      return {
        status: 200,
        ok: true,
        async json() { return { success: true, data: [] }; }
      };
    },
    document: {
      body: documentBody,
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

  return { context, elements, requests, documentBody };
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

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  appt: '22222222-2222-4222-8222-222222222222',
  cust: '33333333-3333-4333-8333-333333333333',
  item1: '44444444-4444-4444-8444-444444444441',
  item2: '44444444-4444-4444-8444-444444444442',
  owner: '55555555-5555-4555-8555-555555555555',
  checkout: '66666666-6666-4666-8666-666666666666'
};

function createPosFixture(status = 'in_service') {
  const calls = [];
  const client = {
    async query(q, p = []) {
      calls.push({ q, p });
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || /^SET LOCAL/.test(q)) return { rows: [] };
      if (/FROM checkout_transactions/.test(q)) return { rows: [] };
      if (/FROM appointments a/.test(q)) return { rows: [{ id: ID.appt, shop_id: ID.shop, status, customer_id: ID.cust }] };
      if (/FROM appointment_items i/.test(q)) {
        return {
          rows: [
            { id: ID.item1, sequence_no: 1, service_id: 's1', service_name_snapshot: 'Service 1', quote_minor: '6000' },
            { id: ID.item2, sequence_no: 2, service_id: 's2', service_name_snapshot: 'Service 2', quote_minor: '4000' }
          ]
        };
      }
      if (/^INSERT INTO checkout_transactions/.test(q)) {
        return { rows: [{ id: ID.checkout, status: 'paid', final_due_minor: 10000, paid_minor: 10000 }] };
      }
      if (/^INSERT INTO checkout_(line_items|payments|financial_audit)/.test(q)) return { rows: [] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {}
  };
  return { calls, pool: { connect: async () => client } };
}

// -------------------------------------------------------------
// Test Suite: APPOINTMENT DETAIL POS WORKSPACE PHASE 1.3A
// -------------------------------------------------------------

test('1. i18n purity: Phase 1.3A keys exist and follow single-language purity', () => {
  const phase13Keys = [
    'manualCheckout', 'paymentMethod', 'paymentCash', 'paymentQr',
    'paymentPayNowSgqr', 'paymentDuitNowQr', 'paymentPromptPay', 'paymentQris',
    'paymentCard', 'paymentEwallet', 'paymentGcashMaya', 'paymentTouchNGo',
    'paymentBankTransfer', 'paymentOther', 'fullPayment',
    'manualPaymentDisclaimer', 'manualPaymentRecordNotice',
    'checkoutSuccess', 'checkoutFailed', 'orderPaid',
    'submittingCheckout', 'confirmCheckout'
  ];

  const brandKeys = new Set([
    'paymentPayNowSgqr', 'paymentDuitNowQr', 'paymentPromptPay', 'paymentQris',
    'paymentGcashMaya', 'paymentTouchNGo'
  ]);

  for (const key of phase13Keys) {
    const zhVal = i18n.t(key, 'zh-CN');
    const enVal = i18n.t(key, 'en');

    assert.ok(zhVal && zhVal !== key, `zh-CN key ${key} must exist`);
    assert.ok(enVal && enVal !== key, `en key ${key} must exist`);

    if (!brandKeys.has(key)) {
      // zh-CN contains Chinese characters for descriptive labels
      assert.match(zhVal, /[\u4e00-\u9fa5]/, `zh-CN [${key}] must contain Chinese: ${zhVal}`);
    }
    // en must not contain Chinese characters
    assert.doesNotMatch(enVal, /[\u4e00-\u9fa5]/, `en [${key}] must be pure English: ${enVal}`);
  }
});

test('2. Feature gate off keeps Pay Bill disabled with unavailable notice', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });
  context.FEATURE_CHECKOUT_ENABLED = false;

  context.renderAppointmentDrawer({
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: true, // Projection says ok, but feature gate is false
    items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 6000 }],
    checkout: null
  });

  const drawerBody = elements.get('drawerBody');
  const payBtn = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-btn'));
  assert.ok(payBtn, 'Pay Bill button must exist');
  assert.equal(payBtn.disabled, true, 'Pay Bill button must be disabled when feature gate is off');
  assert.equal(payBtn.getAttribute('aria-disabled'), 'true');

  const note = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-note'));
  assert.ok(note, 'Pay Bill unavailable note must exist');
  assert.equal(note.textContent, i18n.t('payBillUnavailable', 'zh-CN'));
});

test('3. Feature gate on + owner/manager + allowed status + no checkout enables Pay Bill button', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN', role: 'owner' });
  context.FEATURE_CHECKOUT_ENABLED = true;

  context.renderAppointmentDrawer({
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: true,
    items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 6000 }],
    checkout: null
  });

  const drawerBody = elements.get('drawerBody');
  const payBtn = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-btn'));
  assert.ok(payBtn, 'Pay Bill button must exist');
  assert.equal(payBtn.disabled, false, 'Pay Bill button must be enabled');
  assert.equal(payBtn.getAttribute('aria-disabled'), null);

  const note = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-note'));
  assert.equal(note, null, 'No unavailable note when Pay Bill is active');
});

test('4. Disallowed statuses (pending, confirmed, cancelled, no_show) keep Pay Bill disabled', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });
  context.FEATURE_CHECKOUT_ENABLED = true;

  for (const status of ['pending', 'confirmed', 'cancelled', 'no_show']) {
    context.renderAppointmentDrawer({
      id: ID.appt,
      status,
      can_start_checkout: false, // Projection forbids these statuses
      items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 6000 }],
      checkout: null
    });

    const drawerBody = elements.get('drawerBody');
    const payBtn = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-btn'));
    assert.equal(payBtn.disabled, true, `Pay Bill must be disabled for ${status}`);
    assert.equal(payBtn.getAttribute('aria-disabled'), 'true');
  }
});

test('5. Existing checkout disables Pay Bill button', () => {
  const { context, elements } = createMockAdminContext({ locale: 'zh-CN' });
  context.FEATURE_CHECKOUT_ENABLED = true;

  context.renderAppointmentDrawer({
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: false, // Projection forbids checkout when checkout already exists
    items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 6000 }],
    checkout: {
      exists: true,
      payment_state: 'paid',
      reconciliation_valid: true,
      final_due_minor: 6000,
      recorded_paid_minor: 6000
    }
  });

  const drawerBody = elements.get('drawerBody');
  const payBtn = findDescendant(drawerBody, el => el.classList?.contains('drawer-pay-bill-btn'));
  assert.equal(payBtn.disabled, true, 'Pay Bill must be disabled when already checked out');
});

test('6. Front desk and admin roles maintain backend checkout restrictions', () => {
  for (const role of ['front_desk', 'admin', 'staff']) {
    const projected = projectOwnerAppointmentCheckout({
      id: ID.appt,
      status: 'in_service',
      items: [{
        item_id: 'i1', sequence_no: 1, service_id: 's1', service_name_snapshot: 'Service',
        duration_minutes_snapshot: 60, price_snapshot_minor: '6000',
        start_at: '2030-01-01T02:00:00Z', end_at: '2030-01-01T03:00:00Z', status: 'in_service',
        staff_assignments: [{ assignment_id: 'a1', staff_id: 'st1', staff_name: 'Staff', role: 'primary', start_at: '2030-01-01T02:00:00Z', end_at: '2030-01-01T03:00:00Z' }]
      }]
    }, { role, checkoutWriteEnabled: true });

    assert.equal(projected.can_start_checkout, false, `Role ${role} must not be permitted to start checkout`);
  }
});

test('7. Zero-migration backend accepts abstract payment methods and maps safely to PostgreSQL check constraints', async () => {
  const expectedMappings = {
    cash: 'cash',
    card: 'card',
    qr_payment: 'paynow_qr',
    paynow_qr: 'paynow_qr',
    ewallet: 'other',
    bank_transfer: 'other',
    other: 'other'
  };

  for (const [method, expectedDbMethod] of Object.entries(expectedMappings)) {
    const f = createPosFixture('in_service');
    const handler = createCheckoutPos({ pool: f.pool }).create;
    const req = {
      params: { appointmentId: ID.appt },
      body: {
        idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
        paymentMethod: method
      },
      ownerAuth: { shopId: ID.shop, ownerAccountId: ID.owner }
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; }
    };

    await handler(req, res);
    assert.equal(res.statusCode, 201, `Payment method ${method} must succeed with 201`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'paid');

    const paymentInsert = f.calls.find(c => /INSERT INTO checkout_payments/.test(c.q));
    assert.ok(paymentInsert, 'Must execute payment insert');
    assert.equal(paymentInsert.p[2], expectedDbMethod, `Method ${method} must map to DB column value ${expectedDbMethod}`);
  }
});

test('8. Server derives authoritative final due from appointment items and enforces full payment', async () => {
  const f = createPosFixture('in_service');
  const handler = createCheckoutPos({ pool: f.pool }).create;
  const req = {
    params: { appointmentId: ID.appt },
    body: {
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      paymentMethod: 'card'
      // Notice: client sends NO prices, discounts, or final totals
    },
    ownerAuth: { shopId: ID.shop, ownerAccountId: ID.owner }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await handler(req, res);
  assert.equal(res.statusCode, 201);

  // Authoritative total: item1 (6000) + item2 (4000) = 10000
  const txInsert = f.calls.find(c => /INSERT INTO checkout_transactions/.test(c.q));
  const finalDueMinorParam = txInsert.p.length === 12 ? txInsert.p[8] : txInsert.p[7];
  const paidMinorParam = txInsert.p.length === 12 ? txInsert.p[9] : txInsert.p[8];
  assert.equal(finalDueMinorParam, 10000, 'final_due_minor must equal sum of items (10000)');
  assert.equal(paidMinorParam, 10000, 'paid_minor must equal final_due_minor (full payment)');
  assert.equal(txInsert.p[3], 'paid', 'Transaction status must be paid');
});

test('9. Clicking Pay Bill opens checkout modal with items, totals, payment methods, and disclaimer', async () => {
  const { context, documentBody } = createMockAdminContext({ locale: 'zh-CN', role: 'owner' });
  context.FEATURE_CHECKOUT_ENABLED = true;

  const appt = {
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: true,
    currency_code: 'SGD',
    customer_name: 'Jennifer Tan',
    items: [
      { item_id: ID.item1, sequence_no: 1, service_name_snapshot: 'Hair Treatment', price_snapshot_minor: 6000, staff_name: 'Staff A' },
      { item_id: ID.item2, sequence_no: 2, service_name_snapshot: 'Styling', price_snapshot_minor: 4000, staff_name: 'Staff B' }
    ],
    checkout: null
  };

  context.openManualCheckoutModal(appt);

  const dialog = findDescendant(documentBody, el => el.id === 'posManualCheckoutModal');
  assert.ok(dialog, 'Checkout modal dialog must exist in document');

  // Verify Header & Customer
  assert.ok(dialog.textContent.includes('手动结账'), 'Modal must have title');
  assert.ok(dialog.textContent.includes('Jennifer Tan'), 'Modal must show customer name');
  assert.ok(dialog.textContent.includes('全额付款'), 'Modal must indicate full payment');

  // Verify Disclaimer
  assert.ok(dialog.textContent.includes('人工记录付款，不代表自动核款'), 'Must contain manual recording disclaimer');

  // Verify Items and Prices
  assert.ok(dialog.textContent.includes('Hair Treatment'), 'Must show item 1');
  assert.ok(dialog.textContent.includes('$60.00'), 'Must format item 1 price');
  assert.ok(dialog.textContent.includes('Styling'), 'Must show item 2');
  assert.ok(dialog.textContent.includes('$40.00'), 'Must format item 2 price');

  // Verify Totals
  assert.ok(dialog.textContent.includes('$100.00'), 'Total due must be $100.00');

  // Verify Country payment labels (SG defaults to PayNow / SGQR)
  assert.ok(dialog.textContent.includes('PayNow / SGQR'), 'SG shop must display PayNow / SGQR for qr_payment');
});

test('10. Double click on confirm button prevents duplicate POST submissions', async () => {
  let postCount = 0;
  let resolvePost;
  const postGate = new Promise(resolve => { resolvePost = resolve; });

  const { context, documentBody } = createMockAdminContext({
    locale: 'en',
    role: 'owner',
    fetchHandler: async (url, opts) => {
      if (opts?.method === 'POST' && url.includes('/checkout')) {
        postCount += 1;
        await postGate;
        return {
          ok: true,
          status: 201,
          json: async () => ({ success: true, data: { id: ID.checkout, status: 'paid' } })
        };
      }
      return null;
    }
  });

  context.loadAppointments = async () => {};
  context.renderAppointmentDrawerById = () => {};

  const appt = {
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: true,
    currency_code: 'SGD',
    customer_name: 'Customer A',
    items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Service', price_snapshot_minor: 5000 }],
    checkout: null
  };

  context.openManualCheckoutModal(appt);
  const dialog = findDescendant(documentBody, el => el.id === 'posManualCheckoutModal');
  const confirmBtn = findDescendant(dialog, el => el.classList?.contains('manual-checkout-confirm-btn'));
  assert.ok(confirmBtn);

  // Trigger double click concurrently
  const firstClick = confirmBtn.click();
  const secondClick = confirmBtn.click();

  assert.equal(postCount, 1, 'Only one POST request must be initiated');
  resolvePost();
  await Promise.all([firstClick, secondClick]);

  assert.equal(postCount, 1, 'Double click must still result in exactly 1 POST');
});

test('11. Network error fails closed without mock success and re-enables submission', async () => {
  let toastMessage = '';
  let toastType = '';

  const { context, documentBody } = createMockAdminContext({
    locale: 'zh-CN',
    role: 'owner',
    fetchHandler: async (url, opts) => {
      if (opts?.method === 'POST') {
        return {
          ok: false,
          status: 503,
          json: async () => ({ success: false, code: 'CHECKOUT_WRITE_DISABLED' })
        };
      }
      return null;
    }
  });

  context.showAdminToast = (msg, type) => {
    toastMessage = msg;
    toastType = type;
  };

  const appt = {
    id: ID.appt,
    status: 'in_service',
    can_start_checkout: true,
    items: [{ item_id: 'i1', sequence_no: 1, service_name_snapshot: 'Service', price_snapshot_minor: 5000 }],
    checkout: null
  };

  context.openManualCheckoutModal(appt);
  const dialog = findDescendant(documentBody, el => el.id === 'posManualCheckoutModal');
  const confirmBtn = findDescendant(dialog, el => el.classList?.contains('manual-checkout-confirm-btn'));

  await confirmBtn.click();

  assert.equal(toastType, 'error');
  assert.equal(confirmBtn.disabled, false, 'Confirm button must be re-enabled after failure for retry');
  assert.equal(dialog.open !== false, true, 'Dialog must remain open on failure (no false success close)');
});
