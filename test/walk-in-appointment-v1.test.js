'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public', 'shared-i18n.js'), 'utf8');
const { getWalkInPhoneCountries } = require(path.join(root, 'lib', 'phone-normalization'));
const { getOwnerFrontDeskCreationPolicy } = require(path.join(root, 'lib', 'owner-front-desk-creation-policy'));

test('walk-in phone selector is the complete server-authoritative global ISO country list', () => {
  const countries = getWalkInPhoneCountries('en');
  assert.ok(countries.length >= 240);
  for (const iso of ['SG', 'MY', 'ID', 'PH', 'TH', 'VN', 'CN', 'HK', 'TW', 'JP', 'KR', 'IN', 'AU', 'NZ', 'US', 'CA', 'GB', 'FR', 'DE', 'IT', 'ES', 'NL', 'CH', 'AE', 'SA', 'ZA', 'BR']) {
    assert.ok(countries.some(country => country.countryIso2 === iso), `${iso} must be selectable`);
  }
  assert.equal(countries[0].countryIso2, 'SG');
  assert.equal(countries[0].callingCode, '+65');
  assert.equal(countries[0].flag, '🇸🇬');
});

test('walk-in uses the existing appointment architecture with server-side authority', () => {
  const route = server.slice(
    server.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    server.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.match(route, /requireOwnerRole\(\['owner', 'manager', 'front_desk'\]\)/);
  assert.doesNotMatch(route, /requireOwnerRole\(\[[^\]]*'staff'/);
  assert.match(route, /canonicalPhone = validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(route, /resolveOrCreateCustomer\(client, \{ shopId: scope\.shop_id, name: customerName, phone: canonicalPhone, email \}\)/);
  assert.match(route, /getOwnerFrontDeskCreationPolicy\(walkIn\)/);
  assert.match(route, /booking_source,override_conflict\)[\s\S]*'pending',\$11,\$12/);
  assert.match(route, /createMultiServiceRows\(client/);
  assert.match(server, /appointment_item_staff_assignments/);
  assert.match(route, /validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(route, /bookingValidator\(/);
  assert.match(route, /BOOKING_TIME_IN_PAST/);
  assert.match(route, /creationPolicy\.transitions/);
  assert.match(route, /recordStatusHistory/);
  assert.match(route, /operatorType: ownerStatusHistoryActorType\(req\.ownerAuth\.role\)/);
  assert.match(route, /operatorId: req\.ownerAuth\.ownerAccountId/);
  assert.match(route, /const canOverrideConflict = \['owner', 'manager'\]/);
  assert.match(route, /error\.code === 'APPOINTMENT_COLLISION'/);
  assert.match(route, /hasTimeConflict && !overrideConflictRequested/);
  assert.match(route, /hasTimeConflict && !canOverrideConflict/);
  assert.match(route, /override_conflict\)/);
  assert.equal(getOwnerFrontDeskCreationPolicy(true).historySource, 'owner_walk_in');
  assert.equal(getOwnerFrontDeskCreationPolicy(false).historySource, 'owner_assisted_booking');
  assert.doesNotMatch(route, /conflictReason\.trim\(\)\.length/);
});

test('walk-in calendar entry is localized and refreshes the existing calendar', () => {
  assert.doesNotMatch(admin, /id="walkInButton"/);
  assert.match(admin, /owner-calendar-staff-column\[data-staff-id\]/);
  assert.match(admin, /openFrontDeskAppointment\(\{ staffId, date: currentCalendarDate, time, mode: 'assisted' \}\)/);
  assert.match(admin, /\/api\/owner\/walk-in-appointments/);
  assert.match(admin, /\/api\/owner\/assisted-appointments/);
  assert.match(admin, /await loadAppointments\(context\.location_id\)/);
  assert.match(admin, /select name="countryCode"/);
  assert.match(admin, /walk-in-country-search/);
  assert.match(admin, /countrySearch/);
  assert.match(admin, /country\.localizedName/);
  assert.match(admin, /country\.callingCode/);
  assert.match(admin, /\/api\/owner\/walk-in-phone-countries/);
  assert.match(server, /getWalkInPhoneCountries/);
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
  const route = server.slice(
    server.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    server.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.match(route, /validateBookingPhone\(phone, customer\.countryCode\)/);
  assert.match(server, /const resolveCountryIso = countryInput/);
  assert.match(server, /validateCustomerIdentityPhone/);
  assert.doesNotMatch(route, /phone_verified_at/);
  assert.match(admin, /data-action="arrive-and-start"/);
  assert.match(admin, /data-target-status="cancelled"/);
  assert.match(admin, /canonicalStatus === 'confirmed'[\s\S]*data-target-status="no_show"/);
  assert.match(admin, /canonicalStatus === 'pending'[\s\S]*data-action="arrive-and-start"/);
  assert.match(admin, /isAppointmentLate\(item, nowMs, authToday\)/);
  assert.match(admin, /canonicalStatus !== 'pending' && canonicalStatus !== 'confirmed'/);
  assert.match(admin, /startMs \+ fifteenMinutesMs/);
});
