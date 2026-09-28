'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('crypto');
const http = require('http');

const {
  TIMEZONE,
  generateCalendarToken,
  verifyCalendarToken,
  toSingaporeLocalIcs,
  toUtcIcs,
  escapeIcsText,
  buildCalendarEventProjection,
  formatIcsCalendar,
  buildGoogleCalendarUrl,
  loadAuthoritativeCalendarData
} = require('../lib/customer-calendar');

const sharedI18n = require('../public/shared-i18n');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const withTestServer = async (appOrHandler, operation) => {
  const server = http.createServer(appOrHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await operation(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

test('1. Calendar projection authorization - valid token succeeds', () => {
  const appointmentId = '33333333-3333-4000-8000-000000000001';
  const shopId = '11111111-1111-4000-8000-000000000001';
  const token = generateCalendarToken({ appointmentId, shopId });
  const verified = verifyCalendarToken(token);
  assert.ok(verified);
  assert.equal(verified.appointmentId, appointmentId);
  assert.equal(verified.shopId, shopId);
});

test('2. Unauthorized access denied - missing, tampered, or expired tokens rejected', () => {
  const appointmentId = '33333333-3333-4000-8000-000000000001';
  const shopId = '11111111-1111-4000-8000-000000000001';
  assert.equal(verifyCalendarToken(null), null);
  assert.equal(verifyCalendarToken(''), null);
  assert.equal(verifyCalendarToken('invalid-token'), null);

  const token = generateCalendarToken({ appointmentId, shopId });
  const [payload, sig] = token.split('.');
  const tamperedSig = sig.slice(0, -2) + (sig.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyCalendarToken(`${payload}.${tamperedSig}`), null);

  // Expired token
  const expiredToken = generateCalendarToken({ appointmentId, shopId, ttlSeconds: -10 });
  assert.equal(verifyCalendarToken(expiredToken), null);
});

test('3. Cross-tenant access denied - token for shop A cannot access appointment in shop B', async () => {
  const appointmentId = '33333333-3333-4000-8000-000000000001';
  const shopA = '11111111-1111-4000-8000-000000000001';
  const shopB = '22222222-2222-4000-8000-000000000002';

  const mockPool = {
    query: async (sql, params) => {
      // params[0] is appointmentId, params[1] is shopId
      if (params[0] === appointmentId && params[1] === shopA) {
        return {
          rows: [{
            id: appointmentId,
            shop_id: shopA,
            appointment_no: 'GG-12345678',
            start_at: new Date('2030-05-15T02:00:00.000Z'),
            end_at: new Date('2030-05-15T03:00:00.000Z'),
            status: 'confirmed',
            shop_name: 'Shop A'
          }]
        };
      }
      return { rows: [] };
    }
  };

  // Valid token for Shop A finds data
  const dataA = await loadAuthoritativeCalendarData(mockPool, { appointmentId, shopId: shopA });
  assert.ok(dataA);

  // Attempting to query with Shop B fails (returns null)
  const dataB = await loadAuthoritativeCalendarData(mockPool, { appointmentId, shopId: shopB });
  assert.equal(dataB, null);
});

test('4. Sequential appointment ID alone insufficient', () => {
  assert.doesNotMatch(serverSource, /app\.get\(['"]\/calendar\/:/);
  assert.equal(verifyCalendarToken('123'), null);
  assert.equal(verifyCalendarToken('GG-12345678'), null);
  assert.equal(verifyCalendarToken('33333333-3333-4000-8000-000000000001'), null);
});

test('5. Correct merchant display-name fallback', () => {
  const appointment = {
    id: '33333333-3333-4000-8000-000000000001',
    appointment_no: 'GG-001',
    start_at: new Date('2030-05-15T02:00:00.000Z'),
    end_at: new Date('2030-05-15T03:00:00.000Z'),
    legacy_service_name: 'Lash Lift'
  };

  // Case A: public_display_name is provided
  const projWithDisplayName = buildCalendarEventProjection({
    appointment,
    shop: { name: 'Raw Shop Name' },
    settings: { public_display_name: 'Glamour Studio' }
  });
  assert.equal(projWithDisplayName.title, 'Glamour Studio — Lash Lift');
  assert.equal(projWithDisplayName.merchantDisplayName, 'Glamour Studio');

  // Case B: public_display_name is empty/whitespace -> falls back to shop.name
  const projFallback = buildCalendarEventProjection({
    appointment,
    shop: { name: 'Fallback Salon' },
    settings: { public_display_name: '   ' }
  });
  assert.equal(projFallback.title, 'Fallback Salon — Lash Lift');
  assert.equal(projFallback.merchantDisplayName, 'Fallback Salon');
});

test('6. Single service title format', () => {
  const appointment = {
    id: '33333333-3333-4000-8000-000000000001',
    appointment_no: 'GG-001',
    start_at: new Date('2030-05-15T02:00:00.000Z'),
    end_at: new Date('2030-05-15T03:00:00.000Z')
  };
  const items = [{ service_name_snapshot: 'Signature Facial' }];
  const proj = buildCalendarEventProjection({
    appointment,
    items,
    shop: { name: 'Aura Spa' }
  });
  assert.equal(proj.title, 'Aura Spa — Signature Facial');
});

test('7. Multiple-service title format', () => {
  const appointment = {
    id: '33333333-3333-4000-8000-000000000001',
    appointment_no: 'GG-001',
    start_at: new Date('2030-05-15T02:00:00.000Z'),
    end_at: new Date('2030-05-15T04:30:00.000Z')
  };
  const items = [
    { service_name_snapshot: 'Hair Cut' },
    { service_name_snapshot: 'Balayage Color' },
    { service_name_snapshot: 'Scalp Treatment' }
  ];
  const proj = buildCalendarEventProjection({
    appointment,
    items,
    shop: { name: 'Aura Hair' }
  });
  assert.equal(proj.title, 'Aura Hair — Hair Cut +2');
});

test('8. Authoritative start/end from database timestamps', () => {
  const startAt = new Date('2030-08-20T03:30:00.000Z');
  const endAt = new Date('2030-08-20T05:00:00.000Z');
  const appointment = {
    id: '33333333-3333-4000-8000-000000000001',
    appointment_no: 'GG-001',
    start_at: startAt,
    end_at: endAt,
    legacy_service_name: 'Massage'
  };
  const proj = buildCalendarEventProjection({ appointment, shop: { name: 'Zen' } });
  assert.equal(proj.startAt, startAt);
  assert.equal(proj.endAt, endAt);
});

test('9. Asia/Singapore time correctness in ICS and Google Calendar', () => {
  // UTC 02:00:00 is Singapore (UTC+8) 10:00:00
  const startAt = new Date('2030-05-15T02:00:00.000Z');
  const endAt = new Date('2030-05-15T03:30:00.000Z');
  const sgStart = toSingaporeLocalIcs(startAt);
  const sgEnd = toSingaporeLocalIcs(endAt);
  assert.equal(sgStart, '20300515T100000');
  assert.equal(sgEnd, '20300515T113000');

  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: startAt,
      end_at: endAt,
      legacy_service_name: 'Nails'
    },
    shop: { name: 'GG Salon' }
  });

  const ics = formatIcsCalendar(proj);
  assert.match(ics, /DTSTART;TZID=Asia\/Singapore:20300515T100000/);
  assert.match(ics, /DTEND;TZID=Asia\/Singapore:20300515T113000/);

  const googleUrl = buildGoogleCalendarUrl(proj);
  const parsedGoogle = new URL(googleUrl);
  assert.equal(parsedGoogle.searchParams.get('ctz'), 'Asia/Singapore');
  assert.equal(parsedGoogle.searchParams.get('dates'), '20300515T020000Z/20300515T033000Z');
});

test('10. ICS Content-Type and headers in server route', () => {
  assert.match(serverSource, /'Content-Type':\s*'text\/calendar;\s*charset=utf-8'/);
  assert.match(serverSource, /'Content-Disposition':\s*`attachment;\s*filename="\${safeFilename}"`/);
});

test('11. ICS UTF-8 handling for multilingual characters', () => {
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: '基础面部护理'
    },
    shop: { name: '美丽日记美甲美睫' }
  });
  const ics = formatIcsCalendar(proj);
  assert.match(ics, /SUMMARY:美丽日记美甲美睫 — 基础面部护理/);
  assert.match(ics, /Your appointment at 美丽日记美甲美睫/);
});

