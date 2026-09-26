'use strict';

const CUSTOMER_READ_ROLES = Object.freeze(['owner', 'manager', 'admin', 'front_desk']);
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DETAIL_VISIT_LIMIT = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const positiveInt = (value, fallback, maximum) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const listCustomers = async (pool, { shopId, query }) => {
  const page = positiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const offset = (page - 1) * pageSize;
  const searched = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const result = await pool.query(
    `SELECT c.id, c.name, c.phone, c.member_code, c.identity_status,
            (SELECT a.start_at
               FROM appointments a
              WHERE a.shop_id = c.shop_id
                AND a.recipient_customer_id = c.id
                AND a.start_at < NOW()
                AND a.status IN ('completed','arrived','in_service')
              ORDER BY a.start_at DESC, a.id DESC LIMIT 1) AS last_visit_at
       FROM customers c
      WHERE c.shop_id = $1
        AND ($2::TEXT IS NULL OR c.name ILIKE $2 ESCAPE '\\'
             OR c.phone ILIKE $2 ESCAPE '\\'
             OR c.phone_normalized ILIKE $2 ESCAPE '\\'
             OR c.member_code ILIKE $2 ESCAPE '\\')
      ORDER BY c.name ASC, c.id ASC
      LIMIT $3 OFFSET $4`,
    [shopId, searched, pageSize, offset]
  );
  return {
    page, pageSize, hasMore: result.rows.length === pageSize,
    customers: result.rows.map(row => ({
      id: row.id, name: row.name, phone: row.phone, memberCode: row.member_code,
      identityStatus: row.identity_status, lastVisitAt: row.last_visit_at || null
    }))
  };
};

const getCustomer = async (pool, { shopId, customerId }) => {
  if (!UUID.test(customerId)) return null;
  const customer = await pool.query(
    `SELECT id, name, phone, email, date_of_birth, member_code, identity_status,
            phone_verified_at, gender, profile_notes
       FROM customers WHERE id = $1 AND shop_id = $2`, [customerId, shopId]
  );
  if (customer.rows.length !== 1) return null;
  const visits = await pool.query(
    `SELECT a.id, a.appointment_no, a.start_at, a.end_at, a.status, a.booking_source,
            COALESCE(items.items, json_build_array(json_build_object(
              'legacy', true, 'serviceName', s.name, 'durationMinutes', s.duration_minutes,
              'startAt', a.start_at, 'endAt', a.end_at, 'status', a.status,
              'staffAssignments', json_build_array(json_build_object('role','primary','staffName',st.name))
            ))) AS items
       FROM appointments a
       JOIN services s ON s.id = a.service_id AND s.shop_id = a.shop_id
       JOIN staff st ON st.id = a.staff_id AND st.shop_id = a.shop_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
           'itemId', i.id, 'sequenceNo', i.sequence_no,
           'serviceName', i.service_name_snapshot, 'durationMinutes', i.duration_minutes_snapshot,
           'priceSnapshot', i.price_snapshot, 'startAt', i.start_at, 'endAt', i.end_at,
           'status', i.status, 'staffAssignments', COALESCE(assignments.staff_assignments, '[]'::json)
         ) ORDER BY i.sequence_no, i.id) AS items
         FROM appointment_items i
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('role', x.role, 'staffId', x.staff_id,
             'staffName', assigned.name, 'startAt', x.start_at, 'endAt', x.end_at)
             ORDER BY CASE x.role WHEN 'primary' THEN 0 ELSE 1 END, x.id) AS staff_assignments
           FROM appointment_item_staff_assignments x
           JOIN staff assigned ON assigned.id = x.staff_id AND assigned.shop_id = x.shop_id
           WHERE x.shop_id = i.shop_id AND x.location_id = i.location_id
             AND x.appointment_item_id = i.id
         ) assignments ON TRUE
         WHERE i.shop_id = a.shop_id AND i.location_id = a.location_id AND i.appointment_id = a.id
       ) items ON TRUE
      WHERE a.shop_id = $1 AND a.recipient_customer_id = $2
      ORDER BY a.start_at DESC, a.id DESC LIMIT $3`, [shopId, customerId, DETAIL_VISIT_LIMIT]
  );
  const row = customer.rows[0];
  return {
    customer: {
      id: row.id, name: row.name, phone: row.phone, email: row.email || null,
      dateOfBirth: row.date_of_birth || null, memberCode: row.member_code || null,
      identityStatus: row.identity_status, phoneVerifiedAt: row.phone_verified_at || null,
      gender: row.gender || null, profileNotes: row.profile_notes || ''
    },
    visits: visits.rows.map(visit => ({
      id: visit.id, appointmentNo: visit.appointment_no, startAt: visit.start_at, endAt: visit.end_at,
      status: visit.status, bookingSource: visit.booking_source || null,
      items: Array.isArray(visit.items) ? visit.items : JSON.parse(visit.items || '[]')
    })),
    visitLimit: DETAIL_VISIT_LIMIT
  };
};

module.exports = { CUSTOMER_READ_ROLES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listCustomers, getCustomer };
