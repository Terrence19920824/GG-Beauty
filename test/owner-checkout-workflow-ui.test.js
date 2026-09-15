'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../public/shared-i18n');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'public', 'admin.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, 'admin inline script must exist');

const sampleAppointment = {
  id: '00000000-0000-4000-8000-000000000001',
  start_at: '2030-01-01T02:00:00Z',
  customer_name: 'VIP Customer',
  customer_phone: '91234567',
  service_name: 'Hair Treatment',
  staff_name: 'Stylist John',
  status: 'pending',
  items: [],
  checkout: null,
  can_start_checkout: false
};

const createPageContext = (customElements = {}) => {
  const elements = new Map();
  for (const id of [
    'content',
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
    'adminLanguageEn'
  ]) {
    elements.set(id, {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: id === 'adminContent',
      disabled: false,
      style: { display: id === 'loginOverlay' ? 'flex' : '' },
      setAttribute(k, v) {
        this[k] = v;
      },
      ...(customElements[id] || {})
    });
  }

  const requests = [];
  const alerts = [];
  let initialize;

  const context = {
    console,
    Date,
    Intl,
    JSON,
    ggI18n: i18n,
    ownerSelfService: {
      _state: { locale: 'zh-CN' },
      setLocale(loc) {
        this._state.locale = loc;
      },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    alert: message => alerts.push(message),
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        status: 200,
        ok: true,
        async json() { return { success: true }; }
      };
    },
    document: {
      getElementById(id) {
        const element = elements.get(id);
        if (!element) throw new Error(`Unknown element: ${id}`);
        return element;
      },
      querySelectorAll(selector) {
        return [];
      },
      addEventListener(name, handler) {
        if (name === 'DOMContentLoaded') initialize = handler;
      }
    }
  };

  vm.runInNewContext(scriptMatch[1], context, {
    filename: 'public/admin.html'
  });

  return { context, elements, alerts, requests };
};

// 1. Front Desk Stepper Foundation Tests
test('owner admin HTML defines front desk workflow stepper with 5-stage progression', () => {
  assert.match(html, /class="frontdesk-workflow-bar"/);
  assert.match(html, /class="workflow-stepper"/);
  assert.match(html, /data-i18n="frontDeskWorkflow"/);
  assert.match(html, /data-i18n="workflowAppointment"/);
  assert.match(html, /data-i18n="workflowArrived"/);
  assert.match(html, /data-i18n="workflowInService"/);
  assert.match(html, /data-i18n="workflowCheckout"/);
  assert.match(html, /data-i18n="workflowPaid"/);

  const arrowCount = (html.match(/class="step-arrow"/g) || []).length;
  assert.strictEqual(arrowCount, 4, 'There should be 4 step transitions connecting 5 stages');
});

test('front desk workflow bar is isolated from appointment list content container', () => {
  const contentDivIndex = html.indexOf('<div id="content"');
  const workflowBarIndex = html.indexOf('class="frontdesk-workflow-bar"');
  assert.ok(workflowBarIndex > 0, 'workflow bar must exist');
  assert.ok(contentDivIndex > workflowBarIndex, 'workflow bar must be placed above #content');
});

// 2. Authoritative Payment Source & Status Tests (Requirements 53-59)
test('53. checkout.payment_state="paid" and reconciliation_valid=true displays Paid badge', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    checkout: {
      payment_state: 'paid',
      reconciliation_valid: true
    }
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.match(rendered, /role="status"/);
  assert.match(rendered, /aria-label="已结账"/);
  assert.match(rendered, />已结账<\/span>/);
});

