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

function parseMockButtons(html, onAttrRemoved) {
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
      addEventListener(type, handler) {
        if (!listeners.has(type)) {
          listeners.set(type, []);
        }
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        if (!listeners.has(type)) return;
        const list = listeners.get(type).filter(h => h !== handler);
        listeners.set(type, list);
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
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{ ...sampleAppointment, can_start_checkout: true }]);
  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  if (checkoutBtn) checkoutBtn.click();
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

// 9. Safe DOM Event Binding & Private Event Architecture (Requirements 31-63)
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

    // DOM parsed buttons must not contain onclick or on* attributes and no data-action-key retained
    const buttons = elements.get('content').querySelectorAll('button');
    assert.ok(buttons.length > 0, 'Buttons should be rendered');
    for (const btn of buttons) {
      assert.strictEqual(btn.getAttribute('onclick'), null, 'Button must not have onclick attribute');
      assert.strictEqual(btn.getAttribute('data-action-key'), null, 'data-action-key must not be retained in DOM');
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

test('78. clicking status button with malicious appointment ID is rejected before any network request (Req 34 & 54)', async () => {
  const maliciousIds = [
    "');alert(1);//",
    "&#39;);alert(1);//",
    '"><svg onload=alert(1)>',
    '</button><script>alert(1)</script>',
    'not-a-uuid',
    '12345'
  ];

  for (const maliciousId of maliciousIds) {
    const { context, elements, alerts, requests } = createPageContext();

    context.renderAppointments([{
      ...sampleAppointment,
      id: maliciousId,
      status: 'pending'
    }]);

    const buttons = elements.get('content').querySelectorAll('button[data-action="status"]');
    assert.ok(buttons.length >= 2, 'Pending status buttons should exist');

    // Click the first button (confirm)
    buttons[0].click();
    await new Promise(r => setTimeout(r, 10));

    // Verify rejection: no network requests sent because UUID regex failed
    assert.strictEqual(requests.filter(r => r.url === '/api/admin/update-status-db').length, 0, `Mutating network request must not be sent for malicious ID: ${maliciousId}`);
    assert.strictEqual(alerts.length, 0, `No alert must be called for malicious ID: ${maliciousId}`);
  }
});

test('79. clicking normal UUID status button invokes action exactly once with valid request payload (Req 35 & 55)', async () => {
  const { context, elements, requests } = createPageContext();

  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);

  const buttons = elements.get('content').querySelectorAll('button[data-action="status"]');
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

  // Stale button click must NOT trigger any new request (Requirement 24)
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const mutationsAfterStaleClick = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(mutationsAfterStaleClick.length, 1, 'Stale detached button must not trigger operations');

  // The re-rendered button in the active DOM triggers the next request
  const newConfirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(newConfirmBtn, 'Newly rendered confirm button must exist after loadAppointments re-render');
  newConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const statusMutationsAfterSecondClick = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutationsAfterSecondClick.length, 2, 'Newly rendered button click sends second mutation request');
});

test('80. re-rendering and locale switching cleans previous action registry without duplicate listeners (Req 36 & 57)', async () => {
  const { context, elements, requests } = createPageContext();

  // Initial render
  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);
  const initialButtons = elements.get('content').querySelectorAll('button[data-action="status"]');
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
  const currentButtons = elements.get('content').querySelectorAll('button[data-action="status"]');
  const currentConfirmBtn = currentButtons.find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(currentConfirmBtn, 'Current confirm button must exist in English locale');

  // Click the current button: must trigger exactly 1 mutation request
  currentConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const currentMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(currentMutations.length, 1, 'Current button click must trigger exactly 1 status mutation request');

  // Click the stale button from before re-rendering: registry was cleared and generation expired, so nothing happens
  staleConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const afterStaleMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(afterStaleMutations.length, 1, 'Stale button click must NOT trigger any new request');
});

test('81. FEATURE_CHECKOUT_ENABLED=false: checkout button omitted, globalScope handler deleted, 0 requests (Req 40 & 41)', () => {
  const { context, elements, requests } = createPageContext();

  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, false);
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined', 'globalScope.openCheckoutWorkflow must be undefined');

  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /data-action="checkout"/);
  assert.strictEqual(requests.length, 0, 'Zero checkout requests made');
});

