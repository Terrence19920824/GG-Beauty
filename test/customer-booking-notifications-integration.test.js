'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { app } = require('../server');

const ID = Object.freeze({
  shop: '11111111-1111-4111-8111-111111111111',
  otherShop: '21111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  service: '33333333-3333-4333-8333-333333333333',
  assignedStaff: '44444444-4444-4444-8444-444444444444',
  unrelatedStaff: '55555555-5555-4555-8555-555555555555',
  customer: '66666666-6666-4666-8666-666666666666',
  appointment: '77777777-7777-4777-8777-777777777777',
  item: '88888888-8888-4888-8888-888888888888',
  assignment: '99999999-9999-4999-8999-999999999999',
  ownerAccount: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  frontDeskAccount: 'bbbbbbbb-bbbb-4bbb-8bbb-aaaaaaaaaaaa',
  membershipOwner: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  membershipFrontDesk: 'cccccccc-cccc-4ccc-8ccc-bbbbbbbbbbbb',
  staffAccount: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
});

const ownerSession = role => ({
  owner_account_id: role === 'front_desk' ? ID.frontDeskAccount : ID.ownerAccount,
  membership_id: role === 'front_desk' ? ID.membershipFrontDesk : ID.membershipOwner,
  shop_id: ID.shop,
  login_identifier: `${role}-user`,
  display_name: role === 'front_desk' ? 'Front Desk Staff' : 'Store Owner',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const staffSession = staffId => ({
  staff_account_id: ID.staffAccount,
  shop_id: ID.shop,
  staff_id: staffId,
  location_id: ID.location,
  can_update_own_appointment_status: true,
  can_view_customer_history: false,
  can_view_service_notes: false,
  can_view_own_sales: false,
  can_view_own_commission: false,
  can_view_full_customer_phone: false,
  can_move_own_appointments: false
});

const makeFixture = ({
  assignedStaff = ID.assignedStaff,
  failNotifications = false
} = {}) => {
  const state = {
    committed: false,
    rolledBack: false,
    released: false,
    connectCount: 0,
    notificationAfterCommit: true,
    notifications: [],
    notificationKeys: new Set()
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (normalized === 'BEGIN') return { rows: [] };
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/^SET LOCAL/.test(normalized)) {
        return { rows: [] };
      }
      if (/SELECT shop\.id AS shop_id/.test(normalized)) {
        return { rows: [{
          shop_id: ID.shop,
          shop_slug: 'shop-a',
          location_id: ID.location,
          timezone: 'Asia/Singapore'
        }] };
      }
      if (/service\.id=ANY/.test(normalized)) {
        return { rows: [{
          id: ID.service,
          duration_minutes: 60,
          price: '88.00',
          price_is_from: false,
          category_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          localized_name: 'Basic Facial'
        }] };
      }
      if (/assigned_appointment_count/.test(normalized)) {
        return { rows: [{
          staff_id: assignedStaff,
          display_name: 'Guanguan',
          assigned_appointment_count: 0
        }] };
      }
      if (/SELECT id FROM customers/.test(normalized)) {
        return { rows: [{ id: ID.customer }] };
      }
      if (/SELECT id, name, phone, phone_normalized, email, phone_verified_at/.test(normalized)) {
        return { rows: [{
          id: ID.customer,
          name: 'Release Smoke Customer',
          phone: '+6591234567',
          phone_normalized: '+6591234567',
          email: 'smoke@example.invalid',
          phone_verified_at: null
        }] };
      }
      if (/INSERT INTO appointments/.test(normalized)) {
        return { rows: [{
          id: ID.appointment,
          shop_id: ID.shop,
          location_id: ID.location,
          customer_id: ID.customer,
          service_id: ID.service,
          staff_id: assignedStaff,
          appointment_no: 'GG-SMOKE-01',
          start_at: '2030-01-07T09:30:00.000Z',
          end_at: '2030-01-07T10:30:00.000Z',
          status: 'pending',
          created_at: '2030-01-01T00:00:00.000Z'
        }] };
      }
      if (/INSERT INTO appointment_items/.test(normalized)) {
        return { rows: [{ id: ID.item }] };
      }
      if (/INSERT INTO appointment_item_staff_assignments/.test(normalized)) {
        return { rows: [{ id: ID.assignment }] };
      }
      throw new Error(`Unexpected transaction SQL: ${normalized}`);
    },
    release() {
      state.released = true;
    }
  };

  const pool = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (/FROM owner_sessions session/.test(normalized)) {
        const ownerTokenHash = crypto.createHash('sha256').update('test-owner-token').digest('hex');
        const frontDeskTokenHash = crypto.createHash('sha256').update('test-front-desk-token').digest('hex');
        if (params[0] === ownerTokenHash) {
          return { rows: [ownerSession('owner')] };
        }
        if (params[0] === frontDeskTokenHash) {
          return { rows: [ownerSession('front_desk')] };
        }
        return { rows: [] };
      }
      if (/FROM staff_sessions/.test(normalized)) {
        const assignedStaffTokenHash = crypto.createHash('sha256').update('assigned-token').digest('hex');
        const unrelatedStaffTokenHash = crypto.createHash('sha256').update('unrelated-token').digest('hex');
        if (params[0] === unrelatedStaffTokenHash) {
          return { rows: [staffSession(ID.unrelatedStaff)] };
        }
        if (params[0] === assignedStaffTokenHash) {
          return { rows: [staffSession(assignedStaff)] };
        }
        return { rows: [] };
      }
      if (/SELECT DISTINCT x\.staff_id/.test(normalized)) {
        state.notificationAfterCommit &&= state.committed;
        if (failNotifications) {
          throw new Error('notification database connection failure');
        }
        assert.deepEqual(params, [ID.shop, ID.appointment]);
        return { rows: assignedStaff ? [{ staff_id: assignedStaff }] : [] };
      }
      if (/INSERT INTO booking_notifications/.test(normalized)) {
        state.notificationAfterCommit &&= state.committed;
        const isStaff = normalized.includes("'staff'");
        const dedupeKey = isStaff ? params[4] : params[3];
        if (state.notificationKeys.has(dedupeKey)) {
          return { rows: [] };
        }
        state.notificationKeys.add(dedupeKey);
        const notification = {
          id: `notification-${state.notifications.length + 1}`,
          shopId: params[0],
          appointmentId: params[1],
          eventType: params[2],
          recipientType: isStaff ? 'staff' : 'shop',
          recipientStaffId: isStaff ? params[3] : null,
          dedupeKey,
          isRead: false,
          readAt: null,
          createdAt: new Date().toISOString()
        };
        state.notifications.push(notification);
        return { rows: [{ id: notification.id }] };
      }
      if (/SELECT\s+COUNT\(\*\)::INTEGER\s+AS\s+count\s+FROM\s+booking_notifications/i.test(normalized)) {
        const [targetShopId, targetRecipientType, targetRecipientStaffId] = params;
        const count = state.notifications.filter(n =>
          n.shopId === targetShopId &&
          n.recipientType === targetRecipientType &&
          (!targetRecipientStaffId || n.recipientStaffId === targetRecipientStaffId) &&
          !n.isRead
        ).length;
        return { rows: [{ count }] };
      }
      if (/SELECT\s+n\.id,\s+n\.shop_id,\s+n\.appointment_id.*FROM\s+booking_notifications\s+n/is.test(normalized)) {
        const [targetShopId, targetRecipientType, targetRecipientStaffId] = params;
        const matched = state.notifications.filter(n =>
          n.shopId === targetShopId &&
          n.recipientType === targetRecipientType &&
          (!targetRecipientStaffId || n.recipientStaffId === targetRecipientStaffId)
        );
        return { rows: matched.map(n => ({
          id: n.id,
          shop_id: n.shopId,
          appointment_id: n.appointmentId,
          event_type: n.eventType,
          recipient_type: n.recipientType,
          recipient_staff_id: n.recipientStaffId,
          is_read: n.isRead,
          read_at: n.readAt,
          created_at: n.createdAt,
          metadata: {},
          appointment_no: 'GG-SMOKE-01',
          start_at: '2030-01-07T09:30:00.000Z',
          end_at: '2030-01-07T10:30:00.000Z',
          appointment_status: 'pending',
          customer_name: 'Release Smoke Customer',
          service_name: 'Basic Facial',
          staff_name: 'Guanguan'
        })) };
      }
      if (/FROM locations location WHERE/.test(normalized)) {
        return { rows: [{ timezone: 'Asia/Singapore' }] };
      }
      if (/FROM appointments appt/.test(normalized)) {
        return { rows: [{
          id: ID.appointment,
          shop_id: ID.shop,
          appointment_no: 'GG-SMOKE-01',
          start_at: '2030-01-07T09:30:00.000Z',
          end_at: '2030-01-07T10:30:00.000Z',
          timezone: 'Asia/Singapore',
          shop_name: 'Shop A'
        }] };
      }
      if (/FROM appointment_items item/.test(normalized)) {
        return { rows: [{
          service_name: 'Basic Facial',
          staff_name: 'Guanguan',
          start_at: '2030-01-07T09:30:00.000Z',
          end_at: '2030-01-07T10:30:00.000Z'
        }] };
      }
      throw new Error(`Unexpected pool SQL: ${normalized}`);
    },
    async connect() {
      state.connectCount += 1;
      return client;
    }
  };

  return { pool, state };
};