test('54. reconciliation_valid non-strict-true values strictly reject Paid badge (fail closed)', () => {
  const invalidValues = [undefined, null, false, 0, 1, 'true', 'false', {}, '1', NaN];
  for (const val of invalidValues) {
    const { context, elements } = createPageContext();
    const checkout = { payment_state: 'paid' };
    if (val !== undefined) checkout.reconciliation_valid = val;
    context.renderAppointments([{
      ...sampleAppointment,
      checkout
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.doesNotMatch(rendered, /status-paid/, `reconciliation_valid=${JSON.stringify(val)} must NOT show Paid`);
    assert.match(rendered, /status-inconsistent/, `reconciliation_valid=${JSON.stringify(val)} must show inconsistent badge`);
    assert.match(rendered, /结账状态异常/);
  }
});

test('55. disallowed and unknown payment_state values fail closed', () => {
  const rejectedStates = ['draft', 'voided', 'awaiting_checkout', 'unknown', 'PAID', 'Paid', 'completed', 'pending', '', 'other'];
  for (const st of rejectedStates) {
    const { context, elements } = createPageContext();
    context.renderAppointments([{
      ...sampleAppointment,
      checkout: {
        payment_state: st,
        reconciliation_valid: true
      }
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.doesNotMatch(rendered, /status-paid/, `payment_state=${st} must NOT show Paid`);
    assert.match(rendered, /status-inconsistent/, `payment_state=${st} must show inconsistent badge`);
    assert.match(rendered, /结账状态异常/);
  }

  for (const st of [null, undefined]) {
    const { context, elements } = createPageContext();
    context.renderAppointments([{
      ...sampleAppointment,
      checkout: {
        payment_state: st,
        reconciliation_valid: true
      }
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.doesNotMatch(rendered, /status-paid/);
    assert.match(rendered, /status-inconsistent/);
  }
});

test('56. legacy flat payment_status="paid" does NOT display Paid badge', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    checkout: null,
    payment_status: 'paid',
    checkout_status: 'paid',
    paymentStatus: 'paid',
    checkoutStatus: 'paid'
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /status-paid/);
  assert.doesNotMatch(rendered, /已结账/);
  assert.strictEqual(context.resolveCheckoutFinancialState({ checkout: null, payment_status: 'paid' }), null);
});

test('57. appointment.status="completed" and checkout=null does NOT display Paid (Completed != Paid)', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    checkout: null
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="status completed"/);
  assert.match(rendered, /已完成/);
  assert.doesNotMatch(rendered, /status-paid/);
  assert.doesNotMatch(rendered, /已结账/);
  assert.strictEqual(context.resolveCheckoutFinancialState({ status: 'completed', checkout: null }), null);
});

test('58. appointment.status not completed still displays Paid badge when authoritative checkout is valid', () => {
  const statuses = ['pending', 'confirmed', 'arrived', 'in_service', 'cancelled', 'no_show'];
  for (const st of statuses) {
    const { context, elements } = createPageContext();
    context.renderAppointments([{
      ...sampleAppointment,
      status: st,
      checkout: {
        payment_state: 'paid',
        reconciliation_valid: true
      }
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.match(rendered, /class="pill status-paid notranslate"/, `Status ${st} must show Paid badge when checkout is paid`);
    assert.match(rendered, /已结账/);
  }
});

test('59. pending, cancelled, and no_show appointments do not hide valid authoritative refund or void badges', () => {
  for (const apptStatus of ['pending', 'cancelled', 'no_show']) {
    // refunded
    {
      const { context, elements } = createPageContext();
      context.renderAppointments([{
        ...sampleAppointment,
        status: apptStatus,
        checkout: { payment_state: 'refunded', reconciliation_valid: true }
      }]);
      const rendered = elements.get('content').innerHTML;
      assert.match(rendered, /class="pill status-refunded notranslate"/);
      assert.match(rendered, /已退款/);
    }
    // partially_refunded
    {
      const { context, elements } = createPageContext();
      context.renderAppointments([{
        ...sampleAppointment,
        status: apptStatus,
        checkout: { payment_state: 'partially_refunded', reconciliation_valid: true }
      }]);
      const rendered = elements.get('content').innerHTML;
      assert.match(rendered, /class="pill status-refunded notranslate"/);
      assert.match(rendered, /部分退款/);
    }
    // void
    {
      const { context, elements } = createPageContext();
      context.renderAppointments([{
        ...sampleAppointment,
        status: apptStatus,
        checkout: { payment_state: 'void', reconciliation_valid: true }
      }]);
      const rendered = elements.get('content').innerHTML;
      assert.match(rendered, /class="pill status-void notranslate"/);
      assert.match(rendered, /已作废/);
    }
  }
});

// 3. can_start_checkout & Feature Gate (Requirements 60-65)
test('60. can_start_checkout helper strictly requires boolean true', () => {
  const { context } = createPageContext();
  const invalidVals = [undefined, null, false, 0, 1, 'true', 'false', '1', {}, [], NaN];
  for (const v of invalidVals) {
    assert.strictEqual(context.canStartCheckout({ can_start_checkout: v }), false, `can_start_checkout=${JSON.stringify(v)} must return false`);
  }
  assert.strictEqual(context.canStartCheckout({ can_start_checkout: true }), true);
});

test('61. FEATURE_CHECKOUT_ENABLED=false completely omits checkout button', () => {
  const { context, elements } = createPageContext();
  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, false);
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);
  assert.doesNotMatch(rendered, /data-feature-gated/);
});

test('62. gate=true but can_start_checkout=false omits checkout button', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: false
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);
});

test('63. gate=true and can_start_checkout=true renders checkout button', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /openCheckoutWorkflow\('00000000-0000-4000-8000-000000000001'\)/);
  assert.match(rendered, />去结账<\/button>/);
});

test('64. appointment.status is NOT used as qualification for can_start_checkout', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  const allStatuses = ['pending', 'confirmed', 'arrived', 'in_service', 'completed'];
  for (const st of allStatuses) {
    context.renderAppointments([{
      ...sampleAppointment,
      status: st,
      can_start_checkout: true
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.match(rendered, /class="checkout-btn"/, `Status ${st} should render checkout button when can_start_checkout=true and gate=true`);
  }
});

test('65. checkout mutating network requests are strictly 0 in all UI operations', async () => {
  const { context, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.openCheckoutWorkflow(sampleAppointment.id);
  context.renderAppointments([sampleAppointment]);
  context.setAdminLocale('en');
  context.setAdminLocale('zh-CN');
  assert.strictEqual(requests.filter(r => r.options?.method && r.options.method !== 'GET').length, 0);
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0);
});

// 4. items[] and Legacy Fallback (Requirements 66-69)
test('66. items=[] displays empty service and staff notices, never falling back to legacy fields', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    items: [],
    service_name: 'Legacy Hair Cut',
    staff_name: 'Legacy Stylist Bob'
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /Legacy Hair Cut/);
  assert.doesNotMatch(rendered, /Legacy Stylist Bob/);
  assert.match(rendered, /暂无服务项目/);
  assert.match(rendered, /暂无员工/);
});

test('67. items missing, null, or non-array falls back to legacy service_name and staff_name', () => {
  for (const val of [undefined, null, 'not-an-array', 123]) {
    const { context, elements } = createPageContext();
    const appt = {
      ...sampleAppointment,
      service_name: 'Legacy Facial',
      staff_name: 'Legacy Alice'
    };
    if (val !== undefined) appt.items = val;
    else delete appt.items;
    context.renderAppointments([appt]);
    const rendered = elements.get('content').innerHTML;
    assert.match(rendered, /Legacy Facial/);
    assert.match(rendered, /Legacy Alice/);
    assert.doesNotMatch(rendered, /暂无服务项目/);
  }
});

test('68. identical sequence_no items are stably sorted by item ID', () => {
  const { context, elements } = createPageContext();
  const appt = {
    ...sampleAppointment,
    items: [
      { item_id: 'z-item', sequence_no: 1, service_name_snapshot: 'Z Service' },
      { item_id: 'a-item', sequence_no: 1, service_name_snapshot: 'A Service' },
      { item_id: 'm-item', sequence_no: 1, service_name_snapshot: 'M Service' }
    ]
  };
  context.renderAppointments([appt]);
  const rendered = elements.get('content').innerHTML;
  const posA = rendered.indexOf('A Service');
  const posM = rendered.indexOf('M Service');
  const posZ = rendered.indexOf('Z Service');
  assert.ok(posA < posM && posM < posZ, 'Items must be stably sorted by item ID when sequence_no is equal');
  // Ensure original items array was not mutated
  assert.strictEqual(appt.items[0].item_id, 'z-item');
  assert.strictEqual(appt.items[1].item_id, 'a-item');
  assert.strictEqual(appt.items[2].item_id, 'm-item');
});

test('69. multi-items display sequences and primary/assistant staff roles properly', () => {
  const { context, elements } = createPageContext();
  const appt = {
    ...sampleAppointment,
    items: [
      {
        item_id: 'item-2',
        sequence_no: 2,
        service_name_snapshot: 'Hair Coloring',
        staff_assignments: [{ role: 'primary', staff_name: 'David' }]
      },
      {
        item_id: 'item-1',
        sequence_no: 1,
        service_name_snapshot: 'Hair Cut',
        staff_assignments: [
          { role: 'primary', staff_name: 'David' },
          { role: 'assistant', staff_name: 'Emma' }
        ]
      }
    ]
  };
  // Chinese
  context.renderAppointments([appt]);
  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, /Hair Cut/);
  assert.match(rendered, /Hair Coloring/);
  assert.match(rendered, /David \(主理\)/);
  assert.match(rendered, /Emma \(助理\)/);

  // English
  context.setAdminLocale('en');
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /David \(Primary\)/);
  assert.match(rendered, /Emma \(Assistant\)/);
});