test('12. Stable UID for duplicate calendar generation', () => {
  const aptId = '33333333-3333-4000-8000-000000000001';
  const proj1 = buildCalendarEventProjection({
    appointment: {
      id: aptId,
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Service'
    },
    shop: { name: 'Shop' }
  });
  const proj2 = buildCalendarEventProjection({
    appointment: {
      id: aptId,
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Service'
    },
    shop: { name: 'Shop' }
  });
  const ics1 = formatIcsCalendar(proj1);
  const ics2 = formatIcsCalendar(proj2);
  const uid1 = ics1.match(/UID:(.+)\r\n/)[1];
  const uid2 = ics2.match(/UID:(.+)\r\n/)[1];
  assert.equal(uid1, uid2);
  assert.equal(uid1, `apt-${aptId}@ggbeauty.app`);
});

test('13. ICS escaping of special characters', () => {
  assert.equal(escapeIcsText('Hello, World; Welcome \\ back\nNext line'), 'Hello\\, World\\; Welcome \\\\ back\\nNext line');
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Special: Cut; Wash, & Style'
    },
    shop: { name: 'Co\\Shop; & Co,' },
    settings: {
      public_address: '123 Orchard Rd, #01-02; Singapore',
      show_public_address: true
    }
  });
  const ics = formatIcsCalendar(proj);
  assert.match(ics, /SUMMARY:Co\\\\Shop\\; & Co\\, — Special: Cut\\; Wash\\, & Style/);
  assert.match(ics, /LOCATION:123 Orchard Rd\\, #01-02\\; Singapore/);
});

