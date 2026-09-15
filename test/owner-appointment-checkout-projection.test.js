'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveCheckout,
  projectOwnerAppointmentCheckout,
  toSafeMinor
} = require('../lib/owner-appointment-checkout-projection');

const assignment = (role, suffix) => ({
  assignment_id: `assignment-${suffix}`,
  staff_id: `staff-${suffix}`,
  staff_name: `Staff ${suffix}`,
  role,
  start_at: '2030-01-01T02:00:00Z',
  end_at: '2030-01-01T03:00:00Z'
});

const item = (sequence, overrides = {}) => ({
  item_id: `item-${sequence}`,
  sequence_no: sequence,
  service_id: `service-${sequence}`,
  service_name_snapshot: `Service ${sequence}`,
  service_locale_snapshot: sequence === 1 ? 'en' : 'zh-CN',
  duration_minutes_snapshot: 60,
  price_snapshot_minor: sequence === 1 ? '6000' : '8000',
  start_at: `2030-01-01T0${sequence + 1}:00:00Z`,
  end_at: `2030-01-01T0${sequence + 2}:00:00Z`,
  status: 'in_service',
  staff_assignments: [assignment('primary', sequence)],
  ...overrides
});

const appointment = (overrides = {}) => ({
  id: 'appointment-a',
  appointment_no: 'A-1',
  start_at: '2030-01-01T02:00:00Z',
  end_at: '2030-01-01T04:00:00Z',
  status: 'in_service',
  booking_source: 'online',
  customer_name: 'Customer A',
  customer_phone: '00000000',
  customer_email: 'customer@example.invalid',
  service_name: 'Legacy Service',
  duration_minutes: 120,
  price: '140.00',
  staff_name: 'Legacy Staff',
  staff_code: 'A1',
  staff_assignments: [],
  items: [item(2, {
    staff_assignments: [assignment('primary', '2p'), assignment('assistant', '2a')]
  }), item(1)],
  ...overrides
});

const checkoutRow = (status, overrides = {}) => ({
  checkout_id: 'checkout-a',
  checkout_status: status,
  currency_code: 'SGD',
  checkout_quote_total_minor: '14000',
  checkout_actual_total_minor: '14000',
  checkout_discount_total_minor: '0',
  checkout_final_due_minor: '14000',
  checkout_recorded_paid_minor: '0',
  line_item_count: '2',
  line_quote_total_minor: '14000',
  line_actual_total_minor: '14000',
  line_discount_total_minor: '0',
  line_final_total_minor: '14000',
  payment_total_minor: '0',
  refund_total_minor: '0',
  ...overrides
});

test('no checkout preserves legacy fields and returns stable multi-service items', () => {
  const projected = projectOwnerAppointmentCheckout(appointment(), {
    role: 'owner', checkoutWriteEnabled: true
  });
  for (const key of ['appointment_no', 'customer_name', 'service_name', 'staff_name']) {
    assert.equal(projected[key], appointment()[key]);
  }
  assert.deepEqual(projected.items.map(entry => entry.sequence_no), [1, 2]);
  assert.equal(projected.items[0].service_locale_snapshot, 'en');
  assert.equal(projected.items[1].price_snapshot_minor, 8000);
  assert.deepEqual(projected.items[1].staff_assignments.map(entry => entry.role), ['primary', 'assistant']);
  assert.equal(projected.checkout, null);
  assert.equal(projected.can_start_checkout, true);
});

test('draft checkout derives unpaid and partially paid only from reconciled ledger', () => {
  const unpaid = deriveCheckout(checkoutRow('draft'));
  assert.equal(unpaid.payment_state, 'unpaid');
  assert.equal(unpaid.outstanding_minor, 14000);
  const partial = deriveCheckout(checkoutRow('draft', {
    checkout_recorded_paid_minor: '4000', payment_total_minor: '4000'
  }));
  assert.equal(partial.payment_state, 'partially_paid');
  assert.equal(partial.net_paid_minor, 4000);
  assert.equal(partial.outstanding_minor, 10000);
});

test('paid requires status, transaction paid amount, and payment ledger agreement', () => {
  const paid = deriveCheckout(checkoutRow('paid', {
    checkout_recorded_paid_minor: '14000', payment_total_minor: '14000'
  }));
  assert.equal(paid.payment_state, 'paid');
  assert.equal(paid.reconciliation_valid, true);
  assert.equal(paid.outstanding_minor, 0);
});

test('completed appointment without checkout is never inferred paid', () => {
  const completed = appointment({
    status: 'completed',
    items: [item(1, { status: 'completed' })]
  });
  const projected = projectOwnerAppointmentCheckout(completed, {
    role: 'manager', checkoutWriteEnabled: true
  });
  assert.equal(projected.checkout, null);
  assert.equal(projected.can_start_checkout, true);
});

