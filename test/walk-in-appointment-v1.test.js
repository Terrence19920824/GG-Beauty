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
  assert.match(route, /booking_source\)\s*VALUES[\s\S]*'walk_in'/);
  assert.match(route, /createMultiServiceRows\(client/);
  assert.match(route, /appointment_item_staff_assignments/);
  assert.match(route, /validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(route, /bookingValidator\(/);
  assert.match(route, /BOOKING_TIME_IN_PAST/);
  assert.match(route, /\['confirmed', 'arrived'\]/);
  assert.match(route, /recordStatusHistory/);
});

test('walk-in calendar entry is localized and refreshes the existing calendar', () => {
  assert.match(admin, /id="walkInButton"/);
  assert.match(admin, /openWalkInAppointment/);
  assert.match(admin, /\/api\/owner\/walk-in-appointments/);
  assert.match(admin, /await loadAppointments\(context\.location_id\)/);
});
