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

test('completed appointment without explicit paid checkout does NOT show Paid pill (fail closed)', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{ ...sampleAppointment, status: 'completed', checkout: null }]);
  const rendered = elements.get('content').innerHTML;

  assert.match(rendered, /class="status completed"/);
  assert.match(rendered, /已完成/);

  // Decoupling rule: MUST NOT infer "Paid" from appointment.status === 'completed'
  assert.doesNotMatch(rendered, /class="pill status-paid notranslate"/);
  assert.doesNotMatch(rendered, /class="pill status-awaiting-checkout notranslate"/);
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);
});

test('paid status pill only appears from explicit checkout state', () => {
  const { context, elements } = createPageContext();

  // Authoritative projection: checkout.payment_state === 'paid'
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    checkout: {
      checkout_id: 'chk-1',
      checkout_status: 'paid',
      payment_state: 'paid',
      reconciliation_valid: true
    }
  }]);
  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.match(rendered, /已结账/);

  // Backward-compatible fallback: flat payment_status = 'paid'
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    checkout_status: 'paid'
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.match(rendered, /已结账/);
});

test('can_start_checkout controls checkout entry button visibility', () => {
  const { context, elements } = createPageContext();

  // in_service without can_start_checkout (defaults to false): NO checkout button
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: false
  }]);
  let rendered = elements.get('content').innerHTML;
  assert.doesNotMatch(rendered, /class="checkout-btn"/, 'Must not show checkout button when can_start_checkout is false');

  // in_service with can_start_checkout === true: shows checkout button
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /openCheckoutWorkflow\('00000000-0000-4000-8000-000000000001'\)/);
  assert.match(rendered, /data-feature-gated="true"/);

  // completed with can_start_checkout === true: shows checkout button
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    can_start_checkout: true
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);

  // already paid appointment has can_start_checkout = false: no duplicate checkout button
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: false,
    checkout: {
      checkout_id: 'chk-1',
      checkout_status: 'paid',
      payment_state: 'paid',
      reconciliation_valid: true
    }
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
});

test('all 7 checkout financial states render proper single-language badges and classes', () => {
  const { context, elements } = createPageContext();

  const states = [
    { state: 'unpaid', cssClass: 'status-draft', labelZh: '草稿单', labelEn: 'Draft' },
    { state: 'partially_paid', cssClass: 'status-partially-paid', labelZh: '部分支付', labelEn: 'Partially Paid' },
    { state: 'paid', cssClass: 'status-paid', labelZh: '已结账', labelEn: 'Paid' },
    { state: 'partially_refunded', cssClass: 'status-refunded', labelZh: '部分退款', labelEn: 'Partially Refunded' },
    { state: 'refunded', cssClass: 'status-refunded', labelZh: '已退款', labelEn: 'Refunded' },
    { state: 'void', cssClass: 'status-void', labelZh: '已作废', labelEn: 'Voided' },
    { state: 'inconsistent', cssClass: 'status-inconsistent', labelZh: '结账状态异常', labelEn: 'Checkout Status Issue' }
  ];

  for (const item of states) {
    // Chinese mode
    context.ownerSelfService._state.locale = 'zh-CN';
    context.renderAppointments([{
      ...sampleAppointment,
      status: 'in_service',
      checkout: {
        checkout_id: 'chk-test',
        checkout_status: item.state === 'void' ? 'void' : 'draft',
        payment_state: item.state,
        reconciliation_valid: item.state !== 'inconsistent'
      }
    }]);
    let rendered = elements.get('content').innerHTML;
    assert.match(rendered, new RegExp(`class="pill ${item.cssClass} notranslate"`), `Must render class ${item.cssClass} for ${item.state}`);
    assert.match(rendered, new RegExp(item.labelZh), `Must render label ${item.labelZh} in zh-CN`);

    // English mode
    context.ownerSelfService._state.locale = 'en';
    context.renderAppointments([{
      ...sampleAppointment,
      status: 'in_service',
      checkout: {
        checkout_id: 'chk-test',
        checkout_status: item.state === 'void' ? 'void' : 'draft',
        payment_state: item.state,
        reconciliation_valid: item.state !== 'inconsistent'
      }
    }]);
    rendered = elements.get('content').innerHTML;
    assert.match(rendered, new RegExp(`class="pill ${item.cssClass} notranslate"`), `Must render class ${item.cssClass} for ${item.state}`);
    assert.match(rendered, new RegExp(item.labelEn), `Must render label ${item.labelEn} in en`);
  }
});

