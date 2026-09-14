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
  // Must be outside <div id="content"> to avoid mutating content.innerHTML assertions
  const contentDivIndex = html.indexOf('<div id="content"');
  const workflowBarIndex = html.indexOf('class="frontdesk-workflow-bar"');
  assert.ok(workflowBarIndex > 0, 'workflow bar must exist');
  assert.ok(contentDivIndex > workflowBarIndex, 'workflow bar must be placed above #content');
});

test('renderAppointments displays awaiting checkout pill and checkout button on in_service status', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{ ...sampleAppointment, status: 'in_service' }]);
  const rendered = elements.get('content').innerHTML;

  assert.match(rendered, /class="pill status-awaiting-checkout notranslate"/);
  assert.match(rendered, /class="checkout-btn"/);
  assert.match(rendered, /openCheckoutWorkflow\('00000000-0000-4000-8000-000000000001'\)/);
  assert.match(rendered, /data-feature-gated="true"/);
});

test('renderAppointments displays paid pill on completed status and omits checkout action', () => {
  const { context, elements } = createPageContext();
  context.renderAppointments([{ ...sampleAppointment, status: 'completed' }]);
  const rendered = elements.get('content').innerHTML;

  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.doesNotMatch(rendered, /class="checkout-btn"/);
  assert.doesNotMatch(rendered, /openCheckoutWorkflow/);
});

test('renderAppointments strictly disallows checkout actions on unauthorized statuses', () => {
  const { context, elements } = createPageContext();

  for (const unauthorizedStatus of ['pending', 'cancelled', 'no_show']) {
    context.renderAppointments([{ ...sampleAppointment, status: unauthorizedStatus }]);
    const rendered = elements.get('content').innerHTML;

    assert.doesNotMatch(rendered, /class="checkout-btn"/, `${unauthorizedStatus} must not have checkout button`);
    assert.doesNotMatch(rendered, /status-awaiting-checkout/, `${unauthorizedStatus} must not show awaiting checkout badge`);
    assert.doesNotMatch(rendered, /openCheckoutWorkflow/, `${unauthorizedStatus} must not reference openCheckoutWorkflow`);
  }
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
