'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  membership: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
});

const ownerSession = role => ({
  owner_account_id: ID.ownerAccount,
  membership_id: ID.membership,
  shop_id: ID.shop,
  login_identifier: `${role}-user`,
  display_name: role,
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const makeFixture = ({ role, failNotifications = false } = {}) => {
  const state = {
    committed: false,
    released: false,
    connectCount: 0,
    notificationAfterCommit: true,
    notifications: [],
    histories: []
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (normalized === 'BEGIN') return { rows: [] };
      if (normalized === 'COMMIT') {
        state.committed = true;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK' || /^SET LOCAL lock_timeout/.test(normalized)) {
        return { rows: [] };
      }
      if (/SELECT location\.id AS location_id/.test(normalized)) {
        assert.deepEqual(params, [ID.location, ID.shop]);
        return { rows: [{ location_id: ID.location, timezone: 'Asia/Singapore' }] };
      }
      if (/SELECT service\.id, service\.duration_minutes/.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.deepEqual(params[1], [ID.service]);
        return { rows: [{
          id: ID.service,
          duration_minutes: 60,
          price: '88.00',
          price_is_from: false,
          localized_name: 'Service A'
        }] };
      }
      if (/SELECT TO_CHAR/.test(normalized)) {
        assert.equal(params[2], ID.location);
        assert.equal(params[3], ID.shop);
        return { rows: [{ start_at: '2030-01-02T02:00:00.000000Z' }] };
      }
      if (/SELECT id FROM customers WHERE shop_id=\$1 AND phone_normalized=\$2/.test(normalized)) {
        assert.deepEqual(params, [ID.shop, '+6591234567']);
        return { rows: [] };
      }
      if (/INSERT INTO customers/.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.equal(params[2], '+6591234567');
        assert.equal(params[4], '+6591234567');
        return { rows: [{ id: ID.customer }] };
      }
      if (/INSERT INTO appointments/.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.equal(params[1], ID.location);
        assert.equal(params[7], ID.assignedStaff);
        return { rows: [{
          id: ID.appointment,
          shop_id: ID.shop,
          location_id: ID.location,
          customer_id: ID.customer,
          appointment_no: 'A-100',
          start_at: '2030-01-02T02:00:00.000Z',
          end_at: '2030-01-02T03:00:00.000Z',
          status: 'pending',
          override_conflict: false,
          created_at: '2030-01-01T00:00:00.000Z'
        }] };
      }
      if (/INSERT INTO appointment_items/.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.equal(params[2], ID.appointment);
        return { rows: [{ id: ID.item }] };
      }
      if (/INSERT INTO appointment_item_staff_assignments/.test(normalized)) {
        assert.equal(params[0], ID.shop);
        assert.equal(params[2], ID.item);
        assert.equal(params[3], ID.assignedStaff);
        return { rows: [{ id: ID.assignment }] };
      }
      if (/^UPDATE appointments SET status=\$1/.test(normalized)) {
        assert.equal(params[2], ID.shop);
        return { rows: [] };
      }
      if (/^UPDATE appointment_items SET status=\$1/.test(normalized)) {
        assert.equal(params[1], ID.shop);
        return { rows: [] };
      }
      if (/INSERT INTO appointment_status_history/.test(normalized)) {
        state.histories.push({
          shopId: params[0],
          appointmentId: params[1],
          fromStatus: params[2],
          toStatus: params[3],
          operatorId: params[5],
          source: params[6]
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected transaction SQL: ${normalized}`);
    },
    release() {
      state.released = true;
    }
  };

  const pool = {
    async query(sql, params = []) {
      if (/FROM owner_sessions session/.test(sql)) {
        return { rows: [ownerSession(role || 'owner')] };
      }
      if (/SELECT DISTINCT x\.staff_id/.test(sql)) {
        state.notificationAfterCommit &&= state.committed;
        if (failNotifications) throw new Error('notification delivery unavailable');
        assert.deepEqual(params, [ID.shop, ID.appointment]);
        return { rows: [{ staff_id: ID.assignedStaff }] };
      }
      if (/INSERT INTO booking_notifications/.test(sql)) {
        state.notificationAfterCommit &&= state.committed;
        const staffRecipient = sql.includes("'staff'");
        state.notifications.push({
          shopId: params[0],
          appointmentId: params[1],
          eventType: params[2],
          recipientType: staffRecipient ? 'staff' : 'shop',
          recipientStaffId: staffRecipient ? params[3] : null,
          dedupeKey: staffRecipient ? params[4] : params[3]
        });
        return { rows: [{ id: `notification-${state.notifications.length}` }] };
      }
      throw new Error(`Unexpected pool SQL: ${sql.trim()}`);
    },
    async connect() {
      state.connectCount += 1;
      return client;
    }
  };

  return { pool, state };
};

const requestBody = staffSelectionType => ({
  shop_id: ID.otherShop,
  locationId: ID.location,
  date: '2030-01-02',
  time: '10:00',
  locale: 'en',
  customer: {
    name: 'Customer A',
    phone: '91234567',
    countryCode: 'SG'
  },
  items: [{
    serviceId: ID.service,
    staffSelectionType,
    ...(staffSelectionType === 'specific' ? { staffId: ID.assignedStaff } : {})
  }]
});

const withFixtureServer = async (fixture, operation) => {
  const previousOwnerAuthPool = app.locals.ownerAuthPool;
  const previousBookingValidator = app.locals.bookingValidator;
  const previousBookingNow = app.locals.bookingNow;
  app.locals.ownerAuthPool = fixture.pool;
  app.locals.bookingValidator = async () => true;
  app.locals.bookingNow = new Date('2029-12-31T00:00:00.000Z');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.ownerAuthPool = previousOwnerAuthPool;
    app.locals.bookingValidator = previousBookingValidator;
    app.locals.bookingNow = previousBookingNow;
  }
};

const createAppointment = async (fixture, endpoint, body = requestBody('specific')) =>
  withFixtureServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'gg_beauty_owner_session=test-token'
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  });

test('owner assisted and front-desk walk-in creation emit tenant-scoped shop and assigned-staff notifications after commit', async () => {
  for (const scenario of [
    { role: 'owner', endpoint: '/api/owner/assisted-appointments', source: 'assisted', finalStatus: 'confirmed' },
    { role: 'front_desk', endpoint: '/api/owner/walk-in-appointments', source: 'walk_in', finalStatus: 'arrived' }
  ]) {
    const fixture = makeFixture({ role: scenario.role });
    const result = await createAppointment(fixture, scenario.endpoint);

    assert.equal(result.status, 201, `${scenario.role} creation must succeed`);
    assert.equal(result.body.data.id, ID.appointment);
    assert.equal(result.body.data.shop_id, ID.shop);
    assert.equal(result.body.data.status, scenario.finalStatus);
    assert.equal(fixture.state.committed, true);
    assert.equal(fixture.state.released, true);
    assert.equal(fixture.state.notificationAfterCommit, true);
    assert.deepEqual(
      fixture.state.notifications.map(notification => notification.recipientType).sort(),
      ['shop', 'staff']
    );
    assert.equal(
      fixture.state.notifications.every(notification =>
        notification.shopId === ID.shop &&
        notification.appointmentId === ID.appointment &&
        notification.eventType === 'booking_created'
      ),
      true
    );
    assert.equal(
      fixture.state.notifications.some(notification =>
        notification.recipientType === 'staff' &&
        notification.recipientStaffId === ID.assignedStaff &&
        notification.dedupeKey.includes(`:${scenario.source}:staff:${ID.assignedStaff}`)
      ),
      true
    );
    assert.equal(
      fixture.state.notifications.some(notification => notification.recipientStaffId === ID.unrelatedStaff),
      false
    );
  }
});

test('assisted no-preference input fails before booking and never broadcasts a staff notification', async () => {
  const fixture = makeFixture({ role: 'front_desk' });
  const result = await createAppointment(
    fixture,
    '/api/owner/assisted-appointments',
    requestBody('no_preference')
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'WALK_IN_STAFF_REQUIRED');
  assert.equal(fixture.state.connectCount, 0);
  assert.deepEqual(fixture.state.notifications, []);
});

test('post-commit notification failure does not roll back a successfully created assisted booking', async () => {
  const fixture = makeFixture({ role: 'owner', failNotifications: true });
  const result = await createAppointment(fixture, '/api/owner/assisted-appointments');

  assert.equal(result.status, 201);
  assert.equal(result.body.data.id, ID.appointment);
  assert.equal(fixture.state.committed, true);
  assert.equal(fixture.state.released, true);
  assert.deepEqual(fixture.state.notifications, []);
});