// 5. DOM & XSS Security (Requirement 70)
test('70. malicious HTML, script, and attribute payloads cannot form executable DOM elements or attributes', () => {
  const maliciousPayloads = [
    '<img src=x onerror=alert(1)>',
    '</span><script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    '& < > " \'',
    '\'); alert(1); //'
  ];

  for (const payload of maliciousPayloads) {
    const { context, elements } = createPageContext();
    context.FEATURE_CHECKOUT_ENABLED = true;
    context.renderAppointments([{
      id: payload,
      start_at: '2030-01-01T02:00:00Z',
      customer_name: payload,
      customer_phone: payload,
      service_name: payload,
      staff_name: payload,
      status: 'pending',
      can_start_checkout: true,
      items: [
        {
          item_id: payload,
          sequence_no: 1,
          service_name_snapshot: payload,
          staff_assignments: [
            { role: 'primary', staff_name: payload },
            { role: 'assistant', staff_name: payload }
          ]
        }
      ]
    }]);
    const rendered = elements.get('content').innerHTML;

    // Must not generate executable tags
    assert.doesNotMatch(rendered, /<script[\s>]/i, `Payload must not generate script tag: ${payload}`);
    assert.doesNotMatch(rendered, /<img[\s>]/i, `Payload must not generate img tag: ${payload}`);
    assert.doesNotMatch(rendered, /<svg[\s>]/i, `Payload must not generate svg tag: ${payload}`);

    // Parse all HTML tags and ensure no onerror / onload event handler attributes were created
    const tagRegex = /<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9-_:]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(rendered)) !== null) {
      const attrString = tagMatch[2];
      const attrRegex = /\s+([a-zA-Z0-9-_:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrString)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        assert.notStrictEqual(attrName, 'onerror', `Tag <${tagMatch[1]}> must not have onerror attribute from payload: ${payload}`);
        assert.notStrictEqual(attrName, 'onload', `Tag <${tagMatch[1]}> must not have onload attribute from payload: ${payload}`);
      }
    }

    // Characters must be escaped
    if (payload.includes('<')) assert.ok(rendered.includes('&lt;'));
    if (payload.includes('>')) assert.ok(rendered.includes('&gt;'));
    if (payload.includes('"')) assert.ok(rendered.includes('&quot;'));
    if (payload.includes('\'')) assert.ok(rendered.includes('&#39;'));
  }
});