test('14. Public address included when allowed', () => {
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Service'
    },
    shop: { name: 'Salon' },
    settings: {
      public_address: '123 Orchard Rd',
      public_postal_code: '238888',
      show_public_address: true
    }
  });
  assert.equal(proj.location, '123 Orchard Rd 238888');
  const ics = formatIcsCalendar(proj);
  assert.match(ics, /LOCATION:123 Orchard Rd 238888/);
  assert.match(ics, /Address: 123 Orchard Rd 238888/);
});

test('15. Hidden/non-public address excluded when disabled', () => {
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Service'
    },
    shop: { name: 'Secret Studio' },
    settings: {
      public_address: 'Private Home Studio',
      show_public_address: false
    }
  });
  assert.equal(proj.location, null);
  const ics = formatIcsCalendar(proj);
  assert.doesNotMatch(ics, /\r?\nLOCATION:/);
  assert.doesNotMatch(ics, /Private Home Studio/);
});

test('16-21. Data minimization - no PII, internal notes, special request, financial data in calendar', () => {
  const sensitiveAppointment = {
    id: '33333333-3333-4000-8000-000000000001',
    appointment_no: 'GG-SAFE-01',
    start_at: new Date('2030-05-15T02:00:00.000Z'),
    end_at: new Date('2030-05-15T03:00:00.000Z'),
    legacy_service_name: 'Facial',
    // Sensitive fields that MUST NOT leak:
    customer_phone: '+6591234567',
    customer_email: 'secret@example.com',
    customer_name: 'Alice Private',
    booker_phone_snapshot: '+6591234567',
    booker_email_snapshot: 'secret@example.com',
    recipient_phone_snapshot: '+6591234567',
    recipient_email_snapshot: 'secret@example.com',
    customer_special_request: 'Allergic to aloe vera products',
    internal_notes: 'Customer is VIP, owes $50 from last visit',
    profile_notes: 'Difficult customer, prefers quiet',
    membership_balance: 500,
    points: 120,
    stored_value: 300,
    price: 88,
    payment_status: 'paid'
  };

  const proj = buildCalendarEventProjection({
    appointment: sensitiveAppointment,
    shop: { name: 'Luxury Spa' },
    settings: { public_address: '100 Marina Bay', show_public_address: true }
  });

  const ics = formatIcsCalendar(proj);
  const googleUrl = buildGoogleCalendarUrl(proj);

  for (const forbidden of [
    '+6591234567',
    'secret@example.com',
    'Alice Private',
    'Allergic to aloe vera',
    'Customer is VIP',
    'Difficult customer',
    'owes $50',
    'points',
    'stored_value',
    'paid'
  ]) {
    assert.equal(ics.includes(forbidden), false, `ICS must not contain '${forbidden}'`);
    assert.equal(googleUrl.includes(encodeURIComponent(forbidden)), false, `Google URL must not contain '${forbidden}'`);
  }
});

