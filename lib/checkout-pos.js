'use strict';

// Checkout is deliberately independent from appointment completion. All money
// crosses this boundary as integer minor units; never accept floating point.
const ABSTRACT_PAYMENT_METHODS = Object.freeze(new Set([
  'cash',
  'card',
  'paynow_qr',
  'qr_payment',
  'ewallet',
  'bank_transfer',
  'other'
]));
const PAYMENT_METHODS = ABSTRACT_PAYMENT_METHODS;
const DB_PAYMENT_METHOD_MAP = Object.freeze({
  cash: 'cash',
  card: 'card',
  paynow_qr: 'paynow_qr',
  qr_payment: 'paynow_qr',
  ewallet: 'other',
  bank_transfer: 'other',
  other: 'other'
});
const VALUE_KINDS = Object.freeze(new Set([
  'cash_collected',
  'service_revenue',
  'package_sale',
  'package_redemption',
  'stored_value_principal',
  'stored_value_bonus',
  'points_redemption'
]));
const ALLOWED_CHECKOUT_STATUSES = Object.freeze(new Set(['arrived', 'in_service', 'completed']));
const ALLOWED_BODY_KEYS = Object.freeze(new Set(['paymentMethod', 'idempotencyKey', 'locale']));
const FORBIDDEN_CLIENT_FIELDS = Object.freeze([
  'items', 'payments', 'actualPriceMinor', 'discountMinor', 'amountMinor',
  'paidMinor', 'cashCollectedMinor', 'providerReference', 'provider_reference',
  'currency', 'currencyCode', 'currency_code', 'finalDueMinor', 'final_due_minor',
  'quoteTotalMinor', 'quote_total_minor', 'actualTotalMinor', 'actual_total_minor',
  'discountTotalMinor', 'discount_total_minor'
]);

const isMinor = value => Number.isSafeInteger(value) && value >= 0;
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

