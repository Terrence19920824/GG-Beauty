'use strict';

class CheckoutReadError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// This endpoint deliberately returns only the data required to render an
// owner checkout. The authenticated owner session is the sole tenant source.
const createCheckoutPosRead = ({ pool }) => {
  const getSession = async (req, res) => {
    let client;
    try {
      if (!isUuid(req.params.appointmentId)) throw new CheckoutReadError('CHECKOUT_APPOINTMENT_NOT_FOUND', 404);
      client = await pool.connect();
      const appointment = await client.query(
        `SELECT a.id, a.status, a.start_at, a.end_at,
                c.name AS customer_name, c.phone AS customer_phone, c.member_code
           FROM appointments a
           JOIN customers c ON c.id=a.recipient_customer_id AND c.shop_id=a.shop_id
          WHERE a.id=$1 AND a.shop_id=$2
          LIMIT 1`,
        [req.params.appointmentId, req.ownerAuth.shopId]
      );
      if (appointment.rows.length !== 1) throw new CheckoutReadError('CHECKOUT_APPOINTMENT_NOT_FOUND', 404);

      const items = await client.query(
        `SELECT i.id, i.sequence_no, i.service_name_snapshot,
                COALESCE(ROUND(i.price_snapshot * 100)::BIGINT, 0) AS quote_price_minor,
                COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                  'role', assignment.role, 'staffId', staff.id, 'name', staff.name
                ) ORDER BY assignment.role, assignment.id)
                FILTER (WHERE assignment.id IS NOT NULL), '[]'::json) AS staff_assignments
           FROM appointment_items i
           LEFT JOIN appointment_item_staff_assignments assignment
             ON assignment.shop_id=i.shop_id
            AND assignment.location_id=i.location_id
            AND assignment.appointment_item_id=i.id
           LEFT JOIN staff ON staff.id=assignment.staff_id AND staff.shop_id=assignment.shop_id
          WHERE i.appointment_id=$1 AND i.shop_id=$2
          GROUP BY i.id, i.sequence_no, i.service_name_snapshot, i.price_snapshot
          ORDER BY i.sequence_no, i.id`,
        [appointment.rows[0].id, req.ownerAuth.shopId]
      );
      if (!items.rows.length) throw new CheckoutReadError('CHECKOUT_APPOINTMENT_ITEMS_MISSING', 409);

      const checkout = await client.query(
        `SELECT id, status, currency_code, quote_total_minor, actual_total_minor,
                discount_total_minor, final_due_minor, paid_minor
           FROM checkout_transactions
          WHERE appointment_id=$1 AND shop_id=$2
          LIMIT 1`,
        [appointment.rows[0].id, req.ownerAuth.shopId]
      );
      const existing = checkout.rows[0] || null;
      return res.set('Cache-Control', 'no-store').json({
        success: true,
        data: {
          appointmentId: appointment.rows[0].id,
          appointmentStatus: appointment.rows[0].status,
          startAt: appointment.rows[0].start_at,
          endAt: appointment.rows[0].end_at,
          currencyCode: existing?.currency_code || 'SGD',
          customer: {
            name: appointment.rows[0].customer_name,
            phone: appointment.rows[0].customer_phone,
            memberCode: appointment.rows[0].member_code || null
          },
          items: items.rows.map(item => {
            const assignments = Array.isArray(item.staff_assignments) ? item.staff_assignments : JSON.parse(item.staff_assignments || '[]');
            const primary = assignments.find(assignment => assignment.role === 'primary') || null;
            const assistants = assignments.filter(assignment => assignment.role === 'assistant');
            return {
              appointmentItemId: item.id,
              sequenceNo: item.sequence_no,
              serviceName: item.service_name_snapshot,
              quotePriceMinor: Number(item.quote_price_minor),
              quantity: 1,
              primaryStaff: primary ? { id: primary.staffId, name: primary.name } : null,
              assistantStaff: assistants.map(assistant => ({ id: assistant.staffId, name: assistant.name }))
            };
          }),
          checkout: existing && {
            id: existing.id,
            status: existing.status,
            quoteTotalMinor: Number(existing.quote_total_minor),
            actualTotalMinor: Number(existing.actual_total_minor),
            discountTotalMinor: Number(existing.discount_total_minor),
            finalDueMinor: Number(existing.final_due_minor),
            paidMinor: Number(existing.paid_minor),
            isPaid: existing.status === 'paid'
          },
          checkoutLocked: Boolean(existing)
        }
      });
    } catch (error) {
      const status = error instanceof CheckoutReadError ? error.status : 500;
      const code = error instanceof CheckoutReadError ? error.code : 'CHECKOUT_SESSION_READ_FAILED';
      return res.status(status).json({ success: false, code });
    } finally { if (client) client.release(); }
  };
  return { getSession, CheckoutReadError };
};

module.exports = { createCheckoutPosRead, CheckoutReadError };
