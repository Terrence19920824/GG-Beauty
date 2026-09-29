'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public', 'shared-i18n.js'), 'utf8');

test('walk-in uses the existing appointment architecture with server-side authority', () => {
  const route = server.slice(server.indexOf("app.post('/api/owner/walk-in-appointments'"));
  assert.match(route, /requireOwnerRole\(\['owner', 'manager', 'front_desk'\]\)/);
  assert.doesNotMatch(route, /requireOwnerRole\(\[[^\]]*'staff'/);
  assert.match(route, /resolveOrCreateCustomer\(client, \{ shopId: scope\.shop_id, name, phone, email \}\)/);
  assert.match(route, /booking_source,override_conflict\)\s*VALUES[\s\S]*'walk_in'/);
  assert.match(route, /createMultiServiceRows\(client/);
  assert.match(route, /appointment_item_staff_assignments/);
  assert.match(route, /validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(route, /bookingValidator\(/);
  assert.match(route, /BOOKING_TIME_IN_PAST/);
  assert.match(route, /\['confirmed', 'arrived'\]/);
  assert.match(route, /recordStatusHistory/);
  assert.match(route, /operatorType: ownerStatusHistoryActorType\(req\.ownerAuth\.role\)/);
  assert.match(route, /operatorId: req\.ownerAuth\.ownerAccountId/);
  assert.match(route, /const canOverrideConflict = \['owner', 'manager'\]/);
  assert.match(route, /error\.code === 'APPOINTMENT_COLLISION'/);
  assert.match(route, /hasTimeConflict && !overrideConflictRequested/);
  assert.match(route, /hasTimeConflict && !canOverrideConflict/);
  assert.match(route, /override_conflict\)/);
  assert.match(route, /owner_walk_in_conflict_override/);
  assert.doesNotMatch(route, /conflictReason\.trim\(\)\.length/);
});

test('walk-in calendar entry is localized and refreshes the existing calendar', () => {
  assert.doesNotMatch(admin, /id="walkInButton"/);
  assert.match(admin, /owner-calendar-staff-column\[data-staff-id\]/);
  assert.match(admin, /openWalkInAppointment\(\{ staffId, date: currentCalendarDate, time \}\)/);
  assert.match(admin, /\/api\/owner\/walk-in-appointments/);
  assert.match(admin, /await loadAppointments\(context\.location_id\)/);
  assert.match(admin, /select name="countryCode"/);
  assert.match(admin, /option value="SG"[^>]*>[^<]*\(\+65\)/);
  assert.match(admin, /option value="CN"[^>]*>[^<]*\(\+86\)/);
  assert.match(admin, /option value="MY"[^>]*>[^<]*\(\+60\)/);
  assert.doesNotMatch(admin, /option value="ID"|option value="US"/);
  assert.match(admin, /countryCode: fd\.get\('countryCode'\)/);
  assert.match(admin, /\/api\/owner\/staff\/\$\{encodeURIComponent\(safeStaffId\)\}\/services/);
  assert.match(admin, /s\.assigned === true/);
  assert.match(admin, /walkInNoBookableServices/);
  assert.match(i18n, /walkInNoBookableServices: '该员工暂无可预约项目'/);
  assert.match(i18n, /walkInNoBookableServices: 'No bookable services are available for this staff member\.'/);
  assert.match(admin, /loadEligibleServices = async nextStaffId/);
  assert.match(admin, /walk-in-staff'\)\.addEventListener\('change'/);
  assert.match(admin, /button type="button" class="secondary-btn walk-in-close"/);
  assert.match(admin, /walk-in-close'\)\.addEventListener\('click', closeWalkInDialog\)/);
  assert.match(admin, /if \(dialog\.open\) dialog\.close\(\);/);
  assert.match(admin, /calendarActionMap/);
  assert.doesNotMatch(admin, /localKeySeq|localActionMap/);
  assert.match(admin, /INVALID_PHONE: 'invalidPhone'/);
});

test('walk-in acceptance actions remain server-authoritative and non-mutating until save', () => {
  const route = server.slice(server.indexOf("app.post('/api/owner/walk-in-appointments'"));
  assert.match(route, /validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(server, /const resolveCountryIso = countryInput/);
  assert.match(server, /validateCustomerIdentityPhone/);
  assert.doesNotMatch(route, /phone_verified_at/);
  assert.match(admin, /data-target-status="arrived"/);
  assert.match(admin, /data-target-status="cancelled"/);
  assert.doesNotMatch(admin, /data-target-status="no_show"/);
  assert.match(admin, /isAppointmentLate\(item, nowMs, authToday\)/);
  assert.match(admin, /canonicalStatus !== 'pending' && canonicalStatus !== 'confirmed'/);
  assert.match(admin, /startMs \+ fifteenMinutesMs/);
});
