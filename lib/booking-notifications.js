'use strict';

const isUuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const NOTIFICATION_EVENT_TYPES = Object.freeze([
  'booking_created',
  'booking_cancelled',
  'booking_rescheduled'
]);

const NOTIFICATION_RECIPIENT_TYPES = Object.freeze([
  'shop',
  'staff'
]);

/**
 * Formats Singapore time (HH:mm or HH:mm AM/PM) for notification summary.
 */
function formatSingaporeTime(dateLike, locale) {
  if (!dateLike) return '';
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  const isZh = String(locale || '').toLowerCase().startsWith('zh');
  try {
    return date.toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', {
      timeZone: 'Asia/Singapore',
      hour: '2-digit',
      minute: '2-digit',
      hour12: !isZh
    });
  } catch (_) {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * Generates localized notification summary.
 */
function formatNotificationSummary({ eventType, customerName, serviceName, startAt, locale }) {
  const isZh = String(locale || '').toLowerCase().startsWith('zh');
  const cust = customerName || (isZh ? '顾客' : 'Customer');
  const srv = serviceName || (isZh ? '服务项目' : 'Service');
  const time = formatSingaporeTime(startAt, locale);

  switch (eventType) {
    case 'booking_created':
      return isZh
        ? `新预约 · ${cust} · ${srv} · ${time}`
        : `New booking · ${cust} · ${srv} · ${time}`;
    case 'booking_cancelled':
      return isZh
        ? `预约已取消 · ${cust} · ${srv} · ${time}`
        : `Booking cancelled · ${cust} · ${srv} · ${time}`;
    case 'booking_rescheduled':
      return isZh
        ? `预约改期 · ${cust} · ${srv} · ${time}`
        : `Booking rescheduled · ${cust} · ${srv} · ${time}`;
    default:
      return `${cust} · ${srv} · ${time}`;
  }
}

/**
 * Creates idempotent server-side booking notifications for shop and assigned staff.
 * If the appointment has no assigned staff (e.g. no-preference), staff notifications are NOT created.
 */
async function createBookingNotification(clientOrPool, {
  shopId,
  appointmentId,
  eventType,
  dedupeSource = '',
  metadata = {}
}) {
  if (!clientOrPool || !isUuid(shopId) || !isUuid(appointmentId)) {
    return { created: 0 };
  }
  if (!NOTIFICATION_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Invalid notification event type: ${eventType}`);
  }

  try {
    // 1. Resolve assigned staff for this appointment
    const assignedStaffResult = await clientOrPool.query(
      `
      SELECT DISTINCT x.staff_id
      FROM appointment_item_staff_assignments x
      JOIN appointment_items i ON i.id = x.appointment_item_id
      WHERE i.shop_id = $1 AND i.appointment_id = $2 AND x.staff_id IS NOT NULL
      UNION
      SELECT a.staff_id
      FROM appointments a
      WHERE a.shop_id = $1 AND a.id = $2 AND a.staff_id IS NOT NULL
      `,
      [shopId, appointmentId]
    );

    const assignedStaffIds = assignedStaffResult.rows
      .map(r => r.staff_id)
      .filter(id => isUuid(id));

    const metaJson = JSON.stringify(metadata || {});
    let createdCount = 0;

    // 2. Insert shop notification (for Owner / Front Desk)
    const shopDedupeKey = `${eventType}:${appointmentId}:${dedupeSource || 'default'}:shop`;
    const shopInsert = await clientOrPool.query(
      `
      INSERT INTO booking_notifications (
        shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key, metadata
      ) VALUES ($1, $2, $3, 'shop', NULL, $4, $5)
      ON CONFLICT (shop_id, dedupe_key) DO NOTHING
      RETURNING id
      `,
      [shopId, appointmentId, eventType, shopDedupeKey, metaJson]
    );
    if (shopInsert.rows.length > 0) createdCount++;

    // 3. Insert staff notification for each assigned employee
    for (const staffId of assignedStaffIds) {
      const staffDedupeKey = `${eventType}:${appointmentId}:${dedupeSource || 'default'}:staff:${staffId}`;
      const staffInsert = await clientOrPool.query(
        `
        INSERT INTO booking_notifications (
          shop_id, appointment_id, event_type, recipient_type, recipient_staff_id, dedupe_key, metadata
        ) VALUES ($1, $2, $3, 'staff', $4, $5, $6)
        ON CONFLICT (shop_id, dedupe_key) DO NOTHING
        RETURNING id
        `,
        [shopId, appointmentId, eventType, staffId, staffDedupeKey, metaJson]
      );
      if (staffInsert.rows.length > 0) createdCount++;
    }

    return { created: createdCount };
  } catch (err) {
    // If table doesn't exist yet (relation "booking_notifications" does not exist), fail gracefully
    if (err && (err.code === '42P01' || String(err.message || '').includes('booking_notifications'))) {
      return { created: 0, skipped: true };
    }
    if (!process.argv.includes('--test') && process.env.NODE_ENV !== 'test' && !String(err.message || '').includes('Unexpected')) {
      console.error('Error creating booking notification:', err);
    }
    return { created: 0, error: err.message };
  }
}

/**
 * Lists notifications with authorized appointment context (strictly excluding full customer phone).
 */
async function listNotifications(pool, {
  shopId,
  recipientType = 'shop',
  recipientStaffId = null,
  limit = 20,
  unreadOnly = false,
  locale = 'zh-CN'
}) {
  if (!pool || !isUuid(shopId)) return { notifications: [], unreadCount: 0 };
  if (!NOTIFICATION_RECIPIENT_TYPES.includes(recipientType)) return { notifications: [], unreadCount: 0 };
  if (recipientType === 'staff' && !isUuid(recipientStaffId)) return { notifications: [], unreadCount: 0 };

  const parsedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));

  try {
    const unreadCountResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM booking_notifications
      WHERE shop_id = $1
        AND recipient_type = $2
        AND ($3::UUID IS NULL OR recipient_staff_id = $3::UUID)
        AND is_read = FALSE
      `,
      [shopId, recipientType, recipientStaffId]
    );
    const unreadCount = unreadCountResult.rows[0]?.count || 0;

    const listResult = await pool.query(
      `
      SELECT
        n.id,
        n.shop_id,
        n.appointment_id,
        n.event_type,
        n.recipient_type,
        n.recipient_staff_id,
        n.is_read,
        n.read_at,
        n.created_at,
        n.metadata,
        a.appointment_no,
        a.start_at,
        a.end_at,
        a.status AS appointment_status,
        c.name AS customer_name,
        COALESCE(
          (SELECT s.name FROM services s WHERE s.id = a.service_id AND s.shop_id = a.shop_id),
          (SELECT i.service_name_snapshot FROM appointment_items i WHERE i.appointment_id = a.id ORDER BY i.sequence_no LIMIT 1),
          'Service'
        ) AS service_name,
        COALESCE(
          (SELECT st.name FROM staff st WHERE st.id = a.staff_id AND st.shop_id = a.shop_id),
          (SELECT st.name FROM appointment_item_staff_assignments x JOIN staff st ON st.id = x.staff_id JOIN appointment_items i ON i.id = x.appointment_item_id WHERE i.appointment_id = a.id LIMIT 1),
          NULL
        ) AS staff_name
      FROM booking_notifications n
      LEFT JOIN appointments a ON a.id = n.appointment_id AND a.shop_id = n.shop_id
      LEFT JOIN customers c ON c.id = a.recipient_customer_id AND c.shop_id = a.shop_id
      WHERE n.shop_id = $1
        AND n.recipient_type = $2
        AND ($3::UUID IS NULL OR n.recipient_staff_id = $3::UUID)
        AND ($4::BOOLEAN IS FALSE OR n.is_read = FALSE)
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $5
      `,
      [shopId, recipientType, recipientStaffId, Boolean(unreadOnly), parsedLimit]
    );

    const notifications = listResult.rows.map(row => {
      const summary = formatNotificationSummary({
        eventType: row.event_type,
        customerName: row.customer_name,
        serviceName: row.service_name,
        startAt: row.start_at,
        locale
      });

      return {
        id: row.id,
        appointmentId: row.appointment_id,
        eventType: row.event_type,
        isRead: Boolean(row.is_read),
        readAt: row.read_at,
        createdAt: row.created_at,
        summary,
        appointment: {
          id: row.appointment_id,
          appointmentNo: row.appointment_no,
          startAt: row.start_at,
          endAt: row.end_at,
          status: row.appointment_status,
          customerName: row.customer_name || '',
          serviceName: row.service_name || '',
          staffName: row.staff_name || ''
        }
      };
    });

    return { notifications, unreadCount };
  } catch (err) {
    if (err && (err.code === '42P01' || String(err.message || '').includes('booking_notifications'))) {
      return { notifications: [], unreadCount: 0 };
    }
    throw err;
  }
}