class CheckoutError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const createCheckoutPos = ({ pool }) => {
  const create = async (req, res) => {
    const { appointmentId } = req.params;
    const body = req.body || {};

    // 1. Reject client financial mutation / custom calculation fields
    for (const field of FORBIDDEN_CLIENT_FIELDS) {
      if (body[field] !== undefined) {
        return res.status(400).json({ success: false, code: 'CHECKOUT_CLIENT_MUTATION_FORBIDDEN' });
      }
    }

    // 2. Reject unrecognized body keys
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        return res.status(400).json({ success: false, code: 'CHECKOUT_BODY_INVALID' });
      }
    }

    // 3. Validate idempotencyKey
    if (!safeKey(body.idempotencyKey)) {
      return res.status(400).json({ success: false, code: 'CHECKOUT_IDEMPOTENCY_KEY_INVALID' });
    }

    // 4. Validate paymentMethod
    const paymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod.trim() : '';
    if (!ABSTRACT_PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ success: false, code: 'CHECKOUT_PAYMENT_METHOD_INVALID' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");

      // 5. Read target appointment and authoritative shop currency
      const appointment = await client.query(
        `SELECT a.id, a.shop_id, a.status, a.recipient_customer_id AS customer_id,
                COALESCE(scs.currency_code, 'SGD') AS currency_code
           FROM appointments a
           LEFT JOIN shop_customer_settings scs ON scs.shop_id = a.shop_id
          WHERE a.id = $1 AND a.shop_id=$2
            FOR UPDATE OF a`,
        [appointmentId, req.ownerAuth.shopId]
      );
      if (appointment.rows.length !== 1) throw new CheckoutError('APPOINTMENT_NOT_FOUND', 404);
      if (!ALLOWED_CHECKOUT_STATUSES.has(appointment.rows[0].status)) {
        throw new CheckoutError('CHECKOUT_APPOINTMENT_STATUS_INVALID', 409);
      }

      // 6. Check existing transaction by idempotency_key (safe replay path)
      const existingByIdempotency = await client.query(
        `SELECT id, appointment_id, status, final_due_minor, paid_minor
           FROM checkout_transactions
          WHERE shop_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [req.ownerAuth.shopId, body.idempotencyKey]
      );
      if (existingByIdempotency.rows.length) {
        const existingTx = existingByIdempotency.rows[0];
        if (String(existingTx.appointment_id) !== String(appointmentId)) {
          throw new CheckoutError('IDEMPOTENCY_KEY_CONFLICT', 409);
        }
        await client.query('COMMIT');
        return res.status(200).json({
          success: true,
          data: {
            id: existingTx.id,
            status: existingTx.status,
            final_due_minor: existingTx.final_due_minor,
            paid_minor: existingTx.paid_minor
          },
          idempotent: true
        });
      }

      // 7. Check if checkout already exists for this appointment under a different key
      const existingByAppointment = await client.query(
        `SELECT id, status, final_due_minor, paid_minor
           FROM checkout_transactions
          WHERE shop_id = $1 AND appointment_id = $2
          LIMIT 1`,
        [req.ownerAuth.shopId, appointmentId]
      );
      if (existingByAppointment.rows.length) {
        throw new CheckoutError('CHECKOUT_ALREADY_EXISTS', 409);
      }

      // 8. Fetch appointment items and authoritatively calculate total due
      const items = await client.query(
        `SELECT i.id, i.sequence_no, i.service_id, i.service_name_snapshot,
                COALESCE(ROUND(i.price_snapshot * 100)::BIGINT, 0) AS quote_minor
           FROM appointment_items i
          WHERE i.appointment_id = $1 AND i.shop_id = $2
          ORDER BY i.sequence_no, i.id
            FOR UPDATE`,
        [appointmentId, req.ownerAuth.shopId]
      );
      if (!items.rows.length) throw new CheckoutError('CHECKOUT_APPOINTMENT_ITEMS_MISSING', 409);

      const finalDue = items.rows.reduce((sum, item) => sum + Number(item.quote_minor), 0);
      if (!Number.isSafeInteger(finalDue) || finalDue < 0) {
        throw new CheckoutError('CHECKOUT_AMOUNT_INVALID', 400);
      }
      const paid = finalDue;
      const status = 'paid';

      // 9. Authoritative currency
      const rawCurrency = appointment.rows[0].currency_code;
      const currency = (typeof rawCurrency === 'string' && /^[A-Z]{3}$/.test(rawCurrency.trim().toUpperCase()))
        ? rawCurrency.trim().toUpperCase()
        : 'SGD';

      // 10. Server-generated provider_reference and mapped payment method
      const dbMethod = DB_PAYMENT_METHOD_MAP[paymentMethod] || 'other';
      const providerReference = `method:${paymentMethod}`;

      // 11. Write checkout_transactions
      const checkout = await client.query(
        `INSERT INTO checkout_transactions(
           shop_id, appointment_id, customer_id, status, currency_code,
           quote_total_minor, actual_total_minor, discount_total_minor, final_due_minor, paid_minor,
           idempotency_key, created_by_owner_id
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, status, final_due_minor, paid_minor`,
        [
          req.ownerAuth.shopId,
          appointmentId,
          appointment.rows[0].customer_id,
          status,
          currency,
          finalDue,
          finalDue,
          0,
          finalDue,
          paid,
          body.idempotencyKey,
          req.ownerAuth.ownerAccountId
        ]
      );

      // 12. Write checkout_line_items (immutable snapshots from appointment_items)
      for (const item of items.rows) {
        const quoteMinor = Number(item.quote_minor);
        await client.query(
          `INSERT INTO checkout_line_items(
             shop_id, checkout_id, appointment_item_id, line_type, description_snapshot,
             quote_price_minor, actual_price_minor, discount_minor, final_value_minor,
             price_override_reason, discount_reason
           )
           VALUES($1, $2, $3, 'service', $4, $5, $6, 0, $7, NULL, NULL)`,
          [
            req.ownerAuth.shopId,
            checkout.rows[0].id,
            item.id,
            item.service_name_snapshot,
            quoteMinor,
            quoteMinor,
            quoteMinor
          ]
        );
      }

      // 13. Write checkout_payments (full payment tender)
      await client.query(
        `INSERT INTO checkout_payments(
           shop_id, checkout_id, payment_method, value_kind,
           amount_minor, cash_collected_minor, provider_reference
         )
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.ownerAuth.shopId,
          checkout.rows[0].id,
          dbMethod,
          'cash_collected',
          paid,
          paymentMethod === 'cash' ? paid : 0,
          providerReference
        ]
      );

      // 14. Write checkout_financial_audit
      await client.query(
        `INSERT INTO checkout_financial_audit(
           shop_id, checkout_id, appointment_id, event_type,
           before_snapshot, after_snapshot, reason,
           operator_type, operator_id, source
         )
         VALUES($1, $2, $3, 'checkout_created', NULL, $4, $5, 'owner', $6, 'owner_checkout_api')`,
        [
          req.ownerAuth.shopId,
          checkout.rows[0].id,
          appointmentId,
          JSON.stringify({
            currencyCode: currency,
            paymentMethod,
            quoteTotalMinor: finalDue,
            actualTotalMinor: finalDue,
            discountTotalMinor: 0,
            finalDueMinor: finalDue,
            paidMinor: paid,
            items: items.rows.map(i => ({
              appointmentItemId: i.id,
              quoteMinor: Number(i.quote_minor),
              actualMinor: Number(i.quote_minor),
              discountMinor: 0
            }))
          }),
          `Manual full checkout: ${paymentMethod}`,
          req.ownerAuth.ownerAccountId
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({ success: true, data: checkout.rows[0], idempotent: false });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') {
        if (error.constraint === 'checkout_appointment_one' || /checkout_appointment_one/i.test(error.message || '')) {
          return res.status(409).json({ success: false, code: 'CHECKOUT_ALREADY_EXISTS' });
        }
        if (error.constraint === 'checkout_idempotency_one' || /checkout_idempotency_one/i.test(error.message || '')) {
          return res.status(409).json({ success: false, code: 'IDEMPOTENCY_KEY_CONFLICT' });
        }
      }
      const status = error instanceof CheckoutError ? error.status : 500;
      const code = error instanceof CheckoutError ? error.code : 'CHECKOUT_CREATE_FAILED';
      return res.status(status).json({ success: false, code });
    } finally {
      if (client) client.release();
    }
  };

  return {
    create,
    CheckoutError,
    PAYMENT_METHODS,
    ABSTRACT_PAYMENT_METHODS,
    DB_PAYMENT_METHOD_MAP,
    VALUE_KINDS,
    ALLOWED_CHECKOUT_STATUSES
  };
};

module.exports = {
  createCheckoutPos,
  CheckoutError,
  PAYMENT_METHODS,
  ABSTRACT_PAYMENT_METHODS,
  DB_PAYMENT_METHOD_MAP,
  VALUE_KINDS,
  ALLOWED_CHECKOUT_STATUSES,
  isMinor
};
