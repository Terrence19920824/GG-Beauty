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

function parseMockButtons(html) {
  const buttons = [];
  const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match;
  while ((match = buttonRegex.exec(html)) !== null) {
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
      getAttribute(name) {
        return attrs.has(name.toLowerCase()) ? attrs.get(name.toLowerCase()) : null;
      },
      hasAttribute(name) {
        return attrs.has(name.toLowerCase());
      },
      setAttribute(name, val) {
        attrs.set(name.toLowerCase(), String(val));
      },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      removeEventListener(event, fn) {
        if (listeners.has(event)) {
          const arr = listeners.get(event).filter(f => f !== fn);
          listeners.set(event, arr);
        }
      },
      closest(selector) {
        if (selector === 'button' || selector.includes('button')) return this;
        return null;
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

const createPageContext = (customElements = {}) => {
  const elements = new Map();
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

  let _contentHtml = '';
  let _contentButtons = [];
  const contentEl = {
    id: 'content',
    get innerHTML() {
      return _contentHtml;
    },
    set innerHTML(val) {
      _contentHtml = String(val || '');
      _contentButtons = parseMockButtons(_contentHtml);
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
      if (sel === 'button[data-action-key]') {
        return _contentButtons.filter(b => b.hasAttribute('data-action-key'));
      }
      if (sel === 'button') {
        return _contentButtons;
      }
      if (sel.startsWith('[') && sel.endsWith(']')) {
        const attrName = sel.slice(1, -1).toLowerCase();
        return _contentButtons.filter(b => b.hasAttribute(attrName));
      }
      return [];
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    ...(customElements['content'] || {})
  };
  elements.set('content', contentEl);

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
        async json() {
          if (url.includes('/api/appointments-db')) {
            return { success: true, data: [sampleAppointment], appointments: [sampleAppointment] };
          }
          return { success: true };
        }
      };
    },
    document: {
      getElementById(id) {
        const element = elements.get(id);
        if (!element) throw new Error(`Unknown element: ${id}`);
        return element;
      },
      querySelectorAll(selector) {
        return elements.get('content')?.querySelectorAll(selector) || [];
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

test('63. gate=true and can_start_checkout=true renders checkout button with safe event binding', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /data-action="checkout"/);
  assert.doesNotMatch(rendered, /onclick/i);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);
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

// 9. Safe DOM Event Binding & Inline Handler Elimination (Requirements 31-43)
test('76. malicious appointment IDs cannot inject inline JS or escape into executable event handlers (Req 31 & 33)', () => {
  const maliciousIds = [
    "');alert(1);//",
    "&#39;);alert(1);//",
    "&apos;);alert(1);//",
    '"><svg onload=alert(1)>',
    '</button><script>alert(1)</script>'
  ];

  for (const maliciousId of maliciousIds) {
    const { context, elements, alerts } = createPageContext();
    context.FEATURE_CHECKOUT_ENABLED = true;

    context.renderAppointments([{
      ...sampleAppointment,
      id: maliciousId,
      status: 'pending',
      can_start_checkout: true
    }]);

    const rendered = elements.get('content').innerHTML;

    // No executable injection tags
    assert.doesNotMatch(rendered, /<script\b/i, `Payload ID must not generate script tag: ${maliciousId}`);
    assert.doesNotMatch(rendered, /<svg\b/i, `Payload ID must not generate svg tag: ${maliciousId}`);
    assert.doesNotMatch(rendered, /<img\b/i, `Payload ID must not generate img tag: ${maliciousId}`);

    // No inline on* handler attributes anywhere in rendered HTML
    assert.doesNotMatch(rendered, /\bon[a-z]+\s*=/i, `Rendered markup must not contain any inline event attribute: ${maliciousId}`);
    assert.doesNotMatch(rendered, /onclick/i, `Rendered markup must not contain onclick: ${maliciousId}`);
    assert.doesNotMatch(rendered, /onload/i, `Rendered markup must not contain onload: ${maliciousId}`);
    assert.doesNotMatch(rendered, /onerror/i, `Rendered markup must not contain onerror: ${maliciousId}`);

    // No alert executed
    assert.strictEqual(alerts.length, 0, `No window.alert must be executed for malicious ID: ${maliciousId}`);

    // DOM parsed buttons must not contain onclick or on* attributes
    const buttons = elements.get('content').querySelectorAll('button');
    assert.ok(buttons.length > 0, 'Buttons should be rendered');
    for (const btn of buttons) {
      assert.strictEqual(btn.getAttribute('onclick'), null, 'Button must not have onclick attribute');
      assert.doesNotMatch(btn.getAttribute('data-action-key') || '', /alert|script|<|>/i, 'Action key must be safe numeric');
    }
  }
});

test('77. malicious customer, staff, and service names cannot inject executable tags or event attributes (Req 32 & 33)', () => {
  const maliciousPayloads = [
    '<img src=x onerror=alert(1)>',
    '</span><script>alert(1)</script>',
    '"><svg onload=alert(1)>'
  ];

  for (const payload of maliciousPayloads) {
    const { context, elements, alerts } = createPageContext();
    context.FEATURE_CHECKOUT_ENABLED = true;

    context.renderAppointments([{
      ...sampleAppointment,
      customer_name: payload,
      staff_name: payload,
      service_name: payload,
      items: [
        {
          id: 'item-payload',
          sequence_no: 1,
          service_name: payload,
          primary_staff_name: payload,
          assistant_staff: [
            { id: 'as-1', staff_name: payload }
          ]
        }
      ]
    }]);

    const rendered = elements.get('content').innerHTML;

    // Parse all HTML tags and ensure no script/img/svg and no on* event attributes exist
    const tagRegex = /<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9-_:]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(rendered)) !== null) {
      const tagName = tagMatch[1].toLowerCase();
      assert.notStrictEqual(tagName, 'script', `Payload must not generate script tag: ${payload}`);
      assert.notStrictEqual(tagName, 'img', `Payload must not generate img tag: ${payload}`);
      assert.notStrictEqual(tagName, 'svg', `Payload must not generate svg tag: ${payload}`);

      const attrString = tagMatch[2];
      const attrRegex = /([a-zA-Z0-9-_:]+)\s*=/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrString)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        assert.ok(!attrName.startsWith('on'), `Tag <${tagName}> must not have event attribute: ${attrName} from payload: ${payload}`);
      }
    }
    assert.strictEqual(alerts.length, 0, `Alert must not be called: ${payload}`);
  }
});