test('22. Google Calendar URL encoding correctness', () => {
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Nail Art & Spa'
    },
    shop: { name: 'Beauty & Co' },
    settings: {
      public_address: '10 Bayfront Ave, #01-01',
      show_public_address: true
    }
  });

  const googleUrl = buildGoogleCalendarUrl(proj);
  assert.ok(googleUrl.startsWith('https://calendar.google.com/calendar/render?'));
  const parsed = new URL(googleUrl);
  assert.equal(parsed.searchParams.get('text'), 'Beauty & Co — Nail Art & Spa');
  assert.equal(parsed.searchParams.get('location'), '10 Bayfront Ave, #01-01');
  assert.match(parsed.searchParams.get('details'), /Booking Reference: GG-001/);
});

test('23. Google Calendar URL contains no auth token or secret leak', () => {
  const token = generateCalendarToken({
    appointmentId: '33333333-3333-4000-8000-000000000001',
    shopId: '11111111-1111-4000-8000-000000000001'
  });
  const proj = buildCalendarEventProjection({
    appointment: {
      id: '33333333-3333-4000-8000-000000000001',
      appointment_no: 'GG-001',
      start_at: new Date('2030-05-15T02:00:00.000Z'),
      end_at: new Date('2030-05-15T03:00:00.000Z'),
      legacy_service_name: 'Hair'
    },
    shop: { name: 'Salon' }
  });

  const googleUrl = buildGoogleCalendarUrl(proj);
  assert.equal(googleUrl.includes(token), false);
  assert.equal(googleUrl.includes('token='), false);
  assert.equal(googleUrl.includes('session='), false);
  assert.equal(googleUrl.includes('secret'), false);
});

test('24. Booking success UI shows Add to Calendar buttons in public/index.html', () => {
  assert.match(indexHtml, /result\.data\?\.calendar/);
  assert.match(indexHtml, /id\s*=\s*'calendarSection'/);
  assert.match(indexHtml, /id\s*=\s*'appleCalendarBtn'/);
  assert.match(indexHtml, /id\s*=\s*'googleCalendarBtn'/);
  assert.match(indexHtml, /customerT\('addToCalendar'\)/);
  assert.match(indexHtml, /customerT\('appleCalendar'\)/);
  assert.match(indexHtml, /customerT\('googleCalendar'\)/);
});

test('25. Calendar actions absent before successful booking', () => {
  // Static HTML has no pre-rendered calendar actions
  assert.doesNotMatch(indexHtml, /<div[^>]*id="calendarSection"[^>]*>/);
  assert.doesNotMatch(indexHtml, /<a[^>]*id="appleCalendarBtn"[^>]*>/);
  assert.doesNotMatch(indexHtml, /<a[^>]*id="googleCalendarBtn"[^>]*>/);
});

test('26. Calendar failure does not alter successful appointment booking', () => {
  // In server.js, calendar generation error is caught and appointment is still returned
  assert.match(serverSource, /Calendar generation error:/);
  assert.match(indexHtml, /id\s*=\s*'calendarErrorMessage'/);
  assert.match(indexHtml, /customerT\('calendarGenerationFailed'\)/);
});

test('27. zh-CN shared dictionary has complete Chinese calendar translations', () => {
  assert.equal(sharedI18n.t('addToCalendar', 'zh-CN'), '添加到日历');
  assert.equal(sharedI18n.t('appleCalendar', 'zh-CN'), 'Apple / iPhone 日历');
  assert.equal(sharedI18n.t('googleCalendar', 'zh-CN'), 'Google 日历');
  assert.equal(sharedI18n.t('calendarGenerationFailed', 'zh-CN'), '无法生成日历，请稍后重试');
  assert.equal(sharedI18n.t('bookingConfirmed', 'zh-CN'), '预约成功');
});

test('28. en shared dictionary has complete English calendar translations', () => {
  assert.equal(sharedI18n.t('addToCalendar', 'en'), 'Add to Calendar');
  assert.equal(sharedI18n.t('appleCalendar', 'en'), 'Apple / iPhone Calendar');
  assert.equal(sharedI18n.t('googleCalendar', 'en'), 'Google Calendar');
  assert.equal(sharedI18n.t('calendarGenerationFailed', 'en'), 'Unable to create calendar event. Please try again.');
  assert.equal(sharedI18n.t('bookingConfirmed', 'en'), 'Booking Confirmed');
});

