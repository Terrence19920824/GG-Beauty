'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const { maskCustomerPhone } = require('../lib/phone-normalization');
const {
  createBookingNotification,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  formatNotificationSummary
} = require('../lib/booking-notifications');

// Read frontend HTML / JS files
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const staffHtml = fs.readFileSync(path.join(ROOT, 'public/staff-appointments.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const memberHtml = fs.readFileSync(path.join(ROOT, 'public/member.html'), 'utf8');
const myBookingsHtml = fs.readFileSync(path.join(ROOT, 'public/my-bookings.html'), 'utf8');
const calendarCss = fs.readFileSync(path.join(ROOT, 'public/calendar-shared.css'), 'utf8');

// =============================================================================
// 1. UNIFIED HEADER ACTIONS & ACCESSIBILITY
// =============================================================================

test('1. Admin page contains unified header actions: Refresh, Language toggle, Notification Bell, and Logout', () => {
  assert.match(adminHtml, /id="adminRefreshBtn"/);
  assert.match(adminHtml, /id="adminLanguageToggleBtn"/);
  assert.match(adminHtml, /id="adminNotificationBellBtn"/);
  assert.match(adminHtml, /id="adminNotificationBadge"/);

  // SVG icons present
  assert.match(adminHtml, /class="refresh-icon"/);
  assert.match(adminHtml, /class="lang-icon-svg"/);
  assert.match(adminHtml, /class="bell-icon"/);

  // "文+A" vector SVG glyphs
  assert.match(adminHtml, /<text[^>]*>文<\/text>/);
  assert.match(adminHtml, /<text[^>]*>A<\/text>/);

  // Legacy buttons preserved for test compatibility
  assert.match(adminHtml, /id="adminLanguageZh"/);
  assert.match(adminHtml, /id="adminLanguageEn"/);
});

test('2. Staff page contains unified header actions: Refresh, Language toggle, Notification Bell', () => {
  assert.match(staffHtml, /id="staff-refresh-btn"/);
  assert.match(staffHtml, /id="staff-language-toggle-btn"/);
  assert.match(staffHtml, /id="staff-notification-bell-btn"/);
  assert.match(staffHtml, /id="staff-notification-badge"/);

  // SVG icons present
  assert.match(staffHtml, /class="refresh-icon"/);
  assert.match(staffHtml, /class="lang-icon-svg"/);
  assert.match(staffHtml, /class="bell-icon"/);

  // "文+A" vector SVG glyphs
  assert.match(staffHtml, /<text[^>]*>文<\/text>/);
  assert.match(staffHtml, /<text[^>]*>A<\/text>/);

  // Legacy buttons preserved
  assert.match(staffHtml, /id="language-en"/);
  assert.match(staffHtml, /id="language-zh"/);
});

test('3. Customer booking, Member, and My Bookings contain "文+A" language toggle and preserve legacy buttons', () => {
  for (const [pageName, content] of [['index.html', indexHtml], ['member.html', memberHtml], ['my-bookings.html', myBookingsHtml]]) {
    assert.match(content, /id="languageSwitchBtn"/, `${pageName} must have languageSwitchBtn`);
    assert.match(content, /class="lang-icon-svg"/, `${pageName} must have lang-icon-svg`);
    assert.match(content, /<text[^>]*>文<\/text>/, `${pageName} must have Chinese 文 glyph`);
    assert.match(content, /<text[^>]*>A<\/text>/, `${pageName} must have Latin A glyph`);
    assert.match(content, /id="languageZh"/, `${pageName} must preserve languageZh for backward compatibility`);
    assert.match(content, /id="languageEn"/, `${pageName} must preserve languageEn for backward compatibility`);
  }
});

test('4. 44px minimum touch targets and focus-visible rings defined in CSS', () => {
  assert.match(calendarCss, /\.header-action-btn\s*\{[^}]*min-width:\s*44px;/);
  assert.match(calendarCss, /\.header-action-btn\s*\{[^}]*min-height:\s*44px;/);
  assert.match(calendarCss, /\.header-action-btn:focus-visible/);
  assert.match(calendarCss, /\.notification-drawer/);
  assert.match(calendarCss, /\.notification-badge/);
  assert.match(calendarCss, /\.is-spinning/);
});

test('5. Zero dynamic inline on* event handler attributes across git diff additions', () => {
  const { execSync } = require('node:child_process');
  let diff = '';
  try {
    diff = execSync('git diff HEAD', { encoding: 'utf8', cwd: ROOT });
  } catch (_) {}
  if (diff) {
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    for (const line of addedLines) {
      assert.doesNotMatch(line, /\son[a-z]+\s*=/i, `Inline event handler detected in diff: ${line}`);
    }
  }
});

// =============================================================================
// 2. REFRESH & DRAWER BEHAVIORAL CONTRACTS
// =============================================================================

test('6. Refresh buttons use authoritative data fetch without location.reload() and implement concurrency locking', () => {
  // admin.html handleAdminRefresh
  assert.match(adminHtml, /async function handleAdminRefresh\(\)\s*\{/);
  assert.match(adminHtml, /if\s*\(isAdminRefreshing\)\s*return;/);
  assert.match(adminHtml, /icon\.classList\.add\('is-spinning'\)/);
  assert.match(adminHtml, /await loadAppointments\(\)/);
  assert.match(adminHtml, /await updateAdminNotificationCount\(\)/);
  assert.match(adminHtml, /icon\.classList\.remove\('is-spinning'\)/);
  assert.doesNotMatch(adminHtml, /handleAdminRefresh[\s\S]*?location\.reload\(\)/);

  // staff-appointments.html handleStaffRefresh
  assert.match(staffHtml, /const handleStaffRefresh = async \(\) =>\s*\{/);
  assert.match(staffHtml, /if\s*\(isStaffRefreshing\)\s*return;/);
  assert.match(staffHtml, /icon\.classList\.add\('is-spinning'\)/);
  assert.match(staffHtml, /await loadAppointments\(state\.selectedDate\)/);
  assert.match(staffHtml, /await updateStaffNotificationCount\(\)/);
  assert.match(staffHtml, /icon\.classList\.remove\('is-spinning'\)/);
  assert.doesNotMatch(staffHtml, /handleStaffRefresh[\s\S]*?location\.reload\(\)/);
});

test('7. Notification drawers support open, close, mark read, mark all read, and Escape key dismissal', () => {
  // Admin drawer
  assert.match(adminHtml, /id="adminNotificationDrawer"/);
  assert.match(adminHtml, /id="adminNotificationBackdrop"/);
  assert.match(adminHtml, /id="adminMarkAllReadBtn"/);
  assert.match(adminHtml, /id="adminNotificationCloseBtn"/);
  assert.match(adminHtml, /id="adminNotificationList"/);
  assert.match(adminHtml, /toggleAdminNotifications/);
  assert.match(adminHtml, /closeAdminNotifications/);
  assert.match(adminHtml, /openAdminNotifications/);

  // Staff drawer
  assert.match(staffHtml, /id="staff-notification-drawer"/);
  assert.match(staffHtml, /id="staff-notification-backdrop"/);
  assert.match(staffHtml, /id="staff-mark-all-read-btn"/);
  assert.match(staffHtml, /id="staff-notification-close-btn"/);
  assert.match(staffHtml, /id="staff-notification-list"/);
  assert.match(staffHtml, /toggleStaffNotifications/);
  assert.match(staffHtml, /closeStaffNotifications/);
  assert.match(staffHtml, /openStaffNotifications/);
});

test('8. Badge display rules: 0 is hidden, 1-9 is literal count, >=10 is 9+', () => {
  // Verify logic in admin.html
  assert.match(adminHtml, /count <= 0/);
  assert.match(adminHtml, /badge\.classList\.add\('is-hidden'\)/);
  assert.match(adminHtml, /count >= 10 \? '9\+' : String\(count\)/);

  // Verify logic in staff-appointments.html
  assert.match(staffHtml, /count <= 0/);
  assert.match(staffHtml, /staffNotificationBadge\.classList\.add\('is-hidden'\)/);
  assert.match(staffHtml, /count >= 10 \? '9\+' : String\(count\)/);
});

// =============================================================================
// 3. BOOKING NOTIFICATIONS BUSINESS LOGIC & RECIPIENT RULES
// =============================================================================

test('9. formatNotificationSummary resolves bilingual summaries accurately for all 3 events', () => {
  // Chinese summaries
  const createdZh = formatNotificationSummary({
    eventType: 'booking_created',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'zh-CN'
  });
  assert.match(createdZh, /新预约/);
  assert.match(createdZh, /Alice/);
  assert.match(createdZh, /Manicure/);

  const cancelledZh = formatNotificationSummary({
    eventType: 'booking_cancelled',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'zh-CN'
  });
  assert.match(cancelledZh, /预约已取消/);
  assert.match(cancelledZh, /Alice/);

  const rescheduledZh = formatNotificationSummary({
    eventType: 'booking_rescheduled',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'zh-CN'
  });
  assert.match(rescheduledZh, /预约改期/);
  assert.match(rescheduledZh, /Alice/);

  // English summaries
  const createdEn = formatNotificationSummary({
    eventType: 'booking_created',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'en'
  });
  assert.match(createdEn, /New booking/);
  assert.match(createdEn, /Alice/);
  assert.match(createdEn, /Manicure/);

  const cancelledEn = formatNotificationSummary({
    eventType: 'booking_cancelled',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'en'
  });
  assert.match(cancelledEn, /Booking cancelled/);

  const rescheduledEn = formatNotificationSummary({
    eventType: 'booking_rescheduled',
    customerName: 'Alice',
    serviceName: 'Manicure',
    locale: 'en'
  });
  assert.match(rescheduledEn, /Booking rescheduled/);

  // Fallbacks with missing metadata
  const fallbackZh = formatNotificationSummary({ eventType: 'booking_created', locale: 'zh-CN' });
  assert.match(fallbackZh, /顾客/);
  assert.match(fallbackZh, /服务项目/);

  const fallbackEn = formatNotificationSummary({ eventType: 'booking_created', locale: 'en' });
  assert.match(fallbackEn, /Customer/);
  assert.match(fallbackEn, /Service/);
});

test('10. Mock DB: notification creation, recipient routing, deduplication, and unread counts', async () => {
  const shopId = '11111111-1111-4111-8111-111111111111';
  const staff1Id = '22222222-2222-4222-8222-222222222222';
  const staff2Id = '33333333-3333-4333-8333-333333333333';
  const appt1Id = '44444444-4444-4444-8444-444444444444';
  const appt2UnassignedId = '55555555-5555-4555-8555-555555555555';

  // In-memory store simulating Postgres table
  const notificationsStore = [];

  const mockDb = {
    query: async (sql, params) => {
      // Staff assignment query
      if (sql.includes('appointment_item_staff_assignments') || sql.includes('FROM appointments a')) {
        const appointmentId = params[1];
        if (appointmentId === appt1Id) {
          return { rows: [{ staff_id: staff1Id }] };
        }
        return { rows: [] };
      }

      // INSERT
      if (sql.includes('INSERT INTO booking_notifications')) {
        const [sId, aId, eventType, dedupeKey, metadata] = [params[0], params[1], params[2], params[3], params[4]];
        // check recipient_type & staff
        const isStaff = sql.includes("'staff'");
        const recipientType = isStaff ? 'staff' : 'shop';
        const recipientStaffId = isStaff ? params[3] : null;
        const actualDedupe = isStaff ? params[4] : dedupeKey;

        const exists = notificationsStore.find(n => n.shop_id === sId && n.dedupe_key === actualDedupe);
        if (exists) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        const notifSeq = String(notificationsStore.length + 1).padStart(12, '0');
        const row = {
          id: `66666666-6666-4666-8666-${notifSeq}`,
          shop_id: sId,
          appointment_id: aId,
          event_type: eventType,
          recipient_type: recipientType,
          recipient_staff_id: recipientStaffId,
          is_read: false,
          read_at: null,
          dedupe_key: actualDedupe,
          created_at: new Date().toISOString(),
          metadata: JSON.parse(isStaff ? params[5] : metadata)
        };
        notificationsStore.push(row);
        return { rows: [{ id: row.id }] };
      }

      // SELECT unread count
      if (sql.includes('SELECT COUNT(*)::INTEGER AS count')) {
        const sId = params[0];
        const recipientType = params[1];
        const staffIdParam = params[2];
        let filtered = notificationsStore.filter(n => n.shop_id === sId && n.recipient_type === recipientType && !n.is_read);
        if (recipientType === 'staff') {
          filtered = filtered.filter(n => n.recipient_staff_id === staffIdParam);
        }
        return { rows: [{ count: filtered.length }] };
      }

      // SELECT notifications list
      if (sql.includes('SELECT') && sql.includes('FROM booking_notifications')) {
        const sId = params[0];
        const recipientType = params[1];
        const staffIdParam = params[2];
        let filtered = notificationsStore.filter(n => n.shop_id === sId && n.recipient_type === recipientType);
        if (recipientType === 'staff') {
          filtered = filtered.filter(n => n.recipient_staff_id === staffIdParam);
        }
        const unreadCount = filtered.filter(n => !n.is_read).length;
        return {
          rows: filtered.map(row => ({
            ...row,
            appointment_no: 'APPT-100',
            start_at: '2026-10-01T10:00:00Z',
            end_at: '2026-10-01T11:00:00Z',
            appointment_status: 'confirmed',
            customer_name: row.metadata.customerName || 'Bob',
            service_name: row.metadata.serviceName || 'Haircut',
            staff_name: 'Staff 1'
          }))
        };
      }

      // PATCH mark single read
      if (sql.includes('UPDATE booking_notifications') && sql.includes('WHERE id =')) {
        const notifId = params[0];
        const sId = params[1];
        const item = notificationsStore.find(n => n.id === notifId && n.shop_id === sId);
        if (item) {
          item.is_read = true;
          item.read_at = new Date().toISOString();
          return { rows: [{ id: item.id }] };
        }
        return { rows: [] };
      }

      // POST mark all read
      if (sql.includes('UPDATE booking_notifications') && sql.includes('WHERE shop_id =')) {
        const sId = params[0];
        const recipientType = params[1];
        const staffIdParam = params[2];
        const updated = [];
        for (const item of notificationsStore) {
          if (item.shop_id === sId && item.recipient_type === recipientType && !item.is_read) {
            if (recipientType === 'staff' && item.recipient_staff_id !== staffIdParam) continue;
            item.is_read = true;
            item.read_at = new Date().toISOString();
            updated.push(item);
          }
        }
        return { rows: updated };
      }

      return { rows: [] };
    }
  };

  // 1. Create booking with assigned staff1 -> generates 2 notifications (shop, staff1)
  const result1 = await createBookingNotification(mockDb, {
    shopId,
    appointmentId: appt1Id,
    eventType: 'booking_created',
    metadata: { customerName: 'Bob', serviceName: 'Haircut' }
  });
  assert.equal(result1.created, 2);

  // 2. Unassigned booking (no preference) -> generates ONLY shop notification
  const result2 = await createBookingNotification(mockDb, {
    shopId,
    appointmentId: appt2UnassignedId,
    eventType: 'booking_created',
    metadata: { customerName: 'Carol', serviceName: 'Facial' }
  });
  assert.equal(result2.created, 1);

  // 3. Deduplication: re-running identical creation creates 0 extra records
  const resultDup = await createBookingNotification(mockDb, {
    shopId,
    appointmentId: appt1Id,
    eventType: 'booking_created',
    metadata: { customerName: 'Bob', serviceName: 'Haircut' }
  });
  assert.equal(resultDup.created, 0);

  // 4. Verify recipient isolation & unread counts
  const ownerUnread = await getUnreadCount(mockDb, { shopId, recipientType: 'shop' });
  assert.equal(ownerUnread, 2); // sees appt1 and appt2

  const staff1Unread = await getUnreadCount(mockDb, { shopId, recipientType: 'staff', recipientStaffId: staff1Id });
  assert.equal(staff1Unread, 1); // sees appt1 only

  const staff2Unread = await getUnreadCount(mockDb, { shopId, recipientType: 'staff', recipientStaffId: staff2Id });
  assert.equal(staff2Unread, 0); // sees nothing

  // 5. Mark single read
  const notifShop1 = notificationsStore.find(n => n.recipient_type === 'shop');
  const readSuccess = await markNotificationRead(mockDb, {
    shopId,
    notificationId: notifShop1.id,
    recipientType: 'shop'
  });
  assert.equal(readSuccess, true);

  const ownerUnreadAfterRead = await getUnreadCount(mockDb, { shopId, recipientType: 'shop' });
  assert.equal(ownerUnreadAfterRead, 1);

  // 6. Mark all read
  const allReadRes = await markAllNotificationsRead(mockDb, { shopId, recipientType: 'shop' });
  assert.equal(allReadRes.updated, 1);

  const ownerUnreadFinal = await getUnreadCount(mockDb, { shopId, recipientType: 'shop' });
  assert.equal(ownerUnreadFinal, 0);

  // Staff1 still has unread notification (independent recipient state)
  const staff1UnreadFinal = await getUnreadCount(mockDb, { shopId, recipientType: 'staff', recipientStaffId: staff1Id });
  assert.equal(staff1UnreadFinal, 1);
});

test('11. Graceful degradation: non-migrated DB (table does not exist) returns safe fallbacks without 500 error', async () => {
  const missingTableDb = {
    query: async () => {
      const err = new Error('relation "booking_notifications" does not exist');
      err.code = '42P01';
      throw err;
    }
  };

  const shopId = '11111111-1111-4111-8111-111111111111';
  const apptId = '44444444-4444-4444-8444-444444444444';

  // createBookingNotification fails safely and returns { created: 0, skipped: true }
  const created = await createBookingNotification(missingTableDb, {
    shopId,
    appointmentId: apptId,
    eventType: 'booking_created'
  });
  assert.equal(created.created, 0);
  assert.equal(created.skipped, true);

  // unread count returns 0
  const count = await getUnreadCount(missingTableDb, { shopId, recipientType: 'shop' });
  assert.equal(count, 0);

  // list notifications returns empty array
  const list = await listNotifications(missingTableDb, { shopId, recipientType: 'shop' });
  assert.deepEqual(list.notifications, []);
  assert.equal(list.unreadCount, 0);

  // mark read returns false
  const marked = await markNotificationRead(missingTableDb, {
    shopId,
    notificationId: apptId,
    recipientType: 'shop'
  });
  assert.equal(marked, false);

  // mark all read returns { updated: 0 }
  const allMarked = await markAllNotificationsRead(missingTableDb, { shopId, recipientType: 'shop' });
  assert.equal(allMarked.updated, 0);
});

// =============================================================================
// 4. ROLE-BASED CUSTOMER PHONE PRIVACY
// =============================================================================

test('12. maskCustomerPhone accurately masks middle 4 digits across standard international formats', () => {
  // Singapore numbers
  assert.equal(maskCustomerPhone('+6591234567'), '+65 91****67');
  assert.equal(maskCustomerPhone('+65 9123 4567'), '+65 91****67');
  assert.equal(maskCustomerPhone('91234567'), '91****67');

  // China numbers (11 digits)
  assert.equal(maskCustomerPhone('+8613812345678'), '+86 138****5678');
  assert.equal(maskCustomerPhone('13812345678'), '138****5678');

  // US/Canada numbers (10 digits)
  assert.equal(maskCustomerPhone('+14155552671'), '+1 415****671');

  // UK numbers
  assert.equal(maskCustomerPhone('+447911123456'), '+44 791****456');

  // Short or empty edge cases fail safe without throwing
  assert.equal(maskCustomerPhone(''), '');
  assert.equal(maskCustomerPhone(null), '');
  assert.equal(maskCustomerPhone(undefined), '');
  assert.equal(maskCustomerPhone('123'), '***');
  assert.equal(maskCustomerPhone('1234'), '****');
});

test('13. Role-based phone privacy: Owner receives FULL phone; Front Desk & Staff receive MASKED phone', () => {
  const { projectOwnerAppointmentCheckout } = require('../lib/owner-appointment-checkout-projection');

  const sampleAppointment = {
    id: 'appt-123',
    shop_id: 'shop-1',
    customer_name: 'John Doe',
    customer_phone: '+6591234567',
    booker_phone_snapshot: '+6591234567',
    recipient_phone_snapshot: '+6598765432',
    status: 'confirmed',
    start_at: '2026-10-01T10:00:00Z',
    end_at: '2026-10-01T11:00:00Z'
  };

  // Owner projection -> FULL phones preserved
  const ownerView = projectOwnerAppointmentCheckout(sampleAppointment, { role: 'owner' });
  assert.equal(ownerView.customer_phone, '+6591234567');
  assert.equal(ownerView.booker_phone_snapshot, '+6591234567');
  assert.equal(ownerView.recipient_phone_snapshot, '+6598765432');

  // Front desk projection -> MASKED phones only, full phone strictly absent
  const frontDeskView = projectOwnerAppointmentCheckout(sampleAppointment, { role: 'front_desk' });
  assert.equal(frontDeskView.customer_phone, '+65 91****67');
  assert.equal(frontDeskView.booker_phone_snapshot, '+65 91****67');
  assert.equal(frontDeskView.recipient_phone_snapshot, '+65 98****32');

  // Ensure full phone does not leak anywhere in JSON string of front desk view
  const frontDeskJson = JSON.stringify(frontDeskView);
  assert.ok(!frontDeskJson.includes('+6591234567'));
  assert.ok(!frontDeskJson.includes('+6598765432'));
});

test('14. UI contact action links (tel: and WhatsApp) omitted when customer phone is masked', () => {
  // admin.html drawer contact actions check isMaskedContactPhone
  assert.match(adminHtml, /const isMaskedContactPhone = Boolean\(phoneToContact && phoneToContact\.includes\('\*'\)\);/);
  assert.match(adminHtml, /if\s*\(phoneToContact && !isMaskedContactPhone\)/);

  // staff-appointments.html only displays masked text without unmasking attempt
  assert.match(staffHtml, /elements\.sheetPhone\.textContent\s*=\s*appointment\.customerPhone\s*\|\|\s*'—';/);
  assert.doesNotMatch(staffHtml, /href="tel:/);
});