test('78. clicking status button with malicious appointment ID is rejected before any network request (Req 34)', async () => {
  const maliciousIds = [
    "');alert(1);//",
    "&#39;);alert(1);//",
    '"><svg onload=alert(1)>',
    '</button><script>alert(1)</script>'
  ];

  for (const maliciousId of maliciousIds) {
    const { context, elements, alerts, requests } = createPageContext();

    context.renderAppointments([{
      ...sampleAppointment,
      id: maliciousId,
      status: 'pending'
    }]);

    const buttons = elements.get('content').querySelectorAll('button[data-action-key]');
    assert.ok(buttons.length >= 2, 'Pending status buttons should exist');

    // Click the first button (confirm)
    buttons[0].click();

    // Verify rejection: no network requests sent because UUID regex failed
    assert.strictEqual(requests.length, 0, `Mutating network request must not be sent for malicious ID: ${maliciousId}`);
    assert.strictEqual(alerts.length, 0, `No alert must be called for malicious ID: ${maliciousId}`);
  }
});

test('79. clicking normal UUID status button invokes action exactly once with valid request payload (Req 35 & 42)', async () => {
  const { context, elements, requests } = createPageContext();

  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);

  const buttons = elements.get('content').querySelectorAll('button[data-action-key]');
  const confirmBtn = buttons.find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(confirmBtn, 'Confirm button must exist');
  assert.strictEqual(confirmBtn.getAttribute('data-action'), 'status');
  assert.strictEqual(confirmBtn.getAttribute('onclick'), null, 'Must have no inline onclick');

  // Click once
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const statusMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutations.length, 1, 'Exactly one status mutation request should be sent');
  assert.strictEqual(statusMutations[0].options.method, 'POST');
  const body = JSON.parse(statusMutations[0].options.body);
  assert.strictEqual(body.appointmentId, '00000000-0000-4000-8000-000000000001');
  assert.strictEqual(body.status, 'confirmed');

  // Stale button click must NOT trigger any new request (Requirement 14)
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const mutationsAfterStaleClick = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(mutationsAfterStaleClick.length, 1, 'Stale detached button must not trigger operations');

  // The re-rendered button in the active DOM triggers the next request
  const newConfirmBtn = elements.get('content').querySelectorAll('button[data-action-key]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(newConfirmBtn, 'Newly rendered confirm button must exist after loadAppointments re-render');
  newConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const statusMutationsAfterSecondClick = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutationsAfterSecondClick.length, 2, 'Newly rendered button click sends second mutation request');
});

