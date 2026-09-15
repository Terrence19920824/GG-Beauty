'use strict';

const SAFE_MINOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const CHECKOUT_STATUSES = new Set([
  'draft',
  'paid',
  'void',
  'partially_refunded',
  'refunded'
]);
const CHECKOUT_START_STATUSES = new Set(['in_service', 'completed']);
const CHECKOUT_ROLES = new Set(['owner', 'manager']);

const asArray = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

const toSafeMinor = value => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value !== 'string' || !SAFE_MINOR_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const normalizeAssignments = value =>
  asArray(value).map(assignment => ({
    assignment_id: assignment.assignment_id,
    staff_id: assignment.staff_id,
    staff_name: assignment.staff_name,
    role: assignment.role,
    start_at: assignment.start_at,
    end_at: assignment.end_at
  }));

const normalizeItems = value =>
  asArray(value)
    .map(item => ({
      item_id: item.item_id,
      sequence_no: item.sequence_no,
      service_id: item.service_id,
      service_name_snapshot: item.service_name_snapshot,
      service_locale_snapshot: item.service_locale_snapshot ?? null,
      duration_minutes_snapshot: item.duration_minutes_snapshot,
      price_snapshot_minor: toSafeMinor(item.price_snapshot_minor),
      start_at: item.start_at,
      end_at: item.end_at,
      status: item.status,
      staff_assignments: normalizeAssignments(item.staff_assignments)
    }))
    .sort((left, right) =>
      left.sequence_no - right.sequence_no ||
      String(left.item_id).localeCompare(String(right.item_id))
    );

const hasCompleteItems = (items, appointmentStatus) => {
  if (!items.length) return false;
  const sequences = new Set();
  for (const item of items) {
    if (
      typeof item.item_id !== 'string' ||
      typeof item.service_id !== 'string' ||
      typeof item.service_name_snapshot !== 'string' ||
      !item.service_name_snapshot.trim() ||
      !Number.isInteger(item.sequence_no) ||
      item.sequence_no < 1 ||
      sequences.has(item.sequence_no) ||
      !Number.isInteger(item.duration_minutes_snapshot) ||
      item.duration_minutes_snapshot < 1 ||
      item.price_snapshot_minor === null ||
      !item.start_at ||
      !item.end_at ||
      item.status !== appointmentStatus
    ) return false;
    sequences.add(item.sequence_no);
    const primary = item.staff_assignments.filter(a => a.role === 'primary');
    if (primary.length !== 1) return false;
    if (item.staff_assignments.some(assignment =>
      !assignment.assignment_id ||
      !assignment.staff_id ||
      !['primary', 'assistant'].includes(assignment.role) ||
      !assignment.start_at ||
      !assignment.end_at
    )) return false;
  }
  return true;
};

const invalidCheckout = (row, amounts) => ({
  exists: true,
  checkout_id: row.checkout_id,
  checkout_status: row.checkout_status,
  currency_code: row.currency_code,
  quote_total_minor: amounts.quote,
  actual_total_minor: amounts.actual,
  discount_total_minor: amounts.discount,
  final_due_minor: amounts.finalDue,
  recorded_paid_minor: amounts.recordedPaid,
  payment_total_minor: amounts.paymentTotal,
  refund_total_minor: amounts.refundTotal,
  net_paid_minor: amounts.netPaid,
  outstanding_minor: null,
  payment_state: 'inconsistent',
  reconciliation_valid: false
});

