'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'public/admin-self-service.js'), 'utf8');

const response = (status, data = {}) => ({ status, ok: status >= 200 && status < 300, async json() { return data; } });

function element() {
  return {
    hidden: false, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', className: '',
    style: {}, dataset: {},
    classList: { toggle() {} }
  };
}

function page(replies = []) {
  const elements = new Map();
  const ids = [
    'addServiceButton', 'addStaffButton', 'servicesList', 'servicesMessage', 'serviceFormPanel', 'serviceFormTitle',
    'serviceName', 'serviceCategory', 'serviceDescription', 'servicePrice', 'serviceDuration', 'serviceSortOrder',
    'serviceBookable', 'serviceActive', 'saveServiceButton', 'staffList', 'staffMessage', 'staffDetail', 'staffSettings',
    'staffName', 'staffCode', 'staffPhone', 'staffEmail', 'staffBookable', 'staffActive', 'staffSaveStatus', 'saveStaffButton',
    'staffTabContent', 'capabilityStatus', 'saveCapabilityButton', 'locationStatus', 'saveLocationsButton',
    'scheduleStatus', 'saveScheduleButton', 'overrideLocation', 'overrideDate', 'overrideType', 'overrideStart', 'overrideEnd',
    'overrideReason', 'overrideStartField', 'overrideEndField', 'overrideStatus', 'saveOverrideButton',
    'calendarView', 'staffView', 'servicesView', 'nav-calendar', 'nav-staff', 'nav-services'
  ];
  for (let day = 1; day <= 7; day += 1) ids.push(`scheduleWorking${day}`, `scheduleStart${day}`, `scheduleEnd${day}`);
  ids.forEach(id => elements.set(id, element()));
  const requests = [];
  const context = {
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    fetch: async (url, options = {}) => { requests.push({ url, options }); const next = replies.shift(); if (!next) throw new Error(`Unexpected request: ${url}`); return next; },
    showLogin(message) { context.loginMessage = message; },
    loadAppointments: async () => {},
    console,
    encodeURIComponent,
    Set,
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { api: context.ownerSelfService, elements, requests, context };
}

const owner = { membership: { role: 'owner' } };
const manager = { membership: { role: 'manager' } };
const admin = { membership: { role: 'admin' } };

test('navigation exposes calendar, staff and services with later modules disabled', () => {
  assert.match(html, /id="nav-calendar"[^>]*>日历/);
  assert.match(html, /id="nav-staff"[^>]*>员工/);
  assert.match(html, /id="nav-services"[^>]*>服务/);
  assert.match(html, /disabled title="即将推出">顾客/);
});

test('service list loads safe management fields and has no delete action', async () => {
  const p = page([response(200, { success: true, data: [{ id: 's1', name: '剪发', category: '头发', price: '28', duration_minutes: 45, bookable: true, is_active: true }] })]);
  p.api.setProfile(owner);
  await p.api.loadServices();
  assert.equal(p.requests[0].url, '/api/owner/services');
  assert.match(p.elements.get('servicesList').innerHTML, /剪发/);
  assert.doesNotMatch(p.elements.get('servicesList').innerHTML, /DELETE|删除/);
});

test('owner creates service with business fields only', async () => {
  const p = page([response(201, { success: true, data: { id: 's1' } }), response(200, { success: true, data: [] })]);
  p.api.setProfile(owner); p.api.openServiceForm();
  Object.assign(p.elements.get('serviceName'), { value: '剪发' });
  Object.assign(p.elements.get('serviceCategory'), { value: '头发' });
  Object.assign(p.elements.get('servicePrice'), { value: '28' });
  Object.assign(p.elements.get('serviceDuration'), { value: '45' });
  Object.assign(p.elements.get('serviceSortOrder'), { value: '1' });
  await p.api.saveService();
  const body = JSON.parse(p.requests[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['bookable', 'category', 'description', 'durationMinutes', 'isActive', 'name', 'price', 'sortOrder'].sort());
  assert.equal(p.requests[0].options.method, 'POST');
});

test('service edit and toggles use PATCH', async () => {
  const p = page([response(200, { success: true, data: [{ id: 's1', name: '剪发', price: 20, duration_minutes: 30, bookable: true, is_active: true }] }), response(200, { success: true, data: {} }), response(200, { success: true, data: [] })]);
  p.api.setProfile(manager); await p.api.loadServices(); p.api.openServiceForm('s1');
  p.elements.get('serviceBookable').checked = false;
  await p.api.saveService();
  assert.equal(p.requests[1].url, '/api/owner/services/s1');
  assert.equal(p.requests[1].options.method, 'PATCH');
  assert.equal(JSON.parse(p.requests[1].options.body).bookable, false);
});

test('staff list loads and renders staff without delete', async () => {
  const p = page([response(200, { success: true, data: [{ id: 'u1', name: 'Amy', staff_code: 'A01', bookable: false, is_active: true, locations: [{ name: 'Main' }] }] })]);
  p.api.setProfile(owner); await p.api.loadStaff();
  assert.match(p.elements.get('staffList').innerHTML, /Amy/);
  assert.doesNotMatch(p.elements.get('staffList').innerHTML, /DELETE|删除/);
});

test('new staff is always submitted with bookable false', async () => {
  const p = page([response(201, { success: true, data: { id: 'u1' } }), response(200, { success: true, data: [] })]);
  p.api.setProfile(owner); p.api.openStaffForm();
  p.elements.get('staffName').value = 'Amy'; p.elements.get('staffBookable').checked = true;
  await p.api.saveStaff(true);
  assert.equal(JSON.parse(p.requests[0].options.body).bookable, false);
  assert.equal(p.requests[0].url, '/api/owner/staff');
});

test('staff edit uses PATCH and supports active/bookable fields', async () => {
  const p = page([response(200, { success: true, data: { id: 'u1' } }), response(200, { success: true, data: [] })]);
  p.api.setProfile(manager); p.api._state.selectedStaffId = 'u1';
  p.elements.get('staffName').value = 'Amy'; p.elements.get('staffBookable').checked = true; p.elements.get('staffActive').checked = true;
  await p.api.saveStaff(false);
  assert.equal(p.requests[0].options.method, 'PATCH');
  assert.equal(JSON.parse(p.requests[0].options.body).bookable, true);
});

test('capability checkboxes load and save only serviceIds', async () => {
  const p = page([
    response(200, { success: true, data: [{ service_id: 's1', name: '剪发', is_active: true, assigned: true }] }),
    response(200, { success: true, data: [] }), response(200, { success: true, data: [] }),
    response(200, { success: true })
  ]);
  p.api.setProfile(owner); p.api._state.staff = [{ id: 'u1', name: 'Amy', is_active: true }];
  await p.api.selectStaff('u1'); await p.api.saveCapability();
  assert.deepEqual(JSON.parse(p.requests[3].options.body), { serviceIds: ['s1'] });
});

test('inactive unassigned service is disabled while existing assignment remains visible', async () => {
  const p = page([response(200, { success: true, data: [{ service_id: 's1', name: 'Old', is_active: false, assigned: false }, { service_id: 's2', name: 'Used', is_active: false, assigned: true }] }), response(200, { success: true, data: [] }), response(200, { success: true, data: [] })]);
  p.api.setProfile(owner); p.api._state.staff = [{ id: 'u1', name: 'Amy' }]; await p.api.selectStaff('u1');
  p.api.openStaffTab('capability');
  const rendered = p.elements.get('staffTabContent').innerHTML;
  assert.match(rendered, /Old[\s\S]*项目已停用/);
  assert.match(rendered, /Used[\s\S]*项目已停用/);
});

test('location assignment loads and saves locationIds only', async () => {
  const p = page([response(200, { success: true }), response(200, { success: true, data: [] }), response(200, { success: true, data: [] }), response(200, { success: true, data: [] })]);
  p.api.setProfile(owner); p.api._state.selectedStaffId = 'u1'; p.api.toggleLocation('l1', true);
  await p.api.saveLocations();
  assert.deepEqual(JSON.parse(p.requests[0].options.body), { locationIds: ['l1'] });
});

test('weekly schedule validates time before mutation', async () => {
  const p = page([]); p.api.setProfile(owner); p.api._state.selectedStaffId = 'u1'; p.api._state.selectedLocationId = 'l1';
  p.elements.get('scheduleWorking1').checked = true; p.elements.get('scheduleStart1').value = '19:00'; p.elements.get('scheduleEnd1').value = '10:00';
  await p.api.saveSchedule();
  assert.equal(p.requests.length, 0);
  assert.match(p.elements.get('scheduleStatus').textContent, /不支持跨夜/);
});

test('weekly schedule saves ISO weekdays and current location', async () => {
  const p = page([response(200, { success: true })]); p.api.setProfile(owner); p.api._state.selectedStaffId = 'u1'; p.api._state.selectedLocationId = 'l1';
  p.elements.get('scheduleWorking1').checked = true; p.elements.get('scheduleStart1').value = '10:00'; p.elements.get('scheduleEnd1').value = '19:00';
  await p.api.saveSchedule();
  const body = JSON.parse(p.requests[0].options.body);
  assert.equal(body.locationId, 'l1'); assert.deepEqual(body.days[0], { dayOfWeek: 1, isWorking: true, startTime: '10:00', endTime: '19:00' });
});

test('override UI supports day off, leave and custom hours labels', () => {
  assert.match(source, /休息一天/); assert.match(source, /请假/); assert.match(source, /特殊营业时间/);
  assert.match(source, /day_off/); assert.match(source, /leave/); assert.match(source, /custom_hours/);
});

test('override create and deactivate use POST and PATCH', async () => {
  const p = page([response(201, { success: true }), response(200, { success: true, data: [] }), response(200, { success: true }), response(200, { success: true, data: [] })]);
  p.api.setProfile(owner); p.api._state.selectedStaffId = 'u1';
  p.elements.get('overrideLocation').value = 'l1'; p.elements.get('overrideDate').value = '2026-09-10'; p.elements.get('overrideType').value = 'day_off';
  await p.api.saveOverride(); await p.api.deactivateOverride('o1');
  assert.equal(p.requests[0].options.method, 'POST'); assert.equal(p.requests[2].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(p.requests[2].options.body), { isActive: false });
});

test('known 409 codes have safe business messages', async () => {
  const p = page([response(409, { success: false, code: 'STAFF_SERVICE_HAS_FUTURE_APPOINTMENTS' })]);
  p.api.setProfile(owner); p.api._state.selectedStaffId = 'u1';
  await p.api.saveCapability();
  assert.match(p.elements.get('capabilityStatus').textContent, /未来预约使用这个项目/);
  assert.match(source, /该员工已有未来预约，暂时不能停用/);
  assert.match(source, /新排班与该员工未来预约冲突/);
});

test('401 expires session through the existing login UI', async () => {
  const p = page([response(401, { success: false, message: '请登录' })]); p.api.setProfile(owner);
  await p.api.loadServices();
  assert.equal(p.context.loginMessage, '请登录');
});

test('admin receives read-only UI while owner and manager can write', () => {
  const p = page(); p.api.setProfile(admin);
  assert.equal(p.elements.get('addServiceButton').hidden, true); assert.equal(p.elements.get('addStaffButton').hidden, true);
  p.api.setProfile(owner); assert.equal(p.elements.get('addServiceButton').hidden, false);
  p.api.setProfile(manager); assert.equal(p.elements.get('addStaffButton').hidden, false);
});

test('frontend never sends client tenant identity or stores auth tokens', () => {
  assert.doesNotMatch(source, /\bshopId\b|\bshop_id\b|\btenantId\b/);
  assert.doesNotMatch(source + html, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /document\.cookie/);
});

test('self-service UI provides no hard-delete action or endpoint', () => {
  assert.doesNotMatch(source + html, /method:\s*['"]DELETE['"]|删除服务|删除员工/);
});

test('save buttons use busy state to prevent duplicate mutation', () => {
  assert.match(source, /button\.disabled = busy/);
  assert.match(source, /保存中\.\.\./);
  assert.match(source, /finally \{ setBusy/);
});

test('responsive rules provide two-column iPad layout and single-column mobile fallback', () => {
  assert.match(html, /grid-template-columns: minmax\(280px, 0\.8fr\) minmax\(420px, 1\.4fr\)/);
  assert.match(html, /@media \(max-width: 800px\)[\s\S]*\.management-grid,[\s\S]*grid-template-columns: 1fr/);
});