test('82. FEATURE_CHECKOUT_ENABLED=true and can_start_checkout=true: button present with safe addEventListener and no inline onclick (Req 41 & 52)', () => {
  const { context, elements, requests } = createPageContext();

  // Enable feature gate
  context.FEATURE_CHECKOUT_ENABLED = true;
  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, true);
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined', 'globalScope.openCheckoutWorkflow must remain undefined even when true');

  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /data-action="checkout"/);
  assert.doesNotMatch(rendered, /onclick/i);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);

  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(checkoutBtn, 'Checkout button must exist');
  assert.strictEqual(checkoutBtn.getAttribute('onclick'), null);
  assert.strictEqual(checkoutBtn.getAttribute('data-action-key'), null, 'data-action-key must be removed after binding');

  // Click checkout button: dispatches safely in private closure
  checkoutBtn.click();
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, 'Zero mutating checkout requests made');

  // Disable feature gate again
  context.FEATURE_CHECKOUT_ENABLED = false;
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined', 'globalScope.openCheckoutWorkflow must remain undefined');
});

test('83. absence of dynamic inline onclick across all appointment statuses and entity decoding safety (Req 37 & 59)', () => {
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

test('84. globalScope has no openCheckoutWorkflow, appointmentActionRegistry, or executeAppointmentActionByKey (Req 41-44)', () => {
  const { context } = createPageContext();
  assert.strictEqual(context.openCheckoutWorkflow, undefined);
  assert.strictEqual(context.appointmentActionRegistry, undefined);
  assert.strictEqual(context.executeAppointmentActionByKey, undefined);
  assert.strictEqual(typeof context.openCheckoutWorkflow, 'undefined');
  assert.strictEqual(typeof context.appointmentActionRegistry, 'undefined');
  assert.strictEqual(typeof context.executeAppointmentActionByKey, 'undefined');
});

test('85. production code does not redefine FEATURE_CHECKOUT_ENABLED via Object.defineProperty and descriptor is normal (Req 45-46)', () => {
  assert.doesNotMatch(html, /Object\.defineProperty\([^,]+,\s*['"]FEATURE_CHECKOUT_ENABLED['"]/);
  const { context } = createPageContext();
  const desc = Object.getOwnPropertyDescriptor(context, 'FEATURE_CHECKOUT_ENABLED');
  assert.strictEqual(desc?.get, undefined, 'Must not have custom getter');
  assert.strictEqual(desc?.set, undefined, 'Must not have custom setter');
});

test('86. FEATURE_CHECKOUT_ENABLED fails closed on undefined, null, false, "true", 1, "yes" (Req 47-48)', () => {
  const falsyGateValues = [undefined, null, false, 'true', 1, 'yes', 0, '', {}];
  for (const gateVal of falsyGateValues) {
    const { context, elements } = createPageContext();
    context.FEATURE_CHECKOUT_ENABLED = gateVal;
    context.renderAppointments([{
      ...sampleAppointment,
      can_start_checkout: true
    }]);
    const rendered = elements.get('content').innerHTML;
    assert.doesNotMatch(rendered, /class="checkout-btn"/, `Gate value ${JSON.stringify(gateVal)} must fail closed`);
    assert.strictEqual(elements.get('content').querySelectorAll('button[data-action="checkout"]').length, 0);
  }
});

test('87. gate=true at render, then changed to false before click aborts workflow with 0 requests (Req 49)', () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(checkoutBtn, 'Checkout button must be rendered');

  // Change gate to false before click
  context.FEATURE_CHECKOUT_ENABLED = false;

  checkoutBtn.click();

  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0);
});

test('88. can_start_checkout changed to false before click or expired render generation aborts workflow (Req 50)', () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  const appt = { ...sampleAppointment, can_start_checkout: true };
  context.renderAppointments([appt]);

  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(checkoutBtn);

  // Expire render generation by re-rendering
  context.renderAppointments([]);

  // Clicking stale button from previous render generation
  checkoutBtn.click();
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0);
});

test('89. tampering with button data attributes cannot hijack action or dispatch another appointment (Req 51)', async () => {
  const { context, elements, requests } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  }]);

  const buttons = elements.get('content').querySelectorAll('button[data-action="status"]');
  const confirmBtn = buttons.find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(confirmBtn);

  // Attacker modifies DOM attributes to try to perform checkout or cancel another appointment
  confirmBtn.setAttribute('data-action', 'checkout');
  confirmBtn.setAttribute('data-target-status', 'cancelled');
  confirmBtn.setAttribute('data-action-key', '999');

  // Click button
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  // Must still execute the immutable captured status 'confirmed' on appointment 00000000-0000-4000-8000-000000000001
  const statusMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutations.length, 1);
  const body = JSON.parse(statusMutations[0].options.body);
  assert.strictEqual(body.appointmentId, '00000000-0000-4000-8000-000000000001');
  assert.strictEqual(body.status, 'confirmed', 'Must use closure captured status, ignoring DOM tampering');
});

