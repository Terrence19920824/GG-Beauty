'use strict';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ALLOWED_BODY_FIELDS = new Set(['serviceId', 'staffId', 'idempotencyKey', 'locale']);
const ELIGIBLE_STATUSES = new Set(['arrived', 'in_service']);

class OwnerServiceAddonError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'OwnerServiceAddonError';
    this.code = code;
    this.status = status;
  }
}

const normalizeLocale = value => value === 'en' ? 'en' : 'zh-CN';
const AUTHORIZED_ROLES = new Set(['owner', 'manager', 'admin', 'front_desk']);
const isCommandKeyViolation = error =>
  error?.code === '23505' &&
  error?.constraint === 'appointment_item_mutation_commands_shop_key';

const commandPayload = row => ({
  commandId: row.id,
  appointmentId: row.appointment_id,
  appointmentItemId: row.appointment_item_id,
  serviceId: row.service_id,
  staffId: row.staff_id,
  sequenceNo: Number(row.item_sequence_no),
  startAt: row.item_start_at,
  endAt: row.item_end_at,
  appointmentEndAt: row.appointment_end_at_after,
  serviceName: row.service_name_snapshot,
  durationMinutes: Number(row.duration_minutes_snapshot),
  priceSnapshot: row.price_snapshot,
  status: row.item_status_snapshot,
  createdAt: row.created_at
});