test('inconsistent checkout state displays warning badge and disables financial action buttons', () => {
  const { context, elements } = createPageContext();

  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true, // even if erroneously true, must fail closed
    checkout: {
      checkout_id: 'chk-bad',
      checkout_status: 'draft',
      payment_state: 'inconsistent',
      reconciliation_valid: false
    }
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-inconsistent notranslate"/);
  assert.match(rendered, /role="status"/);
  assert.match(rendered, /aria-label="结账状态异常"/);
  assert.doesNotMatch(rendered, /class="checkout-btn"/, 'Inconsistent state must suppress checkout action button');
});

test('cancelled, no_show, and pending appointments strictly cannot show checkout financial badges even if inconsistent data is passed', () => {
  const { context, elements } = createPageContext();

  for (const unauthorizedStatus of ['pending', 'cancelled', 'no_show']) {
    context.renderAppointments([{
      ...sampleAppointment,
      status: unauthorizedStatus,
      can_start_checkout: true,
      checkout: {
        checkout_id: 'chk-hack',
        checkout_status: 'paid',
        payment_state: 'paid',
        reconciliation_valid: true
      }
    }]);
    const rendered = elements.get('content').innerHTML;

    assert.doesNotMatch(rendered, /status-paid/, `${unauthorizedStatus} must never show paid pill`);
    assert.doesNotMatch(rendered, /status-draft/, `${unauthorizedStatus} must never show draft pill`);
    assert.doesNotMatch(rendered, /checkout-btn/, `${unauthorizedStatus} must not have checkout button`);
    assert.doesNotMatch(rendered, /openCheckoutWorkflow/, `${unauthorizedStatus} must not reference openCheckoutWorkflow`);
  }
});

test('resolveCheckoutFinancialState directly verifies semantic decoupling and fail-closed safety', () => {
  const { context } = createPageContext();
  const resolve = context.resolveCheckoutFinancialState;

  assert.strictEqual(typeof resolve, 'function', 'resolveCheckoutFinancialState must be exposed');

  // Completed without checkout state NEVER equals paid
  assert.strictEqual(resolve({ status: 'completed' }), null);
  assert.strictEqual(resolve({ status: 'completed', checkout: null }), null);
  assert.strictEqual(resolve({ status: 'completed', checkout: undefined }), null);

  // Authoritative projection states
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'paid' } }), 'paid');
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'unpaid' } }), 'unpaid');
  assert.strictEqual(resolve({ status: 'in_service', checkout: { payment_state: 'partially_paid' } }), 'partially_paid');
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'partially_refunded' } }), 'partially_refunded');
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'refunded' } }), 'refunded');
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'void' } }), 'void');
  assert.strictEqual(resolve({ status: 'completed', checkout: { payment_state: 'inconsistent' } }), 'inconsistent');
  assert.strictEqual(resolve({ status: 'completed', checkout: { reconciliation_valid: false } }), 'inconsistent');
  assert.strictEqual(resolve({ status: 'completed', checkout: { has_inconsistency: true } }), 'inconsistent');

  // Flat legacy field compatibility
  assert.strictEqual(resolve({ status: 'completed', checkout_status: 'paid' }), 'paid');
  assert.strictEqual(resolve({ status: 'completed', payment_status: 'PAID' }), 'paid');
  assert.strictEqual(resolve({ status: 'in_service', checkout_status: 'awaiting_checkout' }), 'awaiting_checkout');
  assert.strictEqual(resolve({ status: 'in_service', checkout_status: 'draft' }), 'unpaid');

  // Unauthorized appointment statuses fail closed even if paid
  assert.strictEqual(resolve({ status: 'pending', checkout: { payment_state: 'paid' } }), null);
  assert.strictEqual(resolve({ status: 'cancelled', checkout: { payment_state: 'paid' } }), null);
  assert.strictEqual(resolve({ status: 'no_show', checkout: { payment_state: 'paid' } }), null);
  assert.strictEqual(resolve(null), null);
  assert.strictEqual(resolve(undefined), null);
});