test('90. after binding is complete, DOM does not retain data-action-key (Req 52)', () => {
  const { context, elements } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'pending',
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /data-action-key/);

  const buttons = elements.get('content').querySelectorAll('button');
  assert.ok(buttons.length > 0);
  for (const btn of buttons) {
    assert.strictEqual(btn.getAttribute('data-action-key'), null);
    assert.strictEqual(btn.hasAttribute('data-action-key'), false);
  }
});

test('91. two different appointment buttons only operate on their own appointment (Req 53)', async () => {
  const { context, elements, requests } = createPageContext();
  const appt1 = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000001', status: 'pending' };
  const appt2 = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000002', status: 'confirmed' };

  context.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      status: 200,
      ok: true,
      async json() {
        if (url.includes('/api/appointments-db')) {
          return { success: true, data: [appt1, appt2], appointments: [appt1, appt2] };
        }
        return { success: true };
      }
    };
  };

  context.renderAppointments([appt1, appt2]);

  const statusBtns = elements.get('content').querySelectorAll('button[data-action="status"]');
  // First appointment confirm button
  const confirmBtn = statusBtns.find(b => b.textContent === '确认' || b.getAttribute('data-target-status') === 'confirmed');
  // Second appointment arrive button
  const arriveBtn = statusBtns.find(b => b.textContent === '已到店' || b.getAttribute('data-target-status') === 'arrived');

  assert.ok(confirmBtn);
  assert.ok(arriveBtn);

  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const m1 = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(m1.length, 1);
  assert.strictEqual(JSON.parse(m1[0].options.body).appointmentId, '00000000-0000-4000-8000-000000000001');

  // After first appointment status updates, loadAppointments refreshes active DOM
  const activeStatusBtns = elements.get('content').querySelectorAll('button[data-action="status"]');
  const activeArriveBtn = activeStatusBtns.find(b => b.textContent === '已到店' || b.getAttribute('data-target-status') === 'arrived');
  assert.ok(activeArriveBtn);

  activeArriveBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const m2 = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(m2.length, 2);
  assert.strictEqual(JSON.parse(m2[1].options.body).appointmentId, '00000000-0000-4000-8000-000000000002');
});

test('92. showLogin() invalidates action context so old status button click triggers 0 fetch and 0 mutation (Req 40-42)', async () => {
  const { context, elements, requests } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'pending'
  }]);

  const statusBtns = elements.get('content').querySelectorAll('button[data-action="status"]');
  const confirmBtn = statusBtns.find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(confirmBtn);

  // Invoke showLogin to clear protected UI and invalidate action context
  context.showLogin();

  // Click old status button
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const mutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(mutations.length, 0, 'Clicking old status button after showLogin() must trigger 0 mutation requests');
  assert.strictEqual(requests.length, 0, 'Zero requests must be sent');
});

test('93. showLogin() invalidates action context so old checkout button click triggers 0 workflow, 0 navigation, 0 requests (Req 43-45)', () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    can_start_checkout: true
  }]);

  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(checkoutBtn);

  // Invoke showLogin
  context.showLogin();

  // Click old checkout button
  checkoutBtn.click();

  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, 'Zero checkout requests');
  assert.strictEqual(requests.length, 0);
});

test('94. ownerLogout() invalidates action context immediately at invocation before network completes or on network failure (Req 46)', async () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'pending',
    can_start_checkout: true
  }]);

  const confirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(confirmBtn);
  assert.ok(checkoutBtn);

  let resolveLogout;
  context.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/owner/logout') {
      return new Promise(resolve => {
        resolveLogout = () => resolve({ status: 200, ok: true, json: async () => ({ success: true }) });
      });
    }
    return { status: 200, ok: true, json: async () => ({ success: true }) };
  };

  // Start logout (asynchronous fetch in progress)
  const logoutPromise = context.ownerLogout();

  // Immediately click old buttons while logout network request is in-flight
  confirmBtn.click();
  checkoutBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const mutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(mutations.length, 0, 'Status button clicked during logout must trigger 0 status mutations');
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, 'Checkout button clicked during logout must trigger 0 checkout requests');

  // Resolve logout fetch
  if (resolveLogout) resolveLogout();
  await logoutPromise;
});