const createOwnerAppointmentServiceAddon = ({
  pool,
  crypto,
  isUuid,
  validator,
  StaffBookabilityError,
  safeErrorCode = () => 'INTERNAL_ERROR'
}) => {
  const requestAuth = req => ({
    shopId: req.ownerAuth?.shopId,
    membershipId: req.ownerAuth?.membershipId,
    role: req.ownerAuth?.role
  });

  const isAuthorized = auth =>
    isUuid(auth.shopId) && isUuid(auth.membershipId) && AUTHORIZED_ROLES.has(auth.role);

  const setReadOnlyHeaders = res => {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    }
  };

  const readEligibleAppointment = async (client, { shopId, appointmentId }) => {
    const result = await client.query(
      `SELECT appointment.id,appointment.location_id,appointment.end_at,appointment.status,
              EXISTS (
                SELECT 1 FROM checkout_transactions checkout
                 WHERE checkout.shop_id=appointment.shop_id
                   AND checkout.appointment_id=appointment.id
              ) AS checkout_exists
         FROM appointments appointment
        WHERE appointment.id=$1 AND appointment.shop_id=$2`,
      [appointmentId, shopId]
    );
    if (result.rows.length !== 1) {
      throw new OwnerServiceAddonError('APPOINTMENT_NOT_FOUND', 404);
    }
    const appointment = result.rows[0];
    if (!ELIGIBLE_STATUSES.has(appointment.status)) {
      throw new OwnerServiceAddonError('APPOINTMENT_STATUS_NOT_ELIGIBLE', 409);
    }
    if (appointment.checkout_exists === true) {
      throw new OwnerServiceAddonError('CHECKOUT_ALREADY_EXISTS', 409);
    }
    return appointment;
  };

  const sendReadError = (res, error, fallbackCode) => {
    if (error instanceof OwnerServiceAddonError) {
      return res.status(error.status).json({ success: false, code: error.code });
    }
    console.error('Owner service add-on read error:', safeErrorCode(error));
    return res.status(500).json({ success: false, code: fallbackCode });
  };

  const fingerprint = ({ shopId, appointmentId, serviceId, staffId, locale }) =>
    crypto.createHash('sha256').update(JSON.stringify([
      'appointment_item_mutation', 1, 'service_item_added',
      shopId.toLowerCase(), appointmentId.toLowerCase(),
      serviceId.toLowerCase(), staffId.toLowerCase(), locale
    ])).digest('hex');

  const readCommand = async (shopId, idempotencyKey) => {
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(
        `SELECT * FROM appointment_item_mutation_commands
         WHERE shop_id=$1 AND idempotency_key=$2`,
        [shopId, idempotencyKey]
      );
      return result.rows[0] || null;
    } finally {
      if (client) client.release();
    }
  };

  const replayOrConflict = (row, expectedFingerprint) => {
    if (!row || row.request_fingerprint !== expectedFingerprint) {
      throw new OwnerServiceAddonError('IDEMPOTENCY_CONFLICT', 409);
    }
    return { data: commandPayload(row), idempotent: true };
  };

  const listOptions = async (req, res) => {
    setReadOnlyHeaders(res);
    const appointmentId = typeof req.params.appointmentId === 'string' ? req.params.appointmentId.trim() : '';
    const auth = requestAuth(req);
    if (!isUuid(appointmentId)) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST' });
    }
    if (!isAuthorized(auth)) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
    }

    const locale = normalizeLocale(req.query?.locale);
    let client;
    try {
      client = await pool.connect();
      const appointment = await readEligibleAppointment(client, {
        shopId: auth.shopId,
        appointmentId
      });
      const result = await client.query(
        `SELECT service.id AS service_id,
                service.category_id,
                COALESCE(requested_service.name,english_service.name,chinese_service.name,service.name) AS display_name,
                service.duration_minutes,
                (ROUND(service.price * 100)::BIGINT)::TEXT AS price_minor,
                COALESCE(settings.currency_code,'SGD') AS currency_code,
                COALESCE(requested_category.name,english_category.name,chinese_category.name,category.canonical_name) AS category_name,
                category.sort_order AS category_sort_order,
                service.sort_order AS service_sort_order
           FROM services service
           JOIN service_categories category
             ON category.shop_id=service.shop_id
            AND category.id=service.category_id
            AND category.is_active=TRUE
           LEFT JOIN shop_customer_settings settings
             ON settings.shop_id=service.shop_id
           LEFT JOIN service_translations requested_service
             ON requested_service.shop_id=service.shop_id
            AND requested_service.service_id=service.id
            AND requested_service.locale=$3
           LEFT JOIN service_translations english_service
             ON english_service.shop_id=service.shop_id
            AND english_service.service_id=service.id
            AND english_service.locale='en'
           LEFT JOIN service_translations chinese_service
             ON chinese_service.shop_id=service.shop_id
            AND chinese_service.service_id=service.id
            AND chinese_service.locale='zh-CN'
           LEFT JOIN service_category_translations requested_category
             ON requested_category.shop_id=category.shop_id
            AND requested_category.category_id=category.id
            AND requested_category.locale=$3
           LEFT JOIN service_category_translations english_category
             ON english_category.shop_id=category.shop_id
            AND english_category.category_id=category.id
            AND english_category.locale='en'
           LEFT JOIN service_category_translations chinese_category
             ON chinese_category.shop_id=category.shop_id
            AND chinese_category.category_id=category.id
            AND chinese_category.locale='zh-CN'
          WHERE service.shop_id=$1
            AND service.is_active=TRUE
            AND service.bookable=TRUE
            AND service.duration_minutes > 0
            AND service.price IS NOT NULL
            AND service.price >= 0
            AND EXISTS (
              SELECT 1
                FROM staff_services capability
                JOIN staff member
                  ON member.shop_id=capability.shop_id
                 AND member.id=capability.staff_id
                 AND member.is_active=TRUE
                 AND member.bookable=TRUE
                JOIN staff_location_assignments location_assignment
                  ON location_assignment.shop_id=member.shop_id
                 AND location_assignment.staff_id=member.id
                 AND location_assignment.location_id=$2
                 AND location_assignment.is_active=TRUE
                JOIN locations location
                  ON location.shop_id=location_assignment.shop_id
                 AND location.id=location_assignment.location_id
                 AND location.is_active=TRUE
               WHERE capability.shop_id=service.shop_id
                 AND capability.service_id=service.id
                 AND capability.is_active=TRUE
            )
          ORDER BY category.sort_order,category.id,service.sort_order,service.name,service.id`,
        [auth.shopId, appointment.location_id, locale]
      );

      const categories = [];
      const categoryIds = new Set();
      const services = [];
      for (const row of result.rows) {
        const durationMinutes = Number(row.duration_minutes);
        const priceMinor = Number(row.price_minor);
        if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 ||
            !Number.isSafeInteger(priceMinor) || priceMinor < 0 ||
            !String(row.display_name || '').trim()) continue;
        if (!categoryIds.has(row.category_id)) {
          categoryIds.add(row.category_id);
          categories.push({
            categoryId: row.category_id,
            displayName: String(row.category_name || '').trim()
          });
        }
        services.push({
          serviceId: row.service_id,
          displayName: String(row.display_name).trim(),
          categoryId: row.category_id,
          durationMinutes,
          priceMinor,
          currencyCode: String(row.currency_code || 'SGD').trim().toUpperCase()
        });
      }
      return res.json({ success: true, data: { categories, services } });
    } catch (error) {
      return sendReadError(res, error, 'SERVICE_ADDON_OPTIONS_FAILED');
    } finally {
      if (client) client.release();
    }
  };

  const listStaffOptions = async (req, res) => {
    setReadOnlyHeaders(res);
    const appointmentId = typeof req.params.appointmentId === 'string' ? req.params.appointmentId.trim() : '';
    const serviceId = typeof req.query?.serviceId === 'string' ? req.query.serviceId.trim() : '';
    const auth = requestAuth(req);
    if (!isUuid(appointmentId) || !isUuid(serviceId)) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST' });
    }
    if (!isAuthorized(auth)) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
    }

    let client;
    try {
      client = await pool.connect();
      const appointment = await readEligibleAppointment(client, {
        shopId: auth.shopId,
        appointmentId
      });
      const serviceResult = await client.query(
        `SELECT service.id,service.duration_minutes
           FROM services service
           JOIN service_categories category
             ON category.shop_id=service.shop_id
            AND category.id=service.category_id
            AND category.is_active=TRUE
          WHERE service.id=$1 AND service.shop_id=$2
            AND service.is_active=TRUE AND service.bookable=TRUE
            AND service.duration_minutes > 0
            AND service.price IS NOT NULL AND service.price >= 0`,
        [serviceId, auth.shopId]
      );
      if (serviceResult.rows.length !== 1) {
        throw new OwnerServiceAddonError('SERVICE_INACTIVE', 422);
      }
      const durationMinutes = Number(serviceResult.rows[0].duration_minutes);
      if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
        throw new OwnerServiceAddonError('SERVICE_UNAVAILABLE', 422);
      }
      const timeResult = await client.query(
        `SELECT $1::TIMESTAMPTZ AS computed_start_at,
                $1::TIMESTAMPTZ + $2::INTEGER * INTERVAL '1 minute' AS computed_end_at`,
        [appointment.end_at, durationMinutes]
      );
      const computedStartAt = new Date(timeResult.rows[0].computed_start_at).toISOString();
      const computedEndAt = new Date(timeResult.rows[0].computed_end_at).toISOString();
      const candidatesResult = await client.query(
        `SELECT member.id AS staff_id,member.name AS display_name
           FROM staff_services capability
           JOIN staff member
             ON member.shop_id=capability.shop_id
            AND member.id=capability.staff_id
            AND member.is_active=TRUE
            AND member.bookable=TRUE
           JOIN staff_location_assignments location_assignment
             ON location_assignment.shop_id=member.shop_id
            AND location_assignment.staff_id=member.id
            AND location_assignment.location_id=$2
            AND location_assignment.is_active=TRUE
           JOIN locations location
             ON location.shop_id=location_assignment.shop_id
            AND location.id=location_assignment.location_id
            AND location.is_active=TRUE
          WHERE capability.shop_id=$1
            AND capability.service_id=$3
            AND capability.is_active=TRUE
          ORDER BY member.name,member.id`,
        [auth.shopId, appointment.location_id, serviceId]
      );

      const staffOptions = [];
      for (const candidate of candidatesResult.rows) {
        try {
          await validator({
            dbClient: client,
            shopId: auth.shopId,
            locationId: appointment.location_id,
            staffId: candidate.staff_id,
            serviceId,
            requestedStartAt: computedStartAt,
            requestedEndAt: computedEndAt,
            excludeAppointmentId: appointment.id
          });
          staffOptions.push({
            staffId: candidate.staff_id,
            displayName: String(candidate.display_name || '').trim()
          });
        } catch (error) {
          if (error instanceof StaffBookabilityError) continue;
          throw error;
        }
      }
      return res.json({
        success: true,
        data: { computedStartAt, computedEndAt, staffOptions }
      });
    } catch (error) {
      return sendReadError(res, error, 'SERVICE_ADDON_STAFF_OPTIONS_FAILED');
    } finally {
      if (client) client.release();
    }
  };

  const execute = async ({ auth, appointmentId, serviceId, staffId, idempotencyKey, locale, requestFingerprint }) => {
    let client;
    let transactionActive = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionActive = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");

      // Shared serialization authority with checkout and status mutations.
      const appointmentResult = await client.query(
        `SELECT id,shop_id,location_id,start_at,end_at,status
           FROM appointments
          WHERE id=$1 AND shop_id=$2
          FOR UPDATE`,
        [appointmentId, auth.shopId]
      );
      if (appointmentResult.rows.length !== 1) {
        throw new OwnerServiceAddonError('APPOINTMENT_NOT_FOUND', 404);
      }
      const appointment = appointmentResult.rows[0];

      const priorResult = await client.query(
        `SELECT * FROM appointment_item_mutation_commands
          WHERE shop_id=$1 AND idempotency_key=$2`,
        [auth.shopId, idempotencyKey]
      );
      if (priorResult.rows.length) {
        const replay = replayOrConflict(priorResult.rows[0], requestFingerprint);
        await client.query('COMMIT');
        transactionActive = false;
        return replay;
      }

      if (!ELIGIBLE_STATUSES.has(appointment.status)) {
        throw new OwnerServiceAddonError('APPOINTMENT_STATUS_NOT_ELIGIBLE', 409);
      }

      const checkoutResult = await client.query(
        `SELECT id FROM checkout_transactions
          WHERE shop_id=$1 AND appointment_id=$2 LIMIT 1`,
        [auth.shopId, appointment.id]
      );
      if (checkoutResult.rows.length) {
        throw new OwnerServiceAddonError('CHECKOUT_ALREADY_EXISTS', 409);
      }

      const itemsResult = await client.query(
        `SELECT id,sequence_no,start_at,end_at
           FROM appointment_items
          WHERE shop_id=$1 AND location_id=$2 AND appointment_id=$3
          ORDER BY sequence_no,id
          FOR UPDATE`,
        [auth.shopId, appointment.location_id, appointment.id]
      );
      if (!itemsResult.rows.length) {
        throw new OwnerServiceAddonError('APPOINTMENT_ITEMS_MISSING', 409);
      }
      const lastItem = itemsResult.rows[itemsResult.rows.length - 1];
      const nextSequence = Math.max(...itemsResult.rows.map(row => Number(row.sequence_no))) + 1;
      if (!Number.isInteger(nextSequence) || nextSequence < 2 ||
          new Date(lastItem.end_at).getTime() !== new Date(appointment.end_at).getTime()) {
        throw new OwnerServiceAddonError('APPOINTMENT_CHANGED_CONCURRENTLY', 409);
      }

      // Match the capability-management lock order: staff, mappings, service.
      const staffResult = await client.query(
        `SELECT id,name,is_active,bookable FROM staff
          WHERE id=$1 AND shop_id=$2 FOR SHARE`,
        [staffId, auth.shopId]
      );
      if (staffResult.rows.length !== 1 ||
          staffResult.rows[0].is_active !== true || staffResult.rows[0].bookable !== true) {
        throw new OwnerServiceAddonError('STAFF_UNAVAILABLE', 422);
      }

      const locationAssignmentResult = await client.query(
        `SELECT id,is_active FROM staff_location_assignments
          WHERE shop_id=$1 AND staff_id=$2 AND location_id=$3 FOR SHARE`,
        [auth.shopId, staffId, appointment.location_id]
      );
      if (locationAssignmentResult.rows.length !== 1 || locationAssignmentResult.rows[0].is_active !== true) {
        throw new OwnerServiceAddonError('STAFF_UNAVAILABLE', 422);
      }

      const capabilityResult = await client.query(
        `SELECT id,is_active FROM staff_services
          WHERE shop_id=$1 AND staff_id=$2 AND service_id=$3 FOR SHARE`,
        [auth.shopId, staffId, serviceId]
      );
      if (capabilityResult.rows.length !== 1 || capabilityResult.rows[0].is_active !== true) {
        throw new OwnerServiceAddonError('STAFF_NOT_CAPABLE', 422);
      }

      const serviceResult = await client.query(
        `SELECT service.id,service.name,service.duration_minutes,service.price,
                service.is_active,service.bookable,category.id AS category_id,
                category.is_active AS category_active
           FROM services service
           JOIN service_categories category
             ON category.shop_id=service.shop_id AND category.id=service.category_id
          WHERE service.id=$1 AND service.shop_id=$2
          FOR SHARE OF service,category`,
        [serviceId, auth.shopId]
      );
      const service = serviceResult.rows[0];
      if (!service || service.is_active !== true || service.bookable !== true || service.category_active !== true) {
        throw new OwnerServiceAddonError('SERVICE_INACTIVE', 422);
      }
      if (!Number.isInteger(Number(service.duration_minutes)) || Number(service.duration_minutes) <= 0 ||
          service.price === null || !Number.isFinite(Number(service.price)) || Number(service.price) < 0) {
        throw new OwnerServiceAddonError('SERVICE_UNAVAILABLE', 422);
      }

      const translationResult = await client.query(
        `SELECT name FROM service_translations
          WHERE shop_id=$1 AND service_id=$2 AND locale=$3 FOR SHARE`,
        [auth.shopId, serviceId, locale]
      );
      const serviceName = String(translationResult.rows[0]?.name || service.name || '').trim();
      if (!serviceName) throw new OwnerServiceAddonError('SERVICE_UNAVAILABLE', 422);

      const timeResult = await client.query(
        `SELECT $1::TIMESTAMPTZ AS start_at,
                $1::TIMESTAMPTZ + $2::INTEGER * INTERVAL '1 minute' AS end_at`,
        [appointment.end_at, Number(service.duration_minutes)]
      );
      const itemStartAt = timeResult.rows[0].start_at;
      const itemEndAt = timeResult.rows[0].end_at;

      try {
        await validator({
          dbClient: client,
          shopId: auth.shopId,
          locationId: appointment.location_id,
          staffId,
          serviceId,
          requestedStartAt: new Date(itemStartAt).toISOString(),
          requestedEndAt: new Date(itemEndAt).toISOString(),
          excludeAppointmentId: appointment.id
        });
      } catch (error) {
        if (error instanceof StaffBookabilityError) {
          if (error.code === 'APPOINTMENT_COLLISION') {
            throw new OwnerServiceAddonError('STAFF_TIME_CONFLICT', 409);
          }
          if (error.code === 'STAFF_SERVICE_NOT_ALLOWED') {
            throw new OwnerServiceAddonError('STAFF_NOT_CAPABLE', 422);
          }
          if (error.code === 'SERVICE_NOT_BOOKABLE') {
            throw new OwnerServiceAddonError('SERVICE_INACTIVE', 422);
          }
          throw new OwnerServiceAddonError('STAFF_UNAVAILABLE', 422);
        }
        throw error;
      }

      const itemResult = await client.query(
        `INSERT INTO appointment_items (
           shop_id,location_id,appointment_id,service_id,sequence_no,
           service_name_snapshot,service_locale_snapshot,duration_minutes_snapshot,
           price_snapshot,snapshot_source,start_at,end_at,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual_add',$10,$11,$12)
         RETURNING id,shop_id,location_id,appointment_id,service_id,sequence_no,
                   service_name_snapshot,duration_minutes_snapshot,price_snapshot,
                   start_at,end_at,status`,
        [auth.shopId, appointment.location_id, appointment.id, serviceId, nextSequence,
          serviceName, locale, Number(service.duration_minutes), service.price,
          itemStartAt, itemEndAt, appointment.status]
      );
      const item = itemResult.rows[0];

      const assignmentResult = await client.query(
        `INSERT INTO appointment_item_staff_assignments (
           shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at
         ) VALUES ($1,$2,$3,$4,'primary',$5,$6)
         RETURNING id,staff_id,role`,
        [auth.shopId, appointment.location_id, item.id, staffId, item.start_at, item.end_at]
      );
      if (assignmentResult.rows.length !== 1 || assignmentResult.rows[0].role !== 'primary') {
        throw new OwnerServiceAddonError('PRIMARY_ASSIGNMENT_FAILED', 500);
      }

      const parentResult = await client.query(
        `UPDATE appointments SET end_at=$1,updated_at=NOW()
          WHERE id=$2 AND shop_id=$3 AND location_id=$4 AND end_at=$5
          RETURNING end_at`,
        [item.end_at, appointment.id, auth.shopId, appointment.location_id, appointment.end_at]
      );
      if (parentResult.rows.length !== 1) {
        throw new OwnerServiceAddonError('APPOINTMENT_CHANGED_CONCURRENTLY', 409);
      }

      // Copy every audit snapshot from the authoritative inserted rows.
      const commandResult = await client.query(
        `INSERT INTO appointment_item_mutation_commands (
           shop_id,location_id,appointment_id,appointment_item_id,service_id,staff_id,
           mutation_type,operator_membership_id,operator_role_snapshot,idempotency_key,
           request_fingerprint,fingerprint_version,appointment_end_at_before,
           appointment_end_at_after,item_sequence_no,item_start_at,item_end_at,
           service_name_snapshot,duration_minutes_snapshot,price_snapshot,
           item_status_snapshot,staff_role_snapshot
         )
         SELECT item.shop_id,item.location_id,item.appointment_id,item.id,item.service_id,
                assignment.staff_id,'service_item_added',$1,$2,$3,$4,1,$5,item.end_at,
                item.sequence_no,item.start_at,item.end_at,item.service_name_snapshot,
                item.duration_minutes_snapshot,item.price_snapshot,item.status,assignment.role
           FROM appointment_items item
           JOIN appointment_item_staff_assignments assignment
             ON assignment.shop_id=item.shop_id
            AND assignment.location_id=item.location_id
            AND assignment.appointment_item_id=item.id
            AND assignment.role='primary'
          WHERE item.id=$6 AND item.shop_id=$7 AND assignment.staff_id=$8
         RETURNING *`,
        [auth.membershipId, auth.role, idempotencyKey, requestFingerprint,
          appointment.end_at, item.id, auth.shopId, staffId]
      );
      if (commandResult.rows.length !== 1) {
        throw new OwnerServiceAddonError('AUDIT_INSERT_FAILED', 500);
      }

      await client.query('COMMIT');
      transactionActive = false;
      return { data: commandPayload(commandResult.rows[0]), idempotent: false };
    } catch (error) {
      if (client && transactionActive) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (client) client.release();
    }
  };

  const addService = async (req, res) => {
    const appointmentId = typeof req.params.appointmentId === 'string' ? req.params.appointmentId.trim() : '';
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!isUuid(appointmentId) || !body) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST' });
    }
    if (Object.keys(body).some(key => !ALLOWED_BODY_FIELDS.has(key)) ||
        !isUuid(body.serviceId) || !isUuid(body.staffId) ||
        typeof body.idempotencyKey !== 'string' ||
        !IDEMPOTENCY_KEY_PATTERN.test(body.idempotencyKey) ||
        (body.locale !== undefined && !['zh-CN', 'en'].includes(body.locale))) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST' });
    }
    const auth = requestAuth(req);
    if (!isAuthorized(auth)) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
    }
    const locale = normalizeLocale(body.locale);
    const requestFingerprint = fingerprint({
      shopId: auth.shopId, appointmentId, serviceId: body.serviceId,
      staffId: body.staffId, locale
    });
    try {
      const result = await execute({ auth, appointmentId, serviceId: body.serviceId,
        staffId: body.staffId, idempotencyKey: body.idempotencyKey, locale, requestFingerprint });
      return res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      if (isCommandKeyViolation(error)) {
        try {
          const winner = await readCommand(auth.shopId, body.idempotencyKey);
          const replay = replayOrConflict(winner, requestFingerprint);
          return res.status(200).json({ success: true, ...replay });
        } catch (resolutionError) {
          error = resolutionError;
        }
      }
      if (error?.code === '23P01') error = new OwnerServiceAddonError('STAFF_TIME_CONFLICT', 409);
      if (error?.code === '55P03' || error?.code === '40001' || error?.code === '40P01') {
        error = new OwnerServiceAddonError('APPOINTMENT_CHANGED_CONCURRENTLY', 409);
      }
      if (error instanceof OwnerServiceAddonError) {
        return res.status(error.status).json({ success: false, code: error.code });
      }
      console.error('Owner service add-on error:', safeErrorCode(error));
      return res.status(500).json({ success: false, code: 'SERVICE_ADDON_FAILED' });
    }
  };

  return { listOptions, listStaffOptions, addService };
};

module.exports = {
  createOwnerAppointmentServiceAddon,
  OwnerServiceAddonError,
  IDEMPOTENCY_KEY_PATTERN,
  ELIGIBLE_STATUSES
};
