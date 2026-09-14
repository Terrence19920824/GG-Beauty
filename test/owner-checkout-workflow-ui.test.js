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
  status: 'pending'
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
    'todayCount'
  ]) {
    elements.set(id, {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: id === 'adminContent',
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
    ownerSelfService: { _state: { locale: 'zh-CN' }, setProfile() {}, reset() {} },
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

  // Stepper arrows for progression
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
  // Appointment is completed, but has no explicit checkout/payment state
  context.renderAppointments([{ ...sampleAppointment, status: 'completed' }]);
  const rendered = elements.get('content').innerHTML;

  // Appointment status displays "已完成"
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

  // Explicit checkout_status === 'paid'
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    checkout_status: 'paid'
  }]);
  let rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.match(rendered, /已结账/);

  // Case-insensitivity & alternative canonical field payment_status
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'completed',
    payment_status: 'PAID'
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
});

test('in_service displays checkout entry button, and awaiting checkout pill only appears from explicit checkout state', () => {
  const { context, elements } = createPageContext();

  // in_service without explicit checkout session: has entry button, but does NOT assert awaiting-checkout financial pill
  context.renderAppointments([{ ...sampleAppointment, status: 'in_service' }]);
  let rendered = elements.get('content').innerHTML;

  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /openCheckoutWorkflow\('00000000-0000-4000-8000-000000000001'\)/);
  assert.match(rendered, /data-feature-gated="true"/);
  assert.doesNotMatch(rendered, /class="pill status-awaiting-checkout notranslate"/, 'Must not assume awaiting-checkout without explicit session');

  // in_service with explicit checkout_status === 'awaiting_checkout': displays badge
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    checkout_status: 'awaiting_checkout'
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-awaiting-checkout notranslate"/);
  assert.match(rendered, /class="checkout-btn"/);

  // in_service with explicit checkout_status === 'paid': displays paid pill and omits duplicate checkout button
  context.renderAppointments([{
    ...sampleAppointment,
    status: 'in_service',
    checkout_status: 'paid'
  }]);
  rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.doesNotMatch(rendered, /class="checkout-btn"/, 'Already paid appointments should not show checkout button');
});

test('cancelled, no_show, and pending appointments strictly cannot show checkout financial badges even if inconsistent data is passed', () => {
  const { context, elements } = createPageContext();

  for (const unauthorizedStatus of ['pending', 'cancelled', 'no_show']) {
    // Pass conflicting/corrupted checkout status
    context.renderAppointments([{
      ...sampleAppointment,
      status: unauthorizedStatus,
      checkout_status: 'paid'
    }]);
    const rendered = elements.get('content').innerHTML;

    assert.doesNotMatch(rendered, /status-paid/, `${unauthorizedStatus} must never show paid pill`);
    assert.doesNotMatch(rendered, /status-awaiting-checkout/, `${unauthorizedStatus} must never show awaiting checkout pill`);
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
  assert.strictEqual(resolve({ status: 'completed', checkout_status: '' }), null);
  assert.strictEqual(resolve({ status: 'completed', checkout_status: 'none' }), null);

  // Explicit paid states
  assert.strictEqual(resolve({ status: 'completed', checkout_status: 'paid' }), 'paid');
  assert.strictEqual(resolve({ status: 'completed', checkoutStatus: 'PAID' }), 'paid');
  assert.strictEqual(resolve({ status: 'completed', payment_status: 'paid' }), 'paid');
  assert.strictEqual(resolve({ status: 'in_service', checkout_status: 'paid' }), 'paid');

  // Explicit awaiting checkout states
  assert.strictEqual(resolve({ status: 'in_service', checkout_status: 'awaiting_checkout' }), 'awaiting_checkout');
  assert.strictEqual(resolve({ status: 'in_service', checkout_status: 'draft' }), 'awaiting_checkout');
  assert.strictEqual(resolve({ status: 'completed', checkout_status: 'awaiting_checkout' }), 'awaiting_checkout');

  // in_service without explicit state fails closed
  assert.strictEqual(resolve({ status: 'in_service' }), null);

  // Unauthorized appointment statuses fail closed even if paid
  assert.strictEqual(resolve({ status: 'pending', checkout_status: 'paid' }), null);
  assert.strictEqual(resolve({ status: 'cancelled', checkout_status: 'paid' }), null);
  assert.strictEqual(resolve({ status: 'no_show', checkout_status: 'paid' }), null);
  assert.strictEqual(resolve(null), null);
  assert.strictEqual(resolve(undefined), null);
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

test('shared i18n dictionary has complete bilingual keys for checkout and workflow UX', () => {
  const requiredKeys = [
    'goToCheckout',
    'awaitingCheckout',
    'paid',
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
    }
  }

  // Verify English specific translations
  assert.strictEqual(i18n.t('goToCheckout', 'en'), 'Checkout');
  assert.strictEqual(i18n.t('awaitingCheckout', 'en'), 'Awaiting Checkout');
  assert.strictEqual(i18n.t('paid', 'en'), 'Paid');
  assert.strictEqual(i18n.t('workflowAppointment', 'en'), 'Booked');
  assert.strictEqual(i18n.t('workflowArrived', 'en'), 'Arrived');
  assert.strictEqual(i18n.t('workflowInService', 'en'), 'In Service');
  assert.strictEqual(i18n.t('workflowCheckout', 'en'), 'Checkout');
  assert.strictEqual(i18n.t('workflowPaid', 'en'), 'Paid');

  // Verify Chinese specific translations
  assert.strictEqual(i18n.t('goToCheckout', 'zh-CN'), '去结账');
  assert.strictEqual(i18n.t('awaitingCheckout', 'zh-CN'), '待结账');
  assert.strictEqual(i18n.t('paid', 'zh-CN'), '已结账');
});

test('design tokens and accessible touch targets are properly configured for desktop and iPad', () => {
  // CSS tokens
  assert.match(html, /--status-checkout:\s*#7c3aed;/);
  assert.match(html, /--status-checkout-soft:\s*#ede9fe;/);
  assert.match(html, /--status-paid:\s*#059669;/);
  assert.match(html, /--status-paid-soft:\s*#d1fae5;/);

  // Focus visible accessibility
  assert.match(html, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);

  // iPad / tablet touch target minimum (min-height: 44px)
  assert.match(html, /@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\.checkout-btn\s*\{[^}]*min-height:\s*44px;/);
});