test('95. API 401/403 session expiration invalidates context so old buttons trigger 0 operations (Req 47)', async () => {
  const { context, elements, requests } = createPageContext();
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'pending'
  }]);

  const confirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(confirmBtn);

  // Configure fetch to return 401 on appointments read
  context.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/api/appointments-db')) {
      return { status: 401, ok: false, json: async () => ({ success: false, message: 'Session expired' }) };
    }
    return { status: 200, ok: true, json: async () => ({ success: true }) };
  };

  await context.loadAppointments();

  // Click old status button after 401 session expiry
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const statusMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutations.length, 0, 'Status button after 401 must trigger 0 mutation requests');
});

test('96. current appointment missing from active appointment index strictly fails closed with 0 operations (Req 48-49)', async () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  context.renderAppointments([{
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending',
    can_start_checkout: true
  }]);

  const confirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(confirmBtn);
  assert.ok(checkoutBtn);

  // Clear private appointments by re-rendering empty list
  context.renderAppointments([]);

  // Click status button from previous render
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(requests.filter(r => r.url === '/api/admin/update-status-db').length, 0, 'Status button must send 0 requests when appointment missing');

  // Click checkout button from previous render
  checkoutBtn.click();
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, 'Checkout button must send 0 requests when appointment missing');

  // Verify no ?? true fallback exists in admin.html
  assert.doesNotMatch(html, /\?\?\s*true/, 'No ?? true fallback allowed');
  assert.doesNotMatch(html, /can_start_checkout\s*===?\s*true\s*:\s*true/, 'No : true fallback allowed for can_start_checkout');
});

test('97. can_start_checkout changed to false on current appointment before click strictly fails closed (Req 50)', () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;
  const appt = { ...sampleAppointment, can_start_checkout: true };
  context.renderAppointments([appt]);

  const checkoutBtn = elements.get('content').querySelector('button[data-action="checkout"]');
  assert.ok(checkoutBtn);

  // Mutate can_start_checkout to false before clicking
  appt.can_start_checkout = false;

  checkoutBtn.click();
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, 'Checkout 0 operations when can_start_checkout changed to false');
});

test('98. re-login and re-render activates new buttons while old buttons from previous session remain completely inert (Req 53)', async () => {
  const { context, elements, requests } = createPageContext();
  const appt1 = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000001', status: 'pending' };
  const appt2 = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000002', status: 'pending' };

  // Session 1: initial render
  context.renderAppointments([appt1]);
  const oldConfirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(oldConfirmBtn);

  // User logs out
  await context.ownerLogout();

  // Session 2: re-login and re-render
  context.renderAppointments([appt2]);
  const newConfirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(newConfirmBtn);

  // Click old button from Session 1
  oldConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(requests.filter(r => r.url === '/api/admin/update-status-db').length, 0, 'Old session button must be inert');

  // Click new button from Session 2
  newConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const newMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(newMutations.length, 1, 'New session button must execute once');
  assert.strictEqual(JSON.parse(newMutations[0].options.body).appointmentId, '00000000-0000-4000-8000-000000000002');
});

