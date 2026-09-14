'use strict';

// Checkout is deliberately independent from appointment completion.  All money
// crosses this boundary as integer minor units; never accept floating point.
const PAYMENT_METHODS = new Set(['cash', 'card', 'paynow_qr', 'other']);
const VALUE_KINDS = new Set(['cash_collected', 'service_revenue', 'package_sale', 'package_redemption', 'stored_value_principal', 'stored_value_bonus', 'points_redemption']);
const isMinor = value => Number.isSafeInteger(value) && value >= 0;
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

class CheckoutError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const createCheckoutPos = ({ pool }) => {
  const create = async (req, res) => {
    const { appointmentId } = req.params;
    const body = req.body || {};
    if (!safeKey(body.idempotencyKey)) return res.status(400).json({ success: false, code: 'CHECKOUT_IDEMPOTENCY_KEY_INVALID' });
    if (body.items !== undefined && !Array.isArray(body.items)) return res.status(400).json({ success: false, code: 'CHECKOUT_ITEMS_INVALID' });
    if (body.payments !== undefined && !Array.isArray(body.payments)) return res.status(400).json({ success: false, code: 'CHECKOUT_PAYMENTS_INVALID' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const existing = await client.query(
        `SELECT id,status,final_due_minor,paid_minor FROM checkout_transactions
         WHERE shop_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [req.ownerAuth.shopId, body.idempotencyKey]
      );
      if (existing.rows.length) { await client.query('COMMIT'); return res.status(200).json({ success: true, data: existing.rows[0], idempotent: true }); }
      const appointment = await client.query(
        `SELECT a.id,a.shop_id,a.recipient_customer_id AS customer_id
           FROM appointments a WHERE a.id=$1 AND a.shop_id=$2 FOR UPDATE`,
        [appointmentId, req.ownerAuth.shopId]
      );
      if (appointment.rows.length !== 1) throw new CheckoutError('APPOINTMENT_NOT_FOUND', 404);
      const items = await client.query(
        `SELECT i.id, i.sequence_no, i.service_id, i.service_name_snapshot,
                COALESCE(ROUND(i.price_snapshot * 100)::BIGINT,0) AS quote_minor
           FROM appointment_items i WHERE i.appointment_id=$1 AND i.shop_id=$2
           ORDER BY i.sequence_no, i.id FOR UPDATE`, [appointmentId, req.ownerAuth.shopId]
      );
      if (!items.rows.length) throw new CheckoutError('CHECKOUT_APPOINTMENT_ITEMS_MISSING', 409);
      const supplied = new Map((body.items || []).map(item => [item?.appointmentItemId, item]));
      const appointmentItemIds = new Set(items.rows.map(item => item.id));
      if (supplied.size !== (body.items || []).length || [...supplied.keys()].some(id => typeof id !== 'string' || !appointmentItemIds.has(id)) || (body.items && supplied.size !== items.rows.length)) throw new CheckoutError('CHECKOUT_ITEMS_INVALID');
      const resolved = items.rows.map(item => {
        const input = supplied.get(item.id) || {};
        const actual = input.actualPriceMinor === undefined ? Number(item.quote_minor) : input.actualPriceMinor;
        const discount = input.discountMinor === undefined ? 0 : input.discountMinor;
        if (!isMinor(actual) || !isMinor(discount) || discount > actual) throw new CheckoutError('CHECKOUT_AMOUNT_INVALID');
        return { ...item, actual, discount, final: actual - discount };
      });
      const finalDue = resolved.reduce((total, item) => total + item.final, 0);
      if (!Number.isSafeInteger(finalDue)) throw new CheckoutError('CHECKOUT_AMOUNT_INVALID');
      const payments = body.payments || [];
      let paid = 0;
      for (const payment of payments) {
        if (!PAYMENT_METHODS.has(payment?.method) || !VALUE_KINDS.has(payment?.valueKind) || !isMinor(payment?.amountMinor)) throw new CheckoutError('CHECKOUT_PAYMENT_INVALID');
        if (payment.cashCollectedMinor !== undefined && (!isMinor(payment.cashCollectedMinor) || payment.cashCollectedMinor > payment.amountMinor)) throw new CheckoutError('CHECKOUT_PAYMENT_INVALID');
        // Only actual tender increases cash collected. Bonus/redemption never does.
        if (payment.valueKind !== 'cash_collected' && (payment.cashCollectedMinor || 0) !== 0) throw new CheckoutError('CHECKOUT_PAYMENT_INVALID');
        paid += payment.amountMinor;
      }
      if (!Number.isSafeInteger(paid) || paid > finalDue) throw new CheckoutError('CHECKOUT_PAYMENT_TOTAL_INVALID');
      const status = paid === finalDue ? 'paid' : 'draft';
      const checkout = await client.query(
        `INSERT INTO checkout_transactions(shop_id,appointment_id,customer_id,status,currency_code,quote_total_minor,actual_total_minor,discount_total_minor,final_due_minor,paid_minor,idempotency_key,created_by_owner_id)
         VALUES($1,$2,$3,$4,'SGD',$5,$6,$7,$8,$9,$10,$11) RETURNING id,status,final_due_minor,paid_minor`,
        [req.ownerAuth.shopId, appointmentId, appointment.rows[0].customer_id, status,
          items.rows.reduce((n, i) => n + Number(i.quote_minor), 0), resolved.reduce((n, i) => n + i.actual, 0), resolved.reduce((n, i) => n + i.discount, 0), finalDue, paid, body.idempotencyKey, req.ownerAuth.ownerAccountId]
      );
      for (const item of resolved) await client.query(
        `INSERT INTO checkout_line_items(shop_id,checkout_id,appointment_item_id,line_type,description_snapshot,quote_price_minor,actual_price_minor,discount_minor,final_value_minor)
         VALUES($1,$2,$3,'service',$4,$5,$6,$7,$8)`,
        [req.ownerAuth.shopId, checkout.rows[0].id, item.id, item.service_name_snapshot, item.quote_minor, item.actual, item.discount, item.final]
      );
      for (const payment of payments) await client.query(
        `INSERT INTO checkout_payments(shop_id,checkout_id,payment_method,value_kind,amount_minor,cash_collected_minor)
         VALUES($1,$2,$3,$4,$5,$6)`, [req.ownerAuth.shopId, checkout.rows[0].id, payment.method, payment.valueKind, payment.amountMinor, payment.cashCollectedMinor || 0]
      );
      await client.query('COMMIT');
      return res.status(201).json({ success: true, data: checkout.rows[0], idempotent: false });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      const status = error instanceof CheckoutError ? error.status : 500;
      const code = error instanceof CheckoutError ? error.code : 'CHECKOUT_CREATE_FAILED';
      return res.status(status).json({ success: false, code });
    } finally { if (client) client.release(); }
  };
  return { create, CheckoutError, PAYMENT_METHODS, VALUE_KINDS };
};
module.exports = { createCheckoutPos, CheckoutError, PAYMENT_METHODS, VALUE_KINDS, isMinor };