test('canStartCheckout helper strictly enforces authoritative gate, lifecycle, and inconsistency safety', () => {
  const { context } = createPageContext();
  const canStart = context.canStartCheckout;

  assert.strictEqual(typeof canStart, 'function', 'canStartCheckout must be exposed');

  // Missing or false can_start_checkout fails closed
  assert.strictEqual(canStart(null), false);
  assert.strictEqual(canStart({ status: 'in_service' }), false);
  assert.strictEqual(canStart({ status: 'in_service', can_start_checkout: false }), false);

  // Lifecycle gating: only in_service and completed can start checkout
  assert.strictEqual(canStart({ status: 'in_service', can_start_checkout: true }), true);
  assert.strictEqual(canStart({ status: 'completed', can_start_checkout: true }), true);
  assert.strictEqual(canStart({ status: 'pending', can_start_checkout: true }), false);
  assert.strictEqual(canStart({ status: 'confirmed', can_start_checkout: true }), false);
  assert.strictEqual(canStart({ status: 'arrived', can_start_checkout: true }), false);
  assert.strictEqual(canStart({ status: 'cancelled', can_start_checkout: true }), false);
  assert.strictEqual(canStart({ status: 'no_show', can_start_checkout: true }), false);

  // Inconsistent state blocks starting checkout
  assert.strictEqual(canStart({
    status: 'in_service',
    can_start_checkout: true,
    checkout: { payment_state: 'inconsistent' }
  }), false);
});

test('feature gate safety prevents unreleased production checkout invocation and shows notice', () => {
  const { context, alerts, requests } = createPageContext();

  assert.strictEqual(context.FEATURE_CHECKOUT_ENABLED, false, 'FEATURE_CHECKOUT_ENABLED must default to false');

  // Trigger checkout workflow when gated
  context.openCheckoutWorkflow(sampleAppointment.id);

  assert.strictEqual(alerts.length, 1, 'Expected 1 notice alert');
  assert.match(alerts[0], /收银功能目前处于安全灰度|特性门禁|尚未在生产环境开放/);
  assert.strictEqual(requests.length, 0, 'Must NOT trigger any network request when feature-gated');
});

test('when feature gate is enabled, checkout entry button is rendered without gate flag and makes no payment requests', () => {
  const { context, elements, requests } = createPageContext();
  context.FEATURE_CHECKOUT_ENABLED = true;

  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /data-feature-gated="false"/);

  // Triggering workflow performs 0 mutating requests
  context.openCheckoutWorkflow(sampleAppointment.id);
  assert.strictEqual(requests.length, 0, 'Zero POST/PATCH/DELETE calls');
});

test('multi-item items[] display respects sequence_no and shows primary/assistant staff', () => {
  const { context, elements } = createPageContext();

  const appointmentWithItems = {
    ...sampleAppointment,
    status: 'in_service',
    items: [
      {
        item_id: 'item-2',
        sequence_no: 2,
        service_name_snapshot: 'Gel Polish Removal',
        staff_assignments: [
          { role: 'primary', staff_name: 'Bob' }
        ]
      },
      {
        item_id: 'item-1',
        sequence_no: 1,
        service_name_snapshot: 'Signature Manicure',
        staff_assignments: [
          { role: 'primary', staff_name: 'Alice' },
          { role: 'assistant', staff_name: 'Carol' }
        ]
      }
    ]
  };

  context.renderAppointments([appointmentWithItems]);
  const rendered = elements.get('content').innerHTML;

  // Verify ordering: item 1 appears before item 2
  const pos1 = rendered.indexOf('Signature Manicure');
  const pos2 = rendered.indexOf('Gel Polish Removal');
  assert.ok(pos1 > 0 && pos2 > 0 && pos1 < pos2, 'Item 1 must appear before Item 2 based on sequence_no');

  // Verify staff roles in Chinese
  assert.match(rendered, /Alice \(主理\)/);
  assert.match(rendered, /Carol \(助理\)/);
  assert.match(rendered, /Bob \(主理\)/);

  // Verify notranslate
  assert.match(rendered, /class="service-item notranslate" translate="no"/);
  assert.match(rendered, /class="staff-item notranslate" translate="no"/);

  // Switch to English and check roles
  context.ownerSelfService._state.locale = 'en';
  context.renderAppointments([appointmentWithItems]);
  const renderedEn = elements.get('content').innerHTML;
  assert.match(renderedEn, /Alice \(Primary\)/);
  assert.match(renderedEn, /Carol \(Assistant\)/);
});