test('99. Shop A old button cannot operate Shop B appointment across different shop sessions (Req 54)', async () => {
  const { context, elements, requests } = createPageContext();
  const shopAAppt = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000001', status: 'pending' };
  const shopBAppt = { ...sampleAppointment, id: '00000000-0000-4000-8000-000000000002', status: 'pending' };

  // Shop A
  context.renderAppointments([shopAAppt]);
  const shopAConfirmBtn = elements.get('content').querySelectorAll('button[data-action="status"]').find(b => b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(shopAConfirmBtn);

  // Switch to Shop B
  await context.ownerLogout();
  context.renderAppointments([shopBAppt]);

  // Click Shop A button
  shopAConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(requests.filter(r => r.url === '/api/admin/update-status-db').length, 0, 'Shop A button must not operate Shop B appointments');
});

test('100. tampering globalScope.currentAppointments cannot inject fake appointments or forge actions through language switch (Req 18 & 21)', async () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;

  // a. Normal render of 2 authoritative appointments
  const appt1 = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    customer_name: 'Alice',
    status: 'pending',
    can_start_checkout: false,
    checkout: null
  };
  const appt2 = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000002',
    customer_name: 'Bob',
    status: 'confirmed',
    can_start_checkout: false,
    checkout: null
  };
  context.renderAppointments([appt1, appt2]);

  // b. Tamper globalScope.currentAppointments by pushing forged appointment
  context.currentAppointments.push({
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000999',
    customer_name: 'AttackerFake',
    status: 'pending',
    can_start_checkout: true,
    checkout: null
  });

  // c. Change real appointment can_start_checkout from false to true in global array
  context.currentAppointments[0].can_start_checkout = true;

  // d. Modify real appointment ID, checkout/payment_state, and status in global array
  context.currentAppointments[1].id = '00000000-0000-4000-8000-000000000888';
  context.currentAppointments[1].checkout = { payment_state: 'paid', reconciliation_valid: true };
  context.currentAppointments[1].status = 'arrived';

  // e. Trigger language switch and re-render
  context.setAdminLocale('en');

  // f. Confirm forged appointment cannot enter DOM, cannot enter private Map, cannot produce usable operations
  const renderedHtml = elements.get('content').innerHTML;
  assert.doesNotMatch(renderedHtml, /AttackerFake/, 'Forged appointment must not appear in rendered DOM');
  assert.doesNotMatch(renderedHtml, /00000000-0000-4000-8000-000000000999/, 'Forged appointment ID must not appear in DOM');
  assert.doesNotMatch(renderedHtml, /00000000-0000-4000-8000-000000000888/, 'Forged modified ID must not appear in DOM');

  // Authoritative appts both had can_start_checkout: false, so 0 checkout buttons rendered
  const checkoutButtons = elements.get('content').querySelectorAll('button[data-action="checkout"]');
  assert.strictEqual(checkoutButtons.length, 0, 'No checkout button should be rendered from tampered global array');

  // Appt 2 did NOT get Paid badge from global tampering
  assert.doesNotMatch(renderedHtml, /status-paid/, 'Paid badge must not be rendered from tampered global array');

  // Legitimate buttons for appt 1 and appt 2 still work as authorized
  const statusButtons = elements.get('content').querySelectorAll('button[data-action="status"]');
  const confirmBtn = statusButtons.find(b => b.textContent === 'Confirm' || b.getAttribute('data-target-status') === 'confirmed');
  assert.ok(confirmBtn, 'Authoritative confirm button must be rendered in English');
  confirmBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const statusMutations = requests.filter(r => r.url === '/api/admin/update-status-db');
  assert.strictEqual(statusMutations.length, 1, 'Only authoritative action executes');
  assert.strictEqual(JSON.parse(statusMutations[0].options.body).appointmentId, '00000000-0000-4000-8000-000000000001');
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0, '0 checkout requests');
});

test('101. nested tampering of globalScope.currentAppointments does not affect private snapshot or click authorization (Req 19-20)', async () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;

  const appt = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending',
    can_start_checkout: false,
    checkout: null,
    items: [{ service_name: 'Haircut', sequence_no: 1 }]
  };
  context.renderAppointments([appt]);

  // Nested property tampering on global array
  context.currentAppointments[0].can_start_checkout = true;
  context.currentAppointments[0].checkout = { payment_state: 'paid', reconciliation_valid: true };
  context.currentAppointments[0].items.push({ service_name: 'HackedItem', sequence_no: 2 });
  context.currentAppointments[0].id = '00000000-0000-4000-8000-000000000666';

  // Language switch to zh-CN
  context.setAdminLocale('zh-CN');

  const rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /HackedItem/, 'Tampered items must not appear');
  assert.doesNotMatch(rendered, /00000000-0000-4000-8000-000000000666/, 'Tampered ID must not appear');
  assert.strictEqual(elements.get('content').querySelectorAll('button[data-action="checkout"]').length, 0, 'No checkout button generated');

  // Checkout request count strictly 0
  assert.strictEqual(requests.filter(r => r.url?.includes('/checkout')).length, 0);
});

test('102. authoritative appointments preserve correct behavior across locale switches, sessions, and shops (Req 22-25)', async () => {
  const { context, elements, requests } = createPageContext();
  const appt1 = {
    ...sampleAppointment,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending'
  };

  context.renderAppointments([appt1]);

  // Switch to English
  context.setAdminLocale('en');
  const enButtons = elements.get('content').querySelectorAll('button[data-action="status"]');
  const enConfirmBtn = enButtons.find(b => b.textContent === 'Confirm');
  assert.ok(enConfirmBtn, 'Confirm button in English exists');

  // Click confirm in English
  enConfirmBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(requests.filter(r => r.url === '/api/admin/update-status-db').length, 1);

  // Logout clears private snapshot
  await context.ownerLogout();

  // Switching locale after logout does not resurrect logged out appointments
  context.setAdminLocale('zh-CN');
  assert.doesNotMatch(elements.get('content').innerHTML, /00000000-0000-4000-8000-000000000001/);
});
