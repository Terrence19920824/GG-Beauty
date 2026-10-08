'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { app } = require('../server');
const i18n = require('../public/shared-i18n');

const SESSION = {
  owner_account_id: '11111111-1111-4111-8111-111111111111',
  membership_id: '22222222-2222-4222-8222-222222222222',
  shop_id: '33333333-3333-4333-8333-333333333333',
  login_identifier: 'owner',
  display_name: 'Owner',
  role: 'owner',
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
};

const setupAuthMock = () => {
  app.locals.ownerAuthPool = {
    async query(sql) {
      if (/FROM owner_sessions/.test(sql)) {
        return { rows: [SESSION] };
      }
      throw new Error(`Unexpected auth query: ${sql}`);
    }
  };
};

// -------------------------------------------------------------
// Server tests for GET /api/owner/runtime-config
// -------------------------------------------------------------

test('1. FEATURE_CHECKOUT_ENABLED=true returns checkoutEnabled=true with no-store headers', async () => {
  const original = process.env.FEATURE_CHECKOUT_ENABLED;
  try {
    process.env.FEATURE_CHECKOUT_ENABLED = 'true';
    setupAuthMock();

    await withServer(async base => {
      const response = await fetch(`${base}/api/owner/runtime-config`, {
        headers: { cookie: 'gg_beauty_owner_session=valid-token' }
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control') || '', /no-store/i);
      const data = await response.json();
      assert.equal(data.success, true);
      assert.equal(data.featureFlags.checkoutEnabled, true);
    });
  } finally {
    if (original === undefined) delete process.env.FEATURE_CHECKOUT_ENABLED;
    else process.env.FEATURE_CHECKOUT_ENABLED = original;
  }
});

test('2. false, unset, or non-true values return checkoutEnabled=false', async () => {
  const original = process.env.FEATURE_CHECKOUT_ENABLED;
  try {
    setupAuthMock();
    for (const val of [undefined, 'false', '', 'TRUE', '1', 'yes', '0']) {
      if (val === undefined) delete process.env.FEATURE_CHECKOUT_ENABLED;
      else process.env.FEATURE_CHECKOUT_ENABLED = val;

      await withServer(async base => {
        const response = await fetch(`${base}/api/owner/runtime-config`, {
          headers: { cookie: 'gg_beauty_owner_session=valid-token' }
        });

        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.success, true);
        assert.equal(data.featureFlags.checkoutEnabled, false, `Value ${val} must return false`);
      });
    }
  } finally {
    if (original === undefined) delete process.env.FEATURE_CHECKOUT_ENABLED;
    else process.env.FEATURE_CHECKOUT_ENABLED = original;
  }
});

test('3. unauthenticated requests to runtime-config fail closed with 401', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/owner/runtime-config`);
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.success, false);
    assert.ok(data.message || data.code);
  });
});

// -------------------------------------------------------------
// Frontend admin.html tests for fetchRuntimeConfig()
// -------------------------------------------------------------

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');

function createMockElement(id = '', tag = 'div') {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    id,
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    hidden: false,
    disabled: false,
    type: tag === 'button' ? 'button' : undefined,
    _textContent: '',
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = String(v ?? ''); },
    classList: {
      add: (...cls) => cls.forEach(c => classes.add(c)),
      remove: (...cls) => cls.forEach(c => classes.delete(c)),
      contains: cls => classes.has(cls)
    },
    getAttribute: n => (attributes.has(n) ? attributes.get(n) : (n === 'class' ? Array.from(classes).join(' ') : null)),
    setAttribute: (n, v) => {
      attributes.set(n, String(v));
      if (n === 'class') {
        classes.clear();
        String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      }
    },
    removeAttribute: n => {
      attributes.delete(n);
      if (n === 'class') classes.clear();
    },
    appendChild(c) {
      if (!c) return c;
      this.children.push(c);
      c.parentElement = this;
      return c;
    },
    append(...nodes) {
      nodes.forEach(node => this.appendChild(typeof node === 'string' ? { textContent: node, children: [] } : node));
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
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    }
  };
  return element;
}

function createFrontendContext({ runtimeConfigResponse, shouldFetchFail = false } = {}) {
  const requests = [];
  const elements = new Map();
  const documentBody = createMockElement('', 'body');

  for (const id of [
    'appointmentDrawer', 'drawerBackdrop', 'drawerTitle', 'drawerCloseBtn', 'drawerStatusBadge',
    'drawerBody', 'drawerFooter', 'adminToastContainer', 'mainScheduleBody', 'locationFilter'
  ]) {
    const el = createMockElement(id, id === 'drawerFooter' ? 'footer' : 'div');
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
    currentAdminRole: 'owner',
    currentAdminShopId: '11111111-1111-4111-8111-111111111111',
    currentAdminMembershipId: '22222222-2222-4222-8222-222222222222',
    currentAdminLocale: 'zh-CN',
    ggI18n: i18n,
    ownerSelfService: { _state: { locale: 'zh-CN' } },
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      if (url === '/api/owner/runtime-config') {
        if (shouldFetchFail) {
          throw new Error('Network failure');
        }
        return {
          status: runtimeConfigResponse ? runtimeConfigResponse.status || 200 : 200,
          ok: runtimeConfigResponse ? (runtimeConfigResponse.status || 200) === 200 : true,
          async json() {
            return runtimeConfigResponse ? runtimeConfigResponse.body : { success: true, featureFlags: { checkoutEnabled: false } };
          }
        };
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
      createElement(tag) { return createMockElement('', tag); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    }
  };
  context.globalThis = context;
  context.window = context;

  const scriptMatch = adminHtml.match(/<script(?:\s+type="application\/javascript")?>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    vm.runInNewContext(scriptMatch[1], context, { filename: 'public/admin.html' });
  }

  return { context, requests, elements };
}

function findDescendant(node, pred) {
  if (!node || !node.children) return null;
  for (const child of node.children) {
    if (pred(child)) return child;
    const found = findDescendant(child, pred);
    if (found) return found;
  }
  return null;
}

test('4. frontend successfully reads runtime-config and enables Pay Bill when appointment can_start_checkout', async () => {
  const { context, requests, elements } = createFrontendContext({
    runtimeConfigResponse: {
      status: 200,
      body: { success: true, featureFlags: { checkoutEnabled: true } }
    }
  });

  // Verify initial state before fetch
  assert.equal(context.FEATURE_CHECKOUT_ENABLED, false);

  // Fetch runtime config
  const enabled = await context.fetchRuntimeConfig();
  assert.equal(enabled, true);
  assert.equal(context.FEATURE_CHECKOUT_ENABLED, true);

  const req = requests.find(r => r.url === '/api/owner/runtime-config');
  assert.ok(req);
  assert.equal(req.opts.cache, 'no-store');

  // Render appointment drawer with an eligible appointment
  const appt = {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'completed',
    can_start_checkout: true,
    currency_code: 'SGD',
    items: [
      { sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 8800 }
    ],
    checkout: null
  };

  context.renderAppointmentDrawer(appt);

  const drawerBody = elements.get('drawerBody');
  const payBillBtn = findDescendant(drawerBody, el => el.id === 'drawerPayBillBtn' || el.classList?.contains('drawer-pay-bill-btn'));
  assert.ok(payBillBtn, 'Pay Bill button must exist');
  assert.equal(payBillBtn.disabled, false, 'Pay Bill button must be enabled');
  assert.equal(payBillBtn.getAttribute('aria-disabled'), null);
});

test('5. frontend fails closed when runtime-config read fails or returns error', async () => {
  const appt = {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'completed',
    can_start_checkout: true,
    currency_code: 'SGD',
    items: [
      { sequence_no: 1, service_name_snapshot: 'Facial', price_snapshot_minor: 8800 }
    ],
    checkout: null
  };

  // Case A: Network error
  const { context: ctxA, elements: elA } = createFrontendContext({ shouldFetchFail: true });
  const resultA = await ctxA.fetchRuntimeConfig();
  assert.equal(resultA, false);
  assert.equal(ctxA.FEATURE_CHECKOUT_ENABLED, false);

  ctxA.renderAppointmentDrawer(appt);
  const drawerBodyA = elA.get('drawerBody');
  const btnA = findDescendant(drawerBodyA, el => el.id === 'drawerPayBillBtn' || el.classList?.contains('drawer-pay-bill-btn'));
  assert.ok(btnA);
  assert.equal(btnA.disabled, true, 'Pay Bill button must stay disabled on fetch failure');
  assert.equal(btnA.getAttribute('aria-disabled'), 'true');

  // Case B: Non-200 HTTP response
  const { context: ctxB, elements: elB } = createFrontendContext({
    runtimeConfigResponse: { status: 500, body: { success: false } }
  });
  const resultB = await ctxB.fetchRuntimeConfig();
  assert.equal(resultB, false);
  assert.equal(ctxB.FEATURE_CHECKOUT_ENABLED, false);

  ctxB.renderAppointmentDrawer(appt);
  const drawerBodyB = elB.get('drawerBody');
  const btnB = findDescendant(drawerBodyB, el => el.id === 'drawerPayBillBtn' || el.classList?.contains('drawer-pay-bill-btn'));
  assert.ok(btnB);
  assert.equal(btnB.disabled, true, 'Pay Bill button must stay disabled on 500 error');
  assert.equal(btnB.getAttribute('aria-disabled'), 'true');
});

test('6. feature flag wiring does not trigger any checkout POST requests', async () => {
  const { context, requests } = createFrontendContext({
    runtimeConfigResponse: {
      status: 200,
      body: { success: true, featureFlags: { checkoutEnabled: true } }
    }
  });

  await context.fetchRuntimeConfig();

  const checkoutPosts = requests.filter(r =>
    typeof r.url === 'string' &&
    r.url.includes('/checkout') &&
    r.opts.method === 'POST'
  );

  assert.equal(checkoutPosts.length, 0, 'No checkout POST must ever be triggered');
});