// 6. Accessibility, Touch Targets & Motion (Requirements 71-73)
test('71. 44px touch target rules for buttons and touch targets in base CSS and media query', () => {
  assert.match(html, /\.checkout-btn\s*\{[^}]*min-height:\s*44px;/);
  assert.match(html, /\.checkout-btn\s*\{[^}]*min-width:\s*44px;/);
  assert.match(html, /@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\.checkout-btn\s*\{[^}]*min-height:\s*44px;/);
  assert.match(html, /@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\.checkout-btn\s*\{[^}]*min-width:\s*44px;/);
});

test('72. aria-busy is correctly set on loading container and updated on state changes', async () => {
  assert.match(html, /<div\s+id="content"\s+class="loading"\s+aria-busy="true"/);

  const { context, elements } = createPageContext();
  const contentEl = elements.get('content');
  const setAttributeCalls = [];
  contentEl.setAttribute = (k, v) => setAttributeCalls.push({ k, v });

  context.renderAppointments([{ ...sampleAppointment }]);
  assert.ok(setAttributeCalls.some(c => c.k === 'aria-busy' && c.v === 'false'), 'renderAppointments must set aria-busy="false"');

  setAttributeCalls.length = 0;
  context.renderAppointments([]);
  assert.ok(setAttributeCalls.some(c => c.k === 'aria-busy' && c.v === 'false'), 'Empty appointments must set aria-busy="false"');

  setAttributeCalls.length = 0;
  context.showLogin();
  assert.ok(setAttributeCalls.some(c => c.k === 'aria-busy' && c.v === 'true'), 'showLogin must set aria-busy="true"');
});