test('legacy fallback renders single service and staff when items[] is missing or empty', () => {
  const { context, elements } = createPageContext();

  context.renderAppointments([{
    ...sampleAppointment,
    service_name: 'Classic Pedicure',
    staff_name: 'Master Stylist',
    items: []
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /Classic Pedicure/);
  assert.match(rendered, /Master Stylist/);
  assert.doesNotMatch(rendered, /class="multi-service-list"/);
});

test('single-language mode enforces pure Chinese in zh-CN and pure English in en without bilingual slash concatenations', () => {
  const { context, elements } = createPageContext();

  // 1. Chinese Mode
  context.ownerSelfService._state.locale = 'zh-CN';
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true,
    checkout: {
      checkout_id: 'chk-1',
      checkout_status: 'draft',
      payment_state: 'unpaid',
      reconciliation_valid: true
    }
  }]);

  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, /<th>预约时间<\/th>/);
  assert.match(rendered, /<th>顾客姓名<\/th>/);
  assert.match(rendered, /<th>状态<\/th>/);
  assert.match(rendered, /<th>操作<\/th>/);
  assert.match(rendered, />完成<\/button>/);
  assert.match(rendered, />去结账<\/button>/);
  assert.match(rendered, />草稿单<\/span>/);

  // Strictly no bilingual concatenations in Chinese mode
  assert.doesNotMatch(rendered, /去结账 \/ Checkout/);
  assert.doesNotMatch(rendered, /待结账 \/ Awaiting Checkout/);
  assert.doesNotMatch(rendered, /已结账 \/ Paid/);

  // 2. English Mode
  context.ownerSelfService._state.locale = 'en';
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true,
    checkout: {
      checkout_id: 'chk-1',
      checkout_status: 'draft',
      payment_state: 'unpaid',
      reconciliation_valid: true
    }
  }]);

  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /<th>Appointment Time<\/th>/);
  assert.match(rendered, /<th>Customer<\/th>/);
  assert.match(rendered, /<th>Status<\/th>/);
  assert.match(rendered, /<th>Actions<\/th>/);
  assert.match(rendered, />Complete<\/button>/);
  assert.match(rendered, />Checkout<\/button>/);
  assert.match(rendered, />Draft<\/span>/);

  // Strictly no Chinese characters in table UI headers or buttons
  const headersAndButtons = rendered.match(/<th>([^<]+)<\/th>|<button[^>]*>([^<]+)<\/button>/g) || [];
  for (const fragment of headersAndButtons) {
    assert.doesNotMatch(fragment, /[\u4e00-\u9fa5]/, `English UI must contain no Chinese: ${fragment}`);
  }
});

test('instant language switching via setAdminLocale switches UI without page reload', () => {
  const { context, elements } = createPageContext();

  context.currentAppointments = [{
    ...sampleAppointment,
    status: 'in_service',
    can_start_checkout: true
  }];

  // Initial state is zh-CN
  context.setAdminLocale('zh-CN');
  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, /<th>预约时间<\/th>/);
  assert.match(rendered, />去结账<\/button>/);

  // Switch to en
  context.setAdminLocale('en');
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /<th>Appointment Time<\/th>/);
  assert.match(rendered, />Checkout<\/button>/);

  // Switch back to zh-CN
  context.setAdminLocale('zh-CN');
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /<th>预约时间<\/th>/);
  assert.match(rendered, />去结账<\/button>/);
});

