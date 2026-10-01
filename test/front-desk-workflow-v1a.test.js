'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getOwnerFrontDeskCreationPolicy } = require('../lib/owner-front-desk-creation-policy');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'calendar-shared.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public', 'shared-i18n.js'), 'utf8');

test('future front-desk booking and walk-in have distinct sources and final states', () => {
  const handler = server.slice(
    server.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    server.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.deepEqual(getOwnerFrontDeskCreationPolicy(false), {
    bookingSource: 'owner_assisted',
    historySource: 'owner_assisted_booking',
    transitions: ['confirmed']
  });
  assert.deepEqual(getOwnerFrontDeskCreationPolicy(true), {
    bookingSource: 'walk_in',
    historySource: 'owner_walk_in',
    transitions: ['confirmed', 'arrived']
  });
  assert.match(handler, /getOwnerFrontDeskCreationPolicy\(walkIn\)/);
  assert.match(handler, /for \(const nextStatus of creationPolicy\.transitions\)/);
  assert.match(handler, /app\.post\('\/api\/owner\/assisted-appointments'[\s\S]*walkIn: false/);
  assert.match(handler, /app\.post\('\/api\/owner\/walk-in-appointments'[\s\S]*walkIn: true/);
  assert.doesNotMatch(JSON.stringify(getOwnerFrontDeskCreationPolicy(true)), /in_service/);
});

test('assisted and walk-in creation share tenant, service, staff, price and duration authority', () => {
  const handler = server.slice(
    server.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    server.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.match(handler, /location\.shop_id=\$2 AND location\.is_active=TRUE/);
  assert.match(handler, /category\.shop_id=service\.shop_id[\s\S]*category\.is_active=TRUE/);
  assert.match(handler, /service\.shop_id=\$1[\s\S]*service\.is_active=TRUE AND service\.bookable=TRUE/);
  assert.match(handler, /QUALIFIED_SERVICE_STAFF_EXISTS_SQL/);
  assert.match(handler, /durationMinutes: Number\(service\.duration_minutes\)/);
  assert.match(handler, /price: service\.price/);
  assert.match(handler, /bookingValidator\(\{ dbClient: client, shopId: scope\.shop_id, locationId: scope\.location_id/);
  assert.match(admin, /s\.assigned === true && s\.is_active === true && s\.bookable === true && s\.category_active === true/);
  assert.match(admin, /selectedStaff\.is_active !== true \|\| selectedStaff\.bookable !== true/);
});

test('one-click arrival sends exactly one dedicated workflow request and no confirmation chain', () => {
  const workflow = admin.slice(
    admin.indexOf('async function arriveAndStartAppointment'),
    admin.indexOf('function setupAppointmentDrawer')
  );
  assert.match(workflow, /fetch\(`\/api\/owner\/appointments\/\$\{encodeURIComponent\(safeId\)\}\/arrive-and-start`/);
  assert.equal((workflow.match(/\bfetch\(/g) || []).length, 1);
  assert.doesNotMatch(workflow, /confirm\s*\(/);
  assert.doesNotMatch(workflow, /update-status-db/);
  assert.match(workflow, /applyAppointmentStatusChangeInPlace\(safeId, 'in_service'/);
});

test('front-desk lifecycle action matrix keeps cancel and no-show legal', () => {
  const render = admin.slice(
    admin.indexOf('function renderActionButtonsForAppointment'),
    admin.indexOf('function applyAppointmentStatusChangeInPlace')
  );
  const pending = render.slice(render.indexOf("canonicalStatus === 'pending'"), render.indexOf("canonicalStatus === 'confirmed'"));
  const confirmed = render.slice(render.indexOf("canonicalStatus === 'confirmed'"), render.indexOf("canonicalStatus === 'arrived'"));
  const arrived = render.slice(render.indexOf("canonicalStatus === 'arrived'"), render.indexOf("canonicalStatus === 'in_service'"));
  assert.match(pending, /type: 'arrive_and_start'/);
  assert.match(pending, /targetStatus: 'cancelled'/);
  assert.doesNotMatch(pending, /no_show/);
  assert.match(confirmed, /type: 'arrive_and_start'/);
  assert.match(confirmed, /targetStatus: 'cancelled'/);
  assert.match(confirmed, /targetStatus: 'no_show'/);
  assert.match(arrived, /type: 'arrive_and_start'/);
  assert.doesNotMatch(arrived, /cancelled/);
  assert.match(admin, /cancelAppointmentReasonPrompt/);
});

test('detail workspace is centered, scrollable, focus-contained and has fixed operational footer', () => {
  assert.match(css, /\.appointment-drawer\s*\{[\s\S]*top:\s*50%;[\s\S]*left:\s*50%;[\s\S]*width:\s*min\(960px/);
  assert.match(css, /transform:\s*translate\(-50%, -50%\) scale\(1\)/);
  assert.match(css, /\.drawer-body\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*display:\s*grid/);
  assert.match(css, /\.drawer-footer\s*\{[\s\S]*box-shadow:/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*height:\s*calc\(100vh - 24px\)/);
  assert.match(admin, /event\.key === 'Escape'/);
  assert.match(admin, /event\.key === 'Tab'/);
  assert.match(admin, /activeDrawerTriggerElement\.focus/);
});

test('calendar keeps quarter-hour snapping while visually emphasizing only hours and half-hours', () => {
  assert.match(admin, /FRONT_DESK_SLOT_MINUTES = 15/);
  assert.match(admin, /Math\.round\(rawMinutes \/ FRONT_DESK_SLOT_MINUTES\) \* FRONT_DESK_SLOT_MINUTES/);
  assert.match(admin, /isNormalizedFrontDeskSlotTime/);
  assert.match(server, /OWNER_APPOINTMENT_SLOT_MINUTES = 15/);
  assert.match(server, /minutes % OWNER_APPOINTMENT_SLOT_MINUTES === 0/);
  assert.doesNotMatch(css, /18\.75px/);
  assert.match(css, /37\.5px/);
  assert.match(admin, /is-major is-hour/);
  assert.match(admin, /is-minor is-half-hour/);
  assert.match(admin, /is-minor is-quarter-hour/);
});

test('membership projection is feature-gated, recipient-scoped and tenant-scoped', () => {
  const read = server.slice(server.indexOf("'/api/appointments-db'"), server.indexOf("app.post(\n  '/api/admin/update-status-db'"));
  assert.match(read, /customer_settings\.membership_enabled/);
  assert.match(read, /customer_membership\.shop_id = a\.shop_id/);
  assert.match(read, /customer_membership\.customer_id = COALESCE\([\s\S]*a\.recipient_customer_id,[\s\S]*a\.customer_id/);
  assert.match(read, /tier\.shop_id = customer_membership\.shop_id/);
  assert.match(read, /membership_is_active/);
  assert.match(read, /membership\.expires_at > NOW\(\)/);
  assert.match(admin, /appointment\.membership_enabled === true && appointment\.membership_is_active === true/);
  assert.doesNotMatch(admin, /identity_status[\s\S]{0,120}drawer-member-badge/);
});

test('no fake stored-value, package, or points values are rendered in appointment detail', () => {
  const drawer = admin.slice(admin.indexOf('function renderAppointmentDrawer'), admin.indexOf('function bindActionButtonsIn'));
  assert.doesNotMatch(drawer, /stored.?value|package.?remaining|points.?balance/i);
});

test('new UI strings are complete and single-language in Chinese and English', () => {
  for (const key of [
    'assistedAppointmentTitle',
    'assistedAppointmentHelp',
    'arriveAndStartSuccess',
    'arriveAndStartFailed',
    'cancelAppointmentReasonPrompt',
    'membershipTier',
    'membershipStatusExpired'
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
  assert.match(i18n, /markNoShow: '爽约'/);
  assert.match(i18n, /markNoShow: 'No Show'/);
});