const customerBookingPayload = (staffSelectionType = 'specific', staffId = ID.assignedStaff) => ({
  shopSlug: 'shop-a',
  locale: 'zh-CN',
  startAt: '2030-01-07T09:30:00.000Z',
  customerName: 'Release Smoke Customer',
  phone: '+6591234567',
  countryCode: 'SG',
  email: 'smoke@example.invalid',
  items: [
    {
      serviceId: ID.service,
      staffSelectionType,
      ...(staffSelectionType === 'specific' ? { staffId } : {})
    }
  ]
});

const withServer = async (fixture, operation) => {
  const previousBookingPool = app.locals.bookingPool;
  const previousOwnerAuthPool = app.locals.ownerAuthPool;
  const previousBookingValidator = app.locals.bookingValidator;
  const previousBookingNow = app.locals.bookingNow;

  app.locals.bookingPool = fixture.pool;
  app.locals.ownerAuthPool = fixture.pool;
  app.locals.bookingValidator = async () => true;
  app.locals.bookingNow = new Date('2029-12-31T00:00:00.000Z');

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.bookingPool = previousBookingPool;
    app.locals.ownerAuthPool = previousOwnerAuthPool;
    app.locals.bookingValidator = previousBookingValidator;
    app.locals.bookingNow = previousBookingNow;
  }
};