/**
 * Gets unread count for recipient scope.
 */
async function getUnreadCount(pool, { shopId, recipientType = 'shop', recipientStaffId = null }) {
  if (!pool || !isUuid(shopId)) return 0;
  if (!NOTIFICATION_RECIPIENT_TYPES.includes(recipientType)) return 0;
  if (recipientType === 'staff' && !isUuid(recipientStaffId)) return 0;

  try {
    const result = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM booking_notifications
      WHERE shop_id = $1
        AND recipient_type = $2
        AND ($3::UUID IS NULL OR recipient_staff_id = $3::UUID)
        AND is_read = FALSE
      `,
      [shopId, recipientType, recipientStaffId]
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    if (err && (err.code === '42P01' || String(err.message || '').includes('booking_notifications'))) {
      return 0;
    }
    throw err;
  }
}

/**
 * Marks one notification as read with tenant and recipient authorization.
 */
async function markNotificationRead(pool, {
  shopId,
  notificationId,
  recipientType = 'shop',
  recipientStaffId = null
}) {
  if (!pool || !isUuid(shopId) || !isUuid(notificationId)) return false;

  try {
    const result = await pool.query(
      `
      UPDATE booking_notifications
      SET is_read = TRUE, read_at = NOW()
      WHERE id = $1
        AND shop_id = $2
        AND recipient_type = $3
        AND ($4::UUID IS NULL OR recipient_staff_id = $4::UUID)
      RETURNING id
      `,
      [notificationId, shopId, recipientType, recipientStaffId]
    );
    return result.rows.length === 1;
  } catch (err) {
    if (err && (err.code === '42P01' || String(err.message || '').includes('booking_notifications'))) {
      return false;
    }
    throw err;
  }
}

/**
 * Marks all notifications as read for the recipient scope.
 */
async function markAllNotificationsRead(pool, {
  shopId,
  recipientType = 'shop',
  recipientStaffId = null
}) {
  if (!pool || !isUuid(shopId)) return { updated: 0 };

  try {
    const result = await pool.query(
      `
      UPDATE booking_notifications
      SET is_read = TRUE, read_at = NOW()
      WHERE shop_id = $1
        AND recipient_type = $2
        AND ($3::UUID IS NULL OR recipient_staff_id = $3::UUID)
        AND is_read = FALSE
      RETURNING id
      `,
      [shopId, recipientType, recipientStaffId]
    );
    return { updated: result.rows.length };
  } catch (err) {
    if (err && (err.code === '42P01' || String(err.message || '').includes('booking_notifications'))) {
      return { updated: 0 };
    }
    throw err;
  }
}

module.exports = {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_RECIPIENT_TYPES,
  formatSingaporeTime,
  formatNotificationSummary,
  createBookingNotification,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead
};