test('shared i18n dictionary has complete single-language keys for checkout and workflow UX', () => {
  const requiredKeys = [
    'goToCheckout',
    'awaitingCheckout',
    'paid',
    'checkoutStateDraft',
    'checkoutStateUnpaid',
    'checkoutStatePartiallyPaid',
    'checkoutStatePaid',
    'checkoutStatePartiallyRefunded',
    'checkoutStateRefunded',
    'checkoutStateVoid',
    'checkoutStateInconsistent',
    'primaryStaff',
    'assistantStaff',
    'startingPrice',
    'frontDeskWorkflow',
    'workflowFeaturePreview',
    'workflowAppointment',
    'workflowArrived',
    'workflowInService',
    'workflowCheckout',
    'workflowPaid',
    'checkoutDisabledNotice',
    'featureGatedNoticeTitle',
    'featureGatedNoticeDesc',
    'iUnderstand'
  ];

  for (const locale of ['zh-CN', 'en']) {
    for (const key of requiredKeys) {
      const translation = i18n.t(key, locale);
      assert.ok(translation && translation !== key, `Translation for ${key} in ${locale} must be defined`);
      // Single-language rule: no bilingual slashes in system buttons or badges
      if (['goToCheckout', 'paid', 'checkoutStatePaid', 'startingPrice'].includes(key)) {
        assert.doesNotMatch(translation, /\s\/\s/, `${key} in ${locale} must not contain bilingual slash`);
      }
    }
  }

  // Verify English specific translations
  assert.strictEqual(i18n.t('goToCheckout', 'en'), 'Checkout');
  assert.strictEqual(i18n.t('checkoutStateDraft', 'en'), 'Draft');
  assert.strictEqual(i18n.t('checkoutStatePartiallyPaid', 'en'), 'Partially Paid');
  assert.strictEqual(i18n.t('checkoutStatePaid', 'en'), 'Paid');
  assert.strictEqual(i18n.t('checkoutStatePartiallyRefunded', 'en'), 'Partially Refunded');
  assert.strictEqual(i18n.t('checkoutStateRefunded', 'en'), 'Refunded');
  assert.strictEqual(i18n.t('checkoutStateVoid', 'en'), 'Voided');
  assert.strictEqual(i18n.t('checkoutStateInconsistent', 'en'), 'Checkout Status Issue');
  assert.strictEqual(i18n.t('primaryStaff', 'en'), 'Primary');
  assert.strictEqual(i18n.t('assistantStaff', 'en'), 'Assistant');
  assert.strictEqual(i18n.t('startingPrice', 'en'), 'Starting Price');

  // Verify Chinese specific translations
  assert.strictEqual(i18n.t('goToCheckout', 'zh-CN'), '去结账');
  assert.strictEqual(i18n.t('checkoutStateDraft', 'zh-CN'), '草稿单');
  assert.strictEqual(i18n.t('checkoutStatePartiallyPaid', 'zh-CN'), '部分支付');
  assert.strictEqual(i18n.t('checkoutStatePaid', 'zh-CN'), '已结账');
  assert.strictEqual(i18n.t('checkoutStatePartiallyRefunded', 'zh-CN'), '部分退款');
  assert.strictEqual(i18n.t('checkoutStateRefunded', 'zh-CN'), '已退款');
  assert.strictEqual(i18n.t('checkoutStateVoid', 'zh-CN'), '已作废');
  assert.strictEqual(i18n.t('checkoutStateInconsistent', 'zh-CN'), '结账状态异常');
  assert.strictEqual(i18n.t('primaryStaff', 'zh-CN'), '主理');
  assert.strictEqual(i18n.t('assistantStaff', 'zh-CN'), '助理');
  assert.strictEqual(i18n.t('startingPrice', 'zh-CN'), '起价');
});

test('design tokens and accessible touch targets are properly configured for desktop and iPad', () => {
  // CSS tokens
  assert.match(html, /--status-checkout:\s*#7c3aed;/);
  assert.match(html, /--status-checkout-soft:\s*#ede9fe;/);
  assert.match(html, /--status-paid:\s*#059669;/);
  assert.match(html, /--status-paid-soft:\s*#d1fae5;/);
  assert.match(html, /--status-draft:\s*#b45309;/);
  assert.match(html, /--status-draft-soft:\s*#fef3c7;/);
  assert.match(html, /--status-partially-paid:\s*#0284c7;/);
  assert.match(html, /--status-partially-paid-soft:\s*#e0f2fe;/);
  assert.match(html, /--status-refunded:\s*#6b7280;/);
  assert.match(html, /--status-refunded-soft:\s*#f3f4f6;/);
  assert.match(html, /--status-void:\s*#4b5563;/);
  assert.match(html, /--status-void-soft:\s*#e5e7eb;/);
  assert.match(html, /--status-inconsistent:\s*#dc2626;/);
  assert.match(html, /--status-inconsistent-soft:\s*#fee2e2;/);

  // Focus visible accessibility
  assert.match(html, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);

  // iPad / tablet touch target minimum (min-height: 44px)
  assert.match(html, /@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\.checkout-btn\s*\{[^}]*min-height:\s*44px;/);
});
