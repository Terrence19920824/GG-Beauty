'use strict';

const { deriveCheckout, toSafeMinor } = require('./owner-appointment-checkout-projection');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const positiveInt = (value, fallback, maximum) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const json = value => Array.isArray(value) ? value : JSON.parse(value || '[]');
const minor = value => toSafeMinor(value);

const listCustomerTransactions = async (pool, { shopId, customerId, query }) => {
  if (!UUID.test(customerId)) return null;
  const page = positiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const customer = await pool.query(
    'SELECT id FROM customers WHERE id=$1 AND shop_id=$2', [customerId, shopId]
  );
  if (customer.rows.length !== 1) return null;

  const result = await pool.query(
    `WITH selected AS MATERIALIZED (
       SELECT checkout.*
         FROM checkout_transactions checkout
        WHERE checkout.shop_id=$1 AND checkout.customer_id=$2
        ORDER BY checkout.created_at DESC, checkout.id DESC
        LIMIT $3 OFFSET $4
     ), line_projection AS (
       SELECT line.shop_id, line.checkout_id,
              COUNT(*)::TEXT AS line_item_count,
              COALESCE(SUM(line.quote_price_minor),0)::TEXT AS line_quote_total_minor,
              COALESCE(SUM(line.actual_price_minor),0)::TEXT AS line_actual_total_minor,
              COALESCE(SUM(line.discount_minor),0)::TEXT AS line_discount_total_minor,
              COALESCE(SUM(line.final_value_minor),0)::TEXT AS line_final_total_minor,
              JSON_AGG(JSON_BUILD_OBJECT('id',line.id,'lineType',line.line_type,
                'description',line.description_snapshot,'quotePriceMinor',line.quote_price_minor,
                'actualPriceMinor',line.actual_price_minor,'discountMinor',line.discount_minor,
                'finalValueMinor',line.final_value_minor) ORDER BY line.created_at,line.id) AS line_items
         FROM checkout_line_items line JOIN selected checkout
           ON checkout.shop_id=line.shop_id AND checkout.id=line.checkout_id
        WHERE line.shop_id=$1 GROUP BY line.shop_id,line.checkout_id
     ), payment_projection AS (
       SELECT payment.shop_id,payment.checkout_id,
              COALESCE(SUM(payment.amount_minor) FILTER (WHERE payment.value_kind <> 'refund'),0)::TEXT AS payment_total_minor,
              COALESCE(SUM(payment.amount_minor) FILTER (WHERE payment.value_kind = 'refund'),0)::TEXT AS refund_total_minor,
              JSON_AGG(JSON_BUILD_OBJECT('method',payment.payment_method,'valueKind',payment.value_kind,
                'amountMinor',payment.amount_minor) ORDER BY payment.created_at,payment.id) AS payments
         FROM checkout_payments payment JOIN selected checkout
           ON checkout.shop_id=payment.shop_id AND checkout.id=payment.checkout_id
        WHERE payment.shop_id=$1 GROUP BY payment.shop_id,payment.checkout_id
     ), audit_projection AS (
       SELECT audit.shop_id,audit.checkout_id,
              COUNT(*) FILTER (WHERE audit.event_type='refund')::TEXT AS refund_audit_count,
              COUNT(*) FILTER (WHERE audit.event_type='void')::TEXT AS void_audit_count
         FROM checkout_financial_audit audit JOIN selected checkout
           ON checkout.shop_id=audit.shop_id AND checkout.id=audit.checkout_id
          AND checkout.appointment_id=audit.appointment_id
        WHERE audit.shop_id=$1 GROUP BY audit.shop_id,audit.checkout_id
     ), attribution_projection AS (
       SELECT attribution.shop_id,line.checkout_id,
              JSON_AGG(JSON_BUILD_OBJECT('staffId',staff.id,'staffName',staff.name,
                'role',attribution.attribution_role,'amountMinor',attribution.attribution_minor)
                ORDER BY attribution.created_at,attribution.id) AS staff_attributions
         FROM checkout_staff_attributions attribution
         JOIN checkout_line_items line ON line.shop_id=attribution.shop_id AND line.id=attribution.checkout_line_item_id
         JOIN selected checkout ON checkout.shop_id=line.shop_id AND checkout.id=line.checkout_id
         JOIN staff ON staff.shop_id=attribution.shop_id AND staff.id=attribution.staff_id
        WHERE attribution.shop_id=$1 GROUP BY attribution.shop_id,line.checkout_id
     )
     SELECT checkout.id AS transaction_id,checkout.id AS checkout_id,checkout.created_at,checkout.appointment_id,appointment.appointment_no,
            checkout.status AS checkout_status,checkout.currency_code,
            checkout.quote_total_minor::TEXT AS checkout_quote_total_minor,
            checkout.actual_total_minor::TEXT AS checkout_actual_total_minor,
            checkout.discount_total_minor::TEXT AS checkout_discount_total_minor,
            checkout.final_due_minor::TEXT AS checkout_final_due_minor,
            checkout.paid_minor::TEXT AS checkout_recorded_paid_minor,
            COALESCE(line_projection.line_item_count,'0') AS line_item_count,
            COALESCE(line_projection.line_quote_total_minor,'0') AS line_quote_total_minor,
            COALESCE(line_projection.line_actual_total_minor,'0') AS line_actual_total_minor,
            COALESCE(line_projection.line_discount_total_minor,'0') AS line_discount_total_minor,
            COALESCE(line_projection.line_final_total_minor,'0') AS line_final_total_minor,
            COALESCE(payment_projection.payment_total_minor,'0') AS payment_total_minor,
            COALESCE(payment_projection.refund_total_minor,'0') AS refund_total_minor,
            COALESCE(audit_projection.refund_audit_count,'0') AS refund_audit_count,
            COALESCE(audit_projection.void_audit_count,'0') AS void_audit_count,
            COALESCE(line_projection.line_items,'[]'::json) AS line_items,
            COALESCE(payment_projection.payments,'[]'::json) AS payments,
            COALESCE(attribution_projection.staff_attributions,'[]'::json) AS staff_attributions
       FROM selected checkout
       JOIN appointments appointment ON appointment.shop_id=checkout.shop_id AND appointment.id=checkout.appointment_id
       LEFT JOIN line_projection ON line_projection.shop_id=checkout.shop_id AND line_projection.checkout_id=checkout.id
       LEFT JOIN payment_projection ON payment_projection.shop_id=checkout.shop_id AND payment_projection.checkout_id=checkout.id
       LEFT JOIN audit_projection ON audit_projection.shop_id=checkout.shop_id AND audit_projection.checkout_id=checkout.id
       LEFT JOIN attribution_projection ON attribution_projection.shop_id=checkout.shop_id AND attribution_projection.checkout_id=checkout.id
      ORDER BY checkout.created_at DESC,checkout.id DESC`,
    [shopId, customerId, pageSize + 1, (page - 1) * pageSize]
  );
  const rows = result.rows.slice(0, pageSize);
  return {
    page, pageSize, hasMore: result.rows.length > pageSize,
    transactions: rows.map(row => {
      const financial = deriveCheckout(row);
      return {
        id: row.transaction_id, appointmentId: row.appointment_id, appointmentNo: row.appointment_no,
        createdAt: row.created_at, currencyCode: row.currency_code, checkoutStatus: row.checkout_status,
        reconciliationValid: financial?.reconciliation_valid === true,
        paymentState: financial?.payment_state || 'inconsistent',
        quoteTotalMinor: minor(row.checkout_quote_total_minor), actualTotalMinor: minor(row.checkout_actual_total_minor),
        discountTotalMinor: minor(row.checkout_discount_total_minor), finalDueMinor: minor(row.checkout_final_due_minor),
        recordedPaidMinor: minor(row.checkout_recorded_paid_minor), refundTotalMinor: minor(row.refund_total_minor),
        netPaidMinor: financial?.net_paid_minor ?? null, outstandingMinor: financial?.outstanding_minor ?? null,
        lineItems: json(row.line_items), payments: json(row.payments), staffAttributions: json(row.staff_attributions)
      };
    })
  };
};

module.exports = { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listCustomerTransactions };
