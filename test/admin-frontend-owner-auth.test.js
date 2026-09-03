'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'public', 'admin.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, 'admin inline script must exist');

const response = (status, payload) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return payload; }
});

const appointment = {
  id: '77777777-7777-4777-8777-777777777777',
  start_at: '2030-01-01T02:00:00Z',
  customer_name: 'Customer A',
  customer_phone: '00000000',
  service_name: 'Service A',
  staff_name: 'Staff A',
  status: 'pending'
};

const createPage = replies => {
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
      style: { display: id === 'loginOverlay' ? 'flex' : '' }
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
    confirm: () => true,
    alert: message => alerts.push(message),
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const next = replies.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      return next;
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

  return {
    context,
    elements,
    requests,
    alerts,
    initialize: () => initialize()
  };
};

test('page initialization shows login UI when owner/me returns 401', async () => {
  const page = createPage([response(401, { success: false })]);
  await page.initialize();
  assert.equal(page.requests[0].url, '/api/owner/me');
  assert.equal(page.elements.get('loginOverlay').style.display, 'flex');
  assert.equal(page.elements.get('adminContent').hidden, true);
});

test('authenticated owner/me shows admin UI and loads appointments', async () => {
  const page = createPage([
    response(200, { success: true, data: {} }),
    response(200, { success: true, data: [appointment] })
  ]);
  await page.initialize();
  assert.deepEqual(page.requests.map(item => item.url), [
    '/api/owner/me',
    '/api/appointments-db'
  ]);
  assert.equal(page.elements.get('loginOverlay').style.display, 'none');
  assert.equal(page.elements.get('adminContent').hidden, false);
});

test('owner login sends required fields then loads appointments', async () => {
  const page = createPage([
    response(200, { success: true }),
    response(200, { success: true, data: [appointment] })
  ]);
  page.elements.get('ownerLoginIdentifier').value = 'OwnerOne';
  page.elements.get('adminPassword').value = 'entered-password';
  page.elements.get('ownerShopSlug').value = 'shop-one';
  await page.context.adminLogin();
  assert.deepEqual(page.requests.map(item => item.url), [
    '/api/owner/login',
    '/api/appointments-db'
  ]);
  assert.deepEqual(JSON.parse(page.requests[0].options.body), {
    loginIdentifier: 'OwnerOne',
    password: 'entered-password',
    shopSlug: 'shop-one'
  });
  assert.equal(page.requests[0].options.credentials, 'same-origin');
});

test('invalid owner login never falls back to legacy admin auth', async () => {
  const page = createPage([
    response(401, { success: false, message: '账号或密码错误' })
  ]);
  page.elements.get('ownerLoginIdentifier').value = 'OwnerOne';
  page.elements.get('adminPassword').value = 'wrong-password';
  await page.context.adminLogin();
  assert.deepEqual(page.requests.map(item => item.url), ['/api/owner/login']);
  assert.equal(page.elements.get('loginOverlay').style.display, 'flex');
});

test('logout uses owner endpoint and clears protected UI', async () => {
  const page = createPage([response(200, { success: true })]);
  page.elements.get('adminContent').hidden = false;
  page.elements.get('content').innerHTML = 'private appointment';
  await page.context.ownerLogout();
  assert.equal(page.requests[0].url, '/api/owner/logout');
  assert.equal(page.requests[0].options.credentials, 'same-origin');
  assert.equal(page.elements.get('adminContent').hidden, true);
  assert.equal(page.elements.get('content').textContent, '请先登录后查看预约');
});

test('appointment read sends no client tenant identity', async () => {
  const page = createPage([
    response(200, { success: true, data: [appointment] })
  ]);
  await page.context.loadAppointments();
  const request = page.requests[0];
  assert.equal(request.url, '/api/appointments-db');
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.credentials, 'same-origin');
});

test('status mutation sends only appointmentId and status', async () => {
  const page = createPage([
    response(200, { success: true }),
    response(200, { success: true, data: [appointment] })
  ]);
  await page.context.updateAppointmentStatus(appointment.id, 'confirmed');
  const body = JSON.parse(page.requests[0].options.body);
  assert.deepEqual(body, {
    appointmentId: appointment.id,
    status: 'confirmed'
  });
  assert.equal(page.requests[0].options.credentials, 'same-origin');
  assert.equal('shopId' in body, false);
  assert.equal('role' in body, false);
  assert.equal('membershipId' in body, false);
});

for (const operation of ['appointments', 'mutation']) {
  test(`${operation} 401 hides and clears protected UI`, async () => {
    const page = createPage([
      response(401, { success: false, message: '请重新登录' })
    ]);
    page.elements.get('adminContent').hidden = false;
    page.elements.get('content').innerHTML = 'private appointment';
    if (operation === 'appointments') {
      await page.context.loadAppointments();
    } else {
      await page.context.updateAppointmentStatus(appointment.id, 'confirmed');
    }
    assert.equal(page.elements.get('adminContent').hidden, true);
    assert.equal(page.elements.get('loginOverlay').style.display, 'flex');
    assert.equal(page.elements.get('content').textContent, '请先登录后查看预约');
  });
}

test('mutation 409 displays only the safe API business message', async () => {
  const page = createPage([
    response(409, { success: false, message: '不允许进行该预约状态变更' })
  ]);
  await page.context.updateAppointmentStatus(appointment.id, 'completed');
  assert.deepEqual(page.alerts, ['不允许进行该预约状态变更']);
});

test('rendering and status action buttons remain available', () => {
  const page = createPage([]);
  page.context.renderAppointments([appointment]);
  const rendered = page.elements.get('content').innerHTML;
  assert.match(rendered, /Customer A/);
  assert.match(rendered, /updateAppointmentStatus\('[^']+', 'confirmed'\)/);
  assert.match(rendered, /updateAppointmentStatus\('[^']+', 'completed'\)/);
  assert.match(rendered, /updateAppointmentStatus\('[^']+', 'cancelled'\)/);
});

test('admin frontend has no legacy auth fallback or browser auth storage', () => {
  assert.doesNotMatch(html, /\/api\/admin\/(login|logout)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.doesNotMatch(html, /sessionToken|tokenHash|document\.cookie/);
  assert.match(html, /\/api\/owner\/login/);
  assert.match(html, /\/api\/owner\/me/);
  assert.match(html, /\/api\/owner\/logout/);
});