test('partial refund and full refund require exact refund ledger agreement', () => {
  const partial = deriveCheckout(checkoutRow('partially_refunded', {
    checkout_recorded_paid_minor: '14000', payment_total_minor: '14000', refund_total_minor: '4000'
  }));
  assert.equal(partial.payment_state, 'partially_refunded');
  assert.equal(partial.net_paid_minor, 10000);
  assert.equal(partial.reconciliation_valid, true);
  const full = deriveCheckout(checkoutRow('refunded', {
    checkout_recorded_paid_minor: '14000', payment_total_minor: '14000', refund_total_minor: '14000'
  }));
  assert.equal(full.payment_state, 'refunded');
  assert.equal(full.net_paid_minor, 0);
});

test('void is valid only without collected or refunded value', () => {
  const voided = deriveCheckout(checkoutRow('void'));
  assert.equal(voided.payment_state, 'void');
  assert.equal(voided.reconciliation_valid, true);
  const invalid = deriveCheckout(checkoutRow('void', {
    checkout_recorded_paid_minor: '1', payment_total_minor: '1'
  }));
  assert.equal(invalid.payment_state, 'inconsistent');
});

test('status, transaction totals, line totals, payment, and refund mismatches fail closed', () => {
  for (const mismatch of [
    { checkout_status: 'paid' },
    { checkout_actual_total_minor: '13000' },
    { line_final_total_minor: '13999' },
    { checkout_recorded_paid_minor: '4000', payment_total_minor: '3000' },
    { refund_total_minor: '1' },
    { checkout_status: 'unknown' },
    { checkout_final_due_minor: '9007199254740992' }
  ]) {
    const projected = deriveCheckout(checkoutRow('draft', mismatch));
    assert.equal(projected.payment_state, 'inconsistent');
    assert.equal(projected.reconciliation_valid, false);
    assert.equal(projected.outstanding_minor, null);
  }
});

test('all exposed reconciled checkout amounts are safe integer minor units', () => {
  const projected = deriveCheckout(checkoutRow('paid', {
    checkout_recorded_paid_minor: '14000', payment_total_minor: '14000'
  }));
  for (const key of [
    'quote_total_minor', 'actual_total_minor', 'discount_total_minor',
    'final_due_minor', 'recorded_paid_minor', 'payment_total_minor',
    'refund_total_minor', 'net_paid_minor', 'outstanding_minor'
  ]) assert.equal(Number.isSafeInteger(projected[key]), true, key);
  assert.equal(toSafeMinor('1.5'), null);
  assert.equal(toSafeMinor('-1'), null);
});

test('missing or incomplete items make checkout start fail closed', () => {
  for (const items of [
    [],
    [item(1, { staff_assignments: [] })],
    [item(1, { price_snapshot_minor: null })],
    [item(1), item(1, { item_id: 'duplicate-sequence' })]
  ]) {
    const projected = projectOwnerAppointmentCheckout(appointment({ items }), {
      role: 'owner', checkoutWriteEnabled: true
    });
    assert.equal(projected.can_start_checkout, false);
  }
});

test('checkout gate and current role are authoritative for can_start_checkout', () => {
  for (const checkoutWriteEnabled of [false, undefined, 'true']) {
    assert.equal(projectOwnerAppointmentCheckout(appointment(), {
      role: 'owner', checkoutWriteEnabled
    }).can_start_checkout, false);
  }
  for (const role of ['owner', 'manager']) {
    assert.equal(projectOwnerAppointmentCheckout(appointment(), {
      role, checkoutWriteEnabled: true
    }).can_start_checkout, true);
  }
  assert.equal(projectOwnerAppointmentCheckout(appointment(), {
    role: 'admin', checkoutWriteEnabled: true
  }).can_start_checkout, false);
});

test('only in_service and completed appointments may start checkout', () => {
  for (const status of ['pending', 'confirmed', 'arrived', 'cancelled', 'no_show']) {
    const projected = projectOwnerAppointmentCheckout(appointment({
      status,
      items: [item(1, { status })]
    }), { role: 'owner', checkoutWriteEnabled: true });
    assert.equal(projected.can_start_checkout, false, status);
  }
});

test('any existing checkout including draft, void, or refunded prevents a new checkout', () => {
  for (const status of ['draft', 'void', 'refunded']) {
    const row = {
      ...appointment(),
      ...checkoutRow(status, status === 'refunded' ? {
        checkout_recorded_paid_minor: '14000', payment_total_minor: '14000', refund_total_minor: '14000'
      } : {})
    };
    assert.equal(projectOwnerAppointmentCheckout(row, {
      role: 'owner', checkoutWriteEnabled: true
    }).can_start_checkout, false);
  }
});