const postBooking = async (baseUrl, payload = customerBookingPayload()) => {
  const response = await fetch(`${baseUrl}/api/new-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: response.status, data: await response.json() };
};

test('1. Standard customer POST /api/new-db with specific staff creates shop and assigned staff notifications after commit', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    const result = await postBooking(baseUrl, customerBookingPayload('specific', ID.assignedStaff));

    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.id, ID.appointment);
    assert.equal(fixture.state.committed, true);
    assert.equal(fixture.state.notificationAfterCommit, true);

    // Exactly 2 notifications: 1 shop, 1 staff
    assert.equal(fixture.state.notifications.length, 2);

    const shopNotif = fixture.state.notifications.find(n => n.recipientType === 'shop');
    assert.ok(shopNotif, 'shop notification must exist');
    assert.equal(shopNotif.shopId, ID.shop);
    assert.equal(shopNotif.appointmentId, ID.appointment);
    assert.equal(shopNotif.eventType, 'booking_created');
    assert.equal(shopNotif.recipientStaffId, null);
    assert.equal(shopNotif.dedupeKey, `booking_created:${ID.appointment}:customer_booking_${ID.appointment}:shop`);

    const staffNotif = fixture.state.notifications.find(n => n.recipientType === 'staff');
    assert.ok(staffNotif, 'staff notification must exist for assigned staff');
    assert.equal(staffNotif.shopId, ID.shop);
    assert.equal(staffNotif.appointmentId, ID.appointment);
    assert.equal(staffNotif.eventType, 'booking_created');
    assert.equal(staffNotif.recipientStaffId, ID.assignedStaff);
    assert.equal(staffNotif.dedupeKey, `booking_created:${ID.appointment}:customer_booking_${ID.appointment}:staff:${ID.assignedStaff}`);
  });
});

test('2. Canonical no-preference customer booking follows authoritative staff assignment: emits shop and assigned staff notifications', async () => {
  // "No preference" request without staffId: engine allocates eligible staff member ID.assignedStaff
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    const result = await postBooking(baseUrl, customerBookingPayload('no_preference'));

    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.id, ID.appointment);
    assert.equal(fixture.state.committed, true);

    // Authoritative notification behavior: 1 shop notification + 1 staff notification for ACTUALLY ASSIGNED staff
    assert.equal(fixture.state.notifications.length, 2);

    const shopNotif = fixture.state.notifications.find(n => n.recipientType === 'shop');
    assert.ok(shopNotif, 'shop notification must exist for no-preference booking');
    assert.equal(shopNotif.recipientType, 'shop');
    assert.equal(shopNotif.recipientStaffId, null);

    const staffNotif = fixture.state.notifications.find(n => n.recipientType === 'staff');
    assert.ok(staffNotif, 'notification must be created for authoritatively assigned staff member');
    assert.equal(staffNotif.recipientStaffId, ID.assignedStaff);

    // Zero notifications for unrelated staff
    assert.equal(fixture.state.notifications.some(n => n.recipientStaffId === ID.unrelatedStaff), false);
  });
});

test('3. Deduplication prevents duplicate notification rows on repeated execution', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    // First booking
    const result1 = await postBooking(baseUrl);
    assert.equal(result1.status, 200);
    assert.equal(fixture.state.notifications.length, 2);

    // Simulate same dedupe keys re-attempted
    const pool = fixture.pool;
    const { createBookingNotification } = require('../lib/booking-notifications');
    const replay = await createBookingNotification(pool, {
      shopId: ID.shop,
      appointmentId: ID.appointment,
      eventType: 'booking_created',
      dedupeSource: `customer_booking_${ID.appointment}`
    });
    assert.equal(replay.created, 0, 'Replayed identical event must create 0 new notifications');
    assert.equal(fixture.state.notifications.length, 2);
  });
});

test('4. Notification delivery/database failure does not roll back or fail a successful booking', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff, failNotifications: true });
  await withServer(fixture, async baseUrl => {
    const result = await postBooking(baseUrl);

    // Booking must succeed with 200 despite notification failure
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.id, ID.appointment);
    assert.equal(fixture.state.committed, true);
    assert.equal(fixture.state.rolledBack, false);
    assert.equal(fixture.state.notifications.length, 0);
  });
});

test('5. Owner notification endpoint reads authoritative shop notification', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    // Make customer booking
    await postBooking(baseUrl);

    // Read unread count via owner endpoint
    const unreadCountRes = await fetch(`${baseUrl}/api/owner/notifications/unread-count`, {
      headers: { Cookie: 'gg_beauty_owner_session=test-owner-token' }
    });
    assert.equal(unreadCountRes.status, 200);
    const unreadCountJson = await unreadCountRes.json();
    assert.equal(unreadCountJson.success, true);
    assert.equal(unreadCountJson.data.unreadCount, 1);

    // Read notifications list via owner endpoint
    const listRes = await fetch(`${baseUrl}/api/owner/notifications`, {
      headers: { Cookie: 'gg_beauty_owner_session=test-owner-token' }
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.success, true);
    assert.equal(listJson.data.notifications.length, 1);
    assert.equal(listJson.data.notifications[0].appointmentId, ID.appointment);
    assert.equal(listJson.data.notifications[0].eventType, 'booking_created');
  });
});

test('6. REAL Front Desk session reads the exact same authoritative shop notification (no duplicate rows created)', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    // Make customer booking
    await postBooking(baseUrl);

    // Ensure database contains exactly ONE shop notification row
    const shopRows = fixture.state.notifications.filter(n => n.recipientType === 'shop');
    assert.equal(shopRows.length, 1, 'Only one authoritative shop notification must exist');

    // Read via REAL Front Desk session (authenticated with role: front_desk)
    const frontDeskCountRes = await fetch(`${baseUrl}/api/owner/notifications/unread-count`, {
      headers: { Cookie: 'gg_beauty_owner_session=test-front-desk-token' }
    });
    assert.equal(frontDeskCountRes.status, 200);
    const frontDeskCountJson = await frontDeskCountRes.json();
    assert.equal(frontDeskCountJson.success, true);
    assert.equal(frontDeskCountJson.data.unreadCount, 1);

    const frontDeskListRes = await fetch(`${baseUrl}/api/owner/notifications`, {
      headers: { Cookie: 'gg_beauty_owner_session=test-front-desk-token' }
    });
    assert.equal(frontDeskListRes.status, 200);
    const frontDeskListJson = await frontDeskListRes.json();
    assert.equal(frontDeskListJson.success, true);
    assert.equal(frontDeskListJson.data.notifications.length, 1);
    assert.equal(frontDeskListJson.data.notifications[0].id, shopRows[0].id, 'Front Desk must see the same notification ID as Owner');
    assert.equal(frontDeskListJson.data.notifications[0].appointmentId, ID.appointment);

    // Database still has exactly ONE shop notification row (no duplicate rows created for front desk)
    assert.equal(fixture.state.notifications.filter(n => n.recipientType === 'shop').length, 1);
  });
});

test('7. Staff notification endpoint shows unread notification for assigned staff; unrelated staff sees zero', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    // Make customer booking
    await postBooking(baseUrl);

    // Read via assigned staff endpoint
    const staffCountRes = await fetch(`${baseUrl}/api/staff/notifications/unread-count`, {
      headers: { Cookie: 'gg_beauty_staff_session=assigned-token' }
    });
    assert.equal(staffCountRes.status, 200);
    const staffCountJson = await staffCountRes.json();
    assert.equal(staffCountJson.success, true);
    assert.equal(staffCountJson.data.unreadCount, 1);

    // Read notifications list via staff endpoint
    const staffListRes = await fetch(`${baseUrl}/api/staff/notifications`, {
      headers: { Cookie: 'gg_beauty_staff_session=assigned-token' }
    });
    assert.equal(staffListRes.status, 200);
    const staffListJson = await staffListRes.json();
    assert.equal(staffListJson.success, true);
    assert.equal(staffListJson.data.notifications.length, 1);
    assert.equal(staffListJson.data.notifications[0].appointmentId, ID.appointment);

    // Read via unrelated staff endpoint (unrelated staff has 0 unread)
    const unrelatedCountRes = await fetch(`${baseUrl}/api/staff/notifications/unread-count`, {
      headers: { Cookie: 'gg_beauty_staff_session=unrelated-token' }
    });
    assert.equal(unrelatedCountRes.status, 200);
    const unrelatedCountJson = await unrelatedCountRes.json();
    assert.equal(unrelatedCountJson.success, true);
    assert.equal(unrelatedCountJson.data.unreadCount, 0);

    const unrelatedListRes = await fetch(`${baseUrl}/api/staff/notifications`, {
      headers: { Cookie: 'gg_beauty_staff_session=unrelated-token' }
    });
    assert.equal(unrelatedListRes.status, 200);
    const unrelatedListJson = await unrelatedListRes.json();
    assert.equal(unrelatedListJson.success, true);
    assert.equal(unrelatedListJson.data.notifications.length, 0);
  });
});

test('8. Tenant isolation: notification queries for unrelated shop return zero records', async () => {
  const fixture = makeFixture({ assignedStaff: ID.assignedStaff });
  await withServer(fixture, async baseUrl => {
    await postBooking(baseUrl);

    const { listNotifications, getUnreadCount } = require('../lib/booking-notifications');
    const otherShopCount = await getUnreadCount(fixture.pool, {
      shopId: ID.otherShop,
      recipientType: 'shop'
    });
    assert.equal(otherShopCount, 0);

    const otherShopList = await listNotifications(fixture.pool, {
      shopId: ID.otherShop,
      recipientType: 'shop'
    });
    assert.deepEqual(otherShopList.notifications, []);
  });
});