test('80. re-rendering and locale switching cleans previous action registry without duplicate listeners (Req 36 & 43)', async () => {
  const { context, elements, requests } = createPageContext();

  // Initial render
  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);
  const initialButtons = elements.get('content').querySelectorAll('button[data-action-key]');
  const staleConfirmBtn = initialButtons.find(b => b.getAttribute('data-target-status') === 'confirmed');

  // Re-render multiple times
  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);

  // Switch locale (triggers re-render)
  context.setAdminLocale('en');

  // Get current button
  const currentButtons = elements.get('content').querySelectorAll('button[data-action-key]');
  const currentConfirmBtn = currentButtons.find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(currentConfirmBtn, 'Current confirm button must exist in English locale');

  // Click the current button: must trigger exactly 1 mutation request
  currentConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const currentMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(currentMutations.length, 1, 'Current button click must trigger exactly 1 status mutation request');

  // Click the stale button from before re-rendering: registry was cleared, so nothing happens
  staleConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const afterStaleMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(afterStaleMutations.length, 1, 'Stale button click must NOT trigger any new request');
});

test('81. FEATURE_CHECKOUT_ENABLED=false: checkout button omitted, globalScope handler deleted, 0 requests (Req 40)', () => {
  const { context, elements, requests } = createPageContext();

  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, false);
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined', 'globalScope.openCheckoutWorkflow must be deleted when false');

  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /data-action="checkout"/);
  assert.strictEqual(requests.length, 0, 'Zero checkout requests made');
});

test('82. FEATURE_CHECKOUT_ENABLED=true and can_start_checkout=true: button present with safe addEventListener and no inline onclick (Req 41)', () => {
  const { context, elements, requests } = createPageContext();

  // Enable feature gate
  context.FEATURE_CHECKOUT_ENABLED = true;
  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, true);
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'function', 'globalScope.openCheckoutWorkflow registered');

  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /data-action="checkout"/);
  assert.doesNotMatch(rendered, /onclick/i);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);

  const buttons = elements.get('content').querySelectorAll('button[data-action-key]');
  const checkoutBtn = buttons.find(b => b.getAttribute('data-action') === 'checkout');
  assert.ok(checkoutBtn, 'Checkout button must exist');
  assert.strictEqual(checkoutBtn.getAttribute('onclick'), null);
  assert.ok(checkoutBtn.hasAttribute('data-action-key'));

  // Click checkout button: dispatches safely to openCheckoutWorkflow
  checkoutBtn.click();
  assert.strictEqual(requests.length, 0, 'Zero mutating checkout requests made');

  // Disable feature gate again
  context.FEATURE_CHECKOUT_ENABLED = false;
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined', 'globalScope.openCheckoutWorkflow must be deleted when false');
});

test('83. absence of dynamic inline onclick across all appointment statuses and entity decoding safety (Req 37 & 39)', () => {
  const allStatuses = ['pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show'];

  for (const st of allStatuses) {
    const { context, elements } = createPageContext();
    context.FEATURE_CHECKOUT_ENABLED = true;

    context.renderAppointments([{
      ...sampleAppointment,
      status: st,
      can_start_checkout: true
    }]);

    const rendered = elements.get('content').innerHTML;
    assert.doesNotMatch(rendered, /\bon[a-z]+\s*=/i, `Status ${st} must not contain any inline on* attributes in markup`);
    assert.doesNotMatch(rendered, /onclick/i, `Status ${st} must not contain onclick`);

    const buttons = elements.get('content').querySelectorAll('button');
    for (const btn of buttons) {
      assert.strictEqual(btn.getAttribute('onclick'), null, `Button in status ${st} must have no onclick`);
    }
  }

  // Entity decoding test: &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;
  const { context, elements, alerts } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    id: '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    customer_name: '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
  }]);
  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /<script[\s>]/i);
  assert.strictEqual(alerts.length, 0);
});