test('29. Mobile touch targets: minimum height 44px in index.html CSS', () => {
  assert.match(indexHtml, /\.calendar-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(indexHtml, /\.success-btn\s*\{[^}]*min-height:\s*44px/);
});

test('30. HTTP endpoint /api/calendar/appointment.ics with valid token returns 200 and ICS file', async () => {
  const { app } = require('../server');
  const appointmentId = '33333333-3333-4000-8000-000000000001';
  const shopId = '11111111-1111-4000-8000-000000000001';

  const mockPool = {
    query: async (sql, params) => {
      if (params[0] === appointmentId && params[1] === shopId) {
        return {
          rows: [{
            id: appointmentId,
            shop_id: shopId,
            appointment_no: 'GG-CAL-01',
            start_at: new Date('2030-05-15T02:00:00.000Z'),
            end_at: new Date('2030-05-15T03:00:00.000Z'),
            status: 'confirmed',
            created_at: new Date('2030-05-01T00:00:00.000Z'),
            shop_name: 'GG Hair & Beauty',
            public_display_name: 'GG Hair Studio',
            public_address: '88 Orchard Road',
            public_postal_code: '238888',
            public_map_url: 'https://maps.google.com/?q=88+Orchard',
            show_public_address: true,
            legacy_service_name: 'Haircut & Styling'
          }]
        };
      }
      return { rows: [] };
    }
  };

  app.locals.bookingPool = mockPool;
  const token = generateCalendarToken({ appointmentId, shopId });

  await withTestServer(app, async base => {
    // A. Valid token
    const res = await fetch(`${base}/api/calendar/appointment.ics?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /appointment-GG-CAL-01\.ics/);
    const body = await res.text();
    assert.match(body, /BEGIN:VCALENDAR/);
    assert.match(body, /SUMMARY:GG Hair Studio — Haircut & Styling/);
    assert.match(body, /LOCATION:88 Orchard Road 238888/);
    assert.match(body, /UID:apt-33333333-3333-4000-8000-000000000001@ggbeauty.app/);
    assert.match(body, /END:VCALENDAR/);

    // B. Missing token -> 403 Forbidden
    const resNoToken = await fetch(`${base}/api/calendar/appointment.ics`);
    assert.equal(resNoToken.status, 403);
    const jsonNoToken = await resNoToken.json();
    assert.equal(jsonNoToken.code, 'UNAUTHORIZED_CALENDAR_ACCESS');

    // C. Tampered token -> 403 Forbidden
    const resTampered = await fetch(`${base}/api/calendar/appointment.ics?token=${encodeURIComponent(token + 'bad')}`);
    assert.equal(resTampered.status, 403);

    // D. Insecure /calendar/:id route does NOT exist -> 404
    const resInsecure = await fetch(`${base}/calendar/${appointmentId}`);
    assert.equal(resInsecure.status, 404);
  });
});

test('31. HTTP endpoint /api/calendar/projection returns JSON with authoritative safe details', async () => {
  const { app } = require('../server');
  const appointmentId = '33333333-3333-4000-8000-000000000001';
  const shopId = '11111111-1111-4000-8000-000000000001';

  const mockPool = {
    query: async (sql, params) => {
      if (params[0] === appointmentId && params[1] === shopId) {
        return {
          rows: [{
            id: appointmentId,
            shop_id: shopId,
            appointment_no: 'GG-CAL-01',
            start_at: new Date('2030-05-15T02:00:00.000Z'),
            end_at: new Date('2030-05-15T03:00:00.000Z'),
            status: 'confirmed',
            created_at: new Date('2030-05-01T00:00:00.000Z'),
            shop_name: 'GG Hair Studio',
            legacy_service_name: 'Haircut & Styling'
          }]
        };
      }
      return { rows: [] };
    }
  };

  app.locals.bookingPool = mockPool;
  const token = generateCalendarToken({ appointmentId, shopId });

  await withTestServer(app, async base => {
    const res = await fetch(`${base}/api/calendar/projection?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.title, 'GG Hair Studio — Haircut & Styling');
    assert.match(json.data.icsUrl, /\/api\/calendar\/appointment\.ics\?token=/);
    assert.ok(json.data.googleUrl.startsWith('https://calendar.google.com/calendar/render?'));
    // Ensure no secrets leaked in googleUrl
    assert.equal(json.data.googleUrl.includes('token='), false);

    // Missing token -> 403
    const resNoToken = await fetch(`${base}/api/calendar/projection`);
    assert.equal(resNoToken.status, 403);
  });
});
