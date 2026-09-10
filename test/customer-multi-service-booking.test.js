'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MultiServicePlanningError,
  normalizeBookingItems,
  buildSequentialTimeline,
  planStaffAssignments,
  cartTotals
} = require('../lib/customer-multi-service-booking');
const cart = require('../public/customer-multi-service-cart');

const UUID = {
  serviceA: '11111111-1111-4111-8111-111111111111',
  serviceB: '22222222-2222-4222-8222-222222222222',
  staffA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  staffB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};
const isUuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

test('legacy item request adapts to one stable item without trusting display data', () => {
  assert.deepEqual(normalizeBookingItems({ serviceId: UUID.serviceA, staffId: UUID.staffA }, isUuid), [{
    clientItemKey: 'item-1', serviceId: UUID.serviceA,
    staffSelectionType: 'specific', staffId: UUID.staffA
  }]);
});

test('sequential timeline uses authoritative durations and stable sequence numbers', () => {
  const result = buildSequentialTimeline([
    { serviceId: UUID.serviceA, duration_minutes: 60 },
    { serviceId: UUID.serviceB, duration_minutes: 180 }
  ], '2030-01-07T02:00:00.000Z');
  assert.deepEqual(result.map(item => [item.sequenceNo, item.startAt, item.endAt]), [
    [1, '2030-01-07T02:00:00.000Z', '2030-01-07T03:00:00.000Z'],
    [2, '2030-01-07T03:00:00.000Z', '2030-01-07T06:00:00.000Z']
  ]);
});

test('bounded deterministic planner solves the greedy trap B then A', async () => {
  const items = [
    { serviceId: UUID.serviceA, staffSelectionType: 'no_preference' },
    { serviceId: UUID.serviceB, staffSelectionType: 'no_preference' }
  ];
  const candidates = new Map([
    [UUID.serviceA, [{ staff_id: UUID.staffA }, { staff_id: UUID.staffB }]],
    [UUID.serviceB, [{ staff_id: UUID.staffA }]]
  ]);
  const result = await planStaffAssignments({ items, candidatesByService: candidates,
    validate: async (item, staffId, chosen) => {
      if (item.serviceId === UUID.serviceB && chosen.some(entry => entry.staffId === staffId)) {
        const error = new Error('candidate unavailable'); error.unavailable = true; throw error;
      }
    }
  });
  assert.deepEqual(result.map(item => item.staffId), [UUID.staffB, UUID.staffA]);
});

test('specific plus no preference and deterministic candidate order are preserved', async () => {
  const result = await planStaffAssignments({
    items: [
      { serviceId: UUID.serviceA, staffSelectionType: 'specific', staffId: UUID.staffB },
      { serviceId: UUID.serviceB, staffSelectionType: 'no_preference' }
    ],
    candidatesByService: new Map([[UUID.serviceB, [{ staff_id: UUID.staffA }, { staff_id: UUID.staffB }]]]),
    validate: async () => {}
  });
  assert.deepEqual(result.map(item => item.staffId), [UUID.staffB, UUID.staffA]);
});

test('planner returns unavailable and enforces a hard search bound', async () => {
  const item = { serviceId: UUID.serviceA, staffSelectionType: 'no_preference' };
  const candidates = new Map([[UUID.serviceA, [{ staff_id: UUID.staffA }, { staff_id: UUID.staffB }]]]);
  assert.equal(await planStaffAssignments({ items: [item], candidatesByService: candidates,
    validate: async () => { const error = new Error('unavailable'); error.unavailable = true; throw error; }
  }), null);
  await assert.rejects(planStaffAssignments({ items: [item], candidatesByService: candidates,
    maxNodes: 1, validate: async () => { const error = new Error('unavailable'); error.unavailable = true; throw error; }
  }), error => error instanceof MultiServicePlanningError && error.code === 'ASSIGNMENT_SEARCH_LIMIT');
});

test('cart add/remove recalculates totals while stable IDs survive locale display changes', () => {
  let selected = cart.create();
  selected = cart.add(selected, { id: UUID.serviceA, categoryId: 'hair' });
  selected = cart.add(selected, { id: UUID.serviceB, categoryId: 'beauty' });
  selected = cart.updateStaff(selected, selected[0].clientItemKey, 'specific', UUID.staffA);
  const before = cart.requestItems(selected);
  const servicesEn = [
    { id: UUID.serviceA, name: 'Basic Facial', durationMinutes: 60, price: 88, priceIsFrom: false },
    { id: UUID.serviceB, name: 'Balayage', durationMinutes: 180, price: 238, priceIsFrom: true }
  ];
  const servicesZh = servicesEn.map((service, index) => ({ ...service, name: index ? 'Balayage渐层染' : '基础面部护理' }));
  assert.deepEqual(cart.totals(selected, servicesEn), { durationMinutes: 240, listedPrice: 326, priceIsFrom: true });
  assert.deepEqual(cart.requestItems(selected), before);
  assert.deepEqual(cart.totals(selected, servicesZh), cart.totals(selected, servicesEn));
  selected = cart.remove(selected, selected[0].clientItemKey);
  assert.deepEqual(cart.totals(selected, servicesEn), { durationMinutes: 180, listedPrice: 238, priceIsFrom: true });
  assert.equal(cart.requestItems(selected)[0].serviceId, UUID.serviceB);
});

test('server and customer UI retain authoritative transaction and identity boundaries', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const rows = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-multi-service.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(server, /runInTransaction\(req\.app\.locals\.bookingPool/);
  assert.match(server, /service\.id=ANY\(\$2::UUID\[\]\)/);
  assert.match(server, /first\.serviceId[\s\S]*first\.staffId[\s\S]*first\.startAt, last\.endAt/);
  assert.match(rows, /price_snapshot[\s\S]*item\.price/);
  assert.match(rows, /item\.sequenceNo/);
  assert.match(server, /error\.code === '23P01'[\s\S]*BOOKING_NOT_AVAILABLE/);
  assert.match(html, /customer-multi-service-cart\.js/);
  assert.match(html, /\/api\/booking\/multi-service-available-times/);
  assert.match(html, /items: cartApi\.requestItems\(cart\)/);
  assert.match(html, /id="confirmationSummary"/);
  assert.doesNotMatch(html, /shopId\s*:/);
});

test('authoritative cart totals helper marks aggregate as from when any item is from-priced', () => {
  assert.deepEqual(cartTotals([
    { durationMinutes: 60, price: '88', priceIsFrom: false },
    { durationMinutes: 180, price: '238', priceIsFrom: true }
  ]), { durationMinutes: 240, listedPrice: 326, priceIsFrom: true });
});