const deriveCheckout = row => {
  if (!row.checkout_id) return null;
  const amounts = {
    quote: toSafeMinor(row.checkout_quote_total_minor),
    actual: toSafeMinor(row.checkout_actual_total_minor),
    discount: toSafeMinor(row.checkout_discount_total_minor),
    finalDue: toSafeMinor(row.checkout_final_due_minor),
    recordedPaid: toSafeMinor(row.checkout_recorded_paid_minor),
    paymentTotal: toSafeMinor(row.payment_total_minor),
    refundTotal: toSafeMinor(row.refund_total_minor),
    lineCount: toSafeMinor(row.line_item_count),
    lineQuote: toSafeMinor(row.line_quote_total_minor),
    lineActual: toSafeMinor(row.line_actual_total_minor),
    lineDiscount: toSafeMinor(row.line_discount_total_minor),
    lineFinal: toSafeMinor(row.line_final_total_minor)
  };
  const monetary = [
    amounts.quote,
    amounts.actual,
    amounts.discount,
    amounts.finalDue,
    amounts.recordedPaid,
    amounts.paymentTotal,
    amounts.refundTotal,
    amounts.lineCount,
    amounts.lineQuote,
    amounts.lineActual,
    amounts.lineDiscount,
    amounts.lineFinal
  ];
  if (monetary.some(value => value === null)) {
    return invalidCheckout(row, { ...amounts, netPaid: null });
  }

  amounts.netPaid = amounts.paymentTotal - amounts.refundTotal;
  const totalsValid =
    amounts.lineCount > 0 &&
    amounts.actual >= amounts.discount &&
    amounts.finalDue === amounts.actual - amounts.discount &&
    amounts.recordedPaid <= amounts.finalDue &&
    amounts.refundTotal <= amounts.paymentTotal &&
    amounts.paymentTotal === amounts.recordedPaid &&
    amounts.lineQuote === amounts.quote &&
    amounts.lineActual === amounts.actual &&
    amounts.lineDiscount === amounts.discount &&
    amounts.lineFinal === amounts.finalDue;
  if (!totalsValid || !CHECKOUT_STATUSES.has(row.checkout_status)) {
    return invalidCheckout(row, amounts);
  }

  let paymentState = 'inconsistent';
  if (
    row.checkout_status === 'draft' &&
    amounts.refundTotal === 0 &&
    amounts.recordedPaid < amounts.finalDue
  ) {
    paymentState = amounts.recordedPaid === 0 ? 'unpaid' : 'partially_paid';
  } else if (
    row.checkout_status === 'paid' &&
    amounts.refundTotal === 0 &&
    amounts.recordedPaid === amounts.finalDue
  ) {
    paymentState = 'paid';
  } else if (
    row.checkout_status === 'partially_refunded' &&
    amounts.recordedPaid === amounts.finalDue &&
    amounts.refundTotal > 0 &&
    amounts.refundTotal < amounts.finalDue
  ) {
    paymentState = 'partially_refunded';
  } else if (
    row.checkout_status === 'refunded' &&
    amounts.recordedPaid === amounts.finalDue &&
    amounts.refundTotal > 0 &&
    amounts.refundTotal === amounts.finalDue
  ) {
    paymentState = 'refunded';
  } else if (
    row.checkout_status === 'void' &&
    amounts.recordedPaid === 0 &&
    amounts.paymentTotal === 0 &&
    amounts.refundTotal === 0
  ) {
    paymentState = 'void';
  }
  if (paymentState === 'inconsistent') return invalidCheckout(row, amounts);

  return {
    exists: true,
    checkout_id: row.checkout_id,
    checkout_status: row.checkout_status,
    currency_code: row.currency_code,
    quote_total_minor: amounts.quote,
    actual_total_minor: amounts.actual,
    discount_total_minor: amounts.discount,
    final_due_minor: amounts.finalDue,
    recorded_paid_minor: amounts.recordedPaid,
    payment_total_minor: amounts.paymentTotal,
    refund_total_minor: amounts.refundTotal,
    net_paid_minor: amounts.netPaid,
    outstanding_minor:
      paymentState === 'unpaid' || paymentState === 'partially_paid'
        ? amounts.finalDue - amounts.netPaid
        : 0,
    payment_state: paymentState,
    reconciliation_valid: true
  };
};

const projectOwnerAppointmentCheckout = (row, options = {}) => {
  const {
    checkout_id,
    checkout_status,
    currency_code,
    checkout_quote_total_minor,
    checkout_actual_total_minor,
    checkout_discount_total_minor,
    checkout_final_due_minor,
    checkout_recorded_paid_minor,
    line_item_count,
    line_quote_total_minor,
    line_actual_total_minor,
    line_discount_total_minor,
    line_final_total_minor,
    payment_total_minor,
    refund_total_minor,
    ...legacy
  } = row;
  const items = normalizeItems(legacy.items);
  const checkout = deriveCheckout({
    checkout_id,
    checkout_status,
    currency_code,
    checkout_quote_total_minor,
    checkout_actual_total_minor,
    checkout_discount_total_minor,
    checkout_final_due_minor,
    checkout_recorded_paid_minor,
    line_item_count,
    line_quote_total_minor,
    line_actual_total_minor,
    line_discount_total_minor,
    line_final_total_minor,
    payment_total_minor,
    refund_total_minor
  });
  return {
    ...legacy,
    items,
    checkout,
    can_start_checkout: Boolean(
      options.checkoutWriteEnabled === true &&
      CHECKOUT_ROLES.has(options.role) &&
      CHECKOUT_START_STATUSES.has(legacy.status) &&
      !checkout &&
      hasCompleteItems(items, legacy.status)
    )
  };
};

module.exports = {
  deriveCheckout,
  hasCompleteItems,
  normalizeItems,
  projectOwnerAppointmentCheckout,
  toSafeMinor
};
