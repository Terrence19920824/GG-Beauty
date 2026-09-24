'use strict';

const { normalizePhone } = require('./customer-identity');

// In-memory sliding-window rate limiter
const rateLimitMap = new Map();

const checkRateLimit = (key, { maxRequests = 15, windowMs = 60000 } = {}) => {
  if (!key) return { allowed: true };
  const now = Date.now();
  let timestamps = rateLimitMap.get(key) || [];
  timestamps = timestamps.filter(ts => now - ts < windowMs);
  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    rateLimitMap.set(key, timestamps);
    return { allowed: false, retryAfterSeconds };
  }
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);

  // Periodically clean up stale keys
  if (rateLimitMap.size > 2000) {
    for (const [k, list] of rateLimitMap.entries()) {
      if (!list.some(ts => now - ts < windowMs)) {
        rateLimitMap.delete(k);
      }
    }
  }
  return { allowed: true };
};

const clearRateLimit = key => {
  if (key) rateLimitMap.delete(key);
  else rateLimitMap.clear();
};

const normalizeCustomerQueryPhone = (countryCode, phone) => {
  const trimmed = typeof phone === 'string' ? phone.trim() : '';
  if (!trimmed) return null;
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    return normalizePhone(trimmed);
  }
  const cleanCode = typeof countryCode === 'string'
    ? countryCode.trim().replace(/^[+]/, '')
    : '65';
  const cleanPhone = trimmed.replace(/^0+/, '').replace(/[\s().-]+/g, '');
  return normalizePhone(`+${cleanCode}${cleanPhone}`);
};

const queryCustomerBookings = async (pool, { shopId, phoneNormalized, rawPhone }) => {
  if (!shopId) return [];
  const normalized = phoneNormalized || null;
  const raw = typeof rawPhone === 'string' ? rawPhone.trim() : null;
  if (!normalized && !raw) return [];

  const query = `
    SELECT
      a.id,
      a.appointment_no,
      a.start_at,
      a.end_at,
      a.status,
      a.created_at,
      ai.items,
      legacy_s.name AS legacy_service_name,
      legacy_s.duration_minutes AS legacy_duration,
      legacy_st.name AS legacy_staff_name
    FROM appointments a
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'sequenceNo', i.sequence_no,
          'name', i.service_name_snapshot,
          'durationMinutes', i.duration_minutes_snapshot,
          'staffName', st.name
        ) ORDER BY i.sequence_no ASC
      ) AS items
      FROM appointment_items i
      LEFT JOIN appointment_item_staff_assignments sa
        ON sa.appointment_item_id = i.id AND sa.shop_id = a.shop_id AND sa.role = 'primary'
      LEFT JOIN staff st ON st.id = sa.staff_id AND st.shop_id = a.shop_id
      WHERE i.appointment_id = a.id AND i.shop_id = a.shop_id
    ) ai ON true
    LEFT JOIN services legacy_s ON legacy_s.id = a.service_id
    LEFT JOIN staff legacy_st ON legacy_st.id = a.staff_id
    WHERE a.shop_id = $1
      AND (
        ($2::text IS NOT NULL AND a.booker_phone_snapshot = $2)
        OR ($3::text IS NOT NULL AND a.booker_phone_snapshot = $3)
        OR ($2::text IS NOT NULL AND a.recipient_phone_snapshot = $2)
        OR ($3::text IS NOT NULL AND a.recipient_phone_snapshot = $3)
        OR EXISTS (
          SELECT 1 FROM customers c
          WHERE c.id = a.customer_id
            AND c.shop_id = a.shop_id
            AND (
              ($2::text IS NOT NULL AND c.phone_normalized = $2)
              OR ($3::text IS NOT NULL AND c.phone = $3)
            )
        )
      )
    ORDER BY a.start_at DESC
    LIMIT 50
  `;

  const result = await pool.query(query, [shopId, normalized, raw]);

  return result.rows.map(row => {
    let services = [];
    if (Array.isArray(row.items) && row.items.length > 0) {
      services = row.items.map(item => ({
        name: String(item.name || ''),
        durationMinutes: Number(item.durationMinutes) || 0,
        staffName: item.staffName ? String(item.staffName) : null
      }));
    } else if (row.legacy_service_name) {
      services = [{
        name: String(row.legacy_service_name || ''),
        durationMinutes: Number(row.legacy_duration) || 0,
        staffName: row.legacy_staff_name ? String(row.legacy_staff_name) : null
      }];
    }

    return {
      appointmentNo: String(row.appointment_no || (row.id ? String(row.id).slice(0, 8) : '')),
      startAt: row.start_at ? new Date(row.start_at).toISOString() : '',
      endAt: row.end_at ? new Date(row.end_at).toISOString() : '',
      status: String(row.status || 'pending'),
      services
    };
  });
};

module.exports = {
  checkRateLimit,
  clearRateLimit,
  normalizeCustomerQueryPhone,
  queryCustomerBookings
};