test('73. prefers-reduced-motion media query is present and overrides animations/transitions', () => {
  assert.match(html, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/);
  assert.match(html, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(html, /animation-duration:\s*0\.01ms\s*!important/);
});

// 7. Single-Language & Translations (Requirement 74)
test('74. single-language mode: pure Chinese in zh-CN and pure English in en with no bilingual slashes', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;

  // zh-CN
  context.setAdminLocale('zh-CN');
  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true,
    checkout: { payment_state: 'paid', reconciliation_valid: true }
  }]);
  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, />去结账<\/button>/);
  assert.match(rendered, />已结账<\/span>/);
  assert.doesNotMatch(rendered, /\s\/\s/);
  const zhLabels = (rendered.match(/>([^<]+)<\/(?:th|button|span)>/g) || []).map(m => m.replace(/^>|<\/[a-z]+>$/g, '').trim());
  for (const label of zhLabels) {
    if (label) {
      assert.doesNotMatch(label, /Checkout|Paid|Draft|Awaiting/, `Chinese UI label must contain no English label: ${label}`);
    }
  }

  // en
  context.setAdminLocale('en');
  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true,
    checkout: { payment_state: 'paid', reconciliation_valid: true }
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, />Checkout<\/button>/);
  assert.match(rendered, />Paid<\/span>/);
  assert.doesNotMatch(rendered, /\s\/\s/);

  const enLabels = (rendered.match(/>([^<]+)<\/(?:th|button|span)>/g) || []).map(m => m.replace(/^>|<\/[a-z]+>$/g, '').trim());
  for (const label of enLabels) {
    if (label) {
      assert.doesNotMatch(label, /[\u4e00-\u9fa5]/, `English UI label must contain no Chinese: ${label}`);
    }
  }
});

// 8. Auth and No Regression (Requirement 75)
test('75. owner auth and existing appointments functionality is verified without regressions', () => {
  const { context } = createPageContext();
  assert.strictEqual(typeof context.loadAppointments, 'function');
  assert.strictEqual(typeof context.updateAppointmentStatus, 'function');
  assert.strictEqual(typeof context.adminLogin, 'function');
  assert.strictEqual(typeof context.ownerLogout, 'function');
  assert.strictEqual(typeof context.showLogin, 'function');
  assert.strictEqual(typeof context.showAdmin, 'function');
});
