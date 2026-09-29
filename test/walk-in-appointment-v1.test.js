'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

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
  assert.match(admin, /countryCode: 'SG'/);
  assert.match(admin, /\/api\/owner\/staff\/\$\{encodeURIComponent\(safeStaffId\)\}\/services/);
  assert.match(admin, /s\.assigned === true/);
  assert.match(admin, /loadEligibleServices = async nextStaffId/);
  assert.match(admin, /walk-in-staff'\)\.addEventListener\('change'/);
  assert.match(admin, /countryCode: 'SG'/);
  assert.match(admin, /INVALID_PHONE: 'invalidPhone'/);
});
