'use strict';

const STAFF_FIELDS = new Set([
  'name',
  'phone',
  'email',
  'staffCode',
  'bookable',
  'isActive'
]);

const FIELD_LIMITS = {
  name: 200,
  phone: 50,
  email: 254,
  staffCode: 50
};

class OwnerStaffError extends Error {
  constructor(code, status, publicMessage) {
    super(code);
    this.name = 'OwnerStaffError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const validateStaffFields = (body, { partial }) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '员工资料格式不正确' };
  }

  const keys = Object.keys(body);

  if (keys.some(key => !STAFF_FIELDS.has(key))) {
    return { error: '包含不支持的员工字段' };
  }

  if (partial && keys.length === 0) {
    return { error: '没有可更新的员工字段' };
  }

  if (!partial && !keys.includes('name')) {
    return { error: '员工姓名不能为空' };
  }

  const values = {};

  if (keys.includes('name')) {
    if (typeof body.name !== 'string') {
      return { error: '员工姓名格式不正确' };
    }

    values.name = body.name.trim();

    if (!values.name || values.name.length > FIELD_LIMITS.name) {
      return { error: '员工姓名长度不正确' };
    }
  }

  for (const field of ['phone', 'email', 'staffCode']) {
    if (!keys.includes(field)) {
      continue;
    }

    if (body[field] === null) {
      values[field] = null;
      continue;
    }

    if (typeof body[field] !== 'string') {
      return { error: `${field} 格式不正确` };
    }

    const value = body[field].trim();

    if (value.length > FIELD_LIMITS[field]) {
      return { error: `${field} 长度不正确` };
    }

    values[field] = value || null;
  }

  if (
    values.email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
  ) {
    return { error: 'email 格式不正确' };
  }

  for (const field of ['bookable', 'isActive']) {
    if (keys.includes(field) && typeof body[field] !== 'boolean') {
      return { error: `${field} 格式不正确` };
    }

    if (keys.includes(field)) {
      values[field] = body[field];
    }
  }

  return { values };
};

const validateLocationIds = (body, isUuid) => {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(key => key !== 'locationIds') ||
    !Array.isArray(body.locationIds)
  ) {
    return { error: '地点列表格式不正确' };
  }

  if (body.locationIds.some(id => !isUuid(id))) {
    return { error: '地点ID不正确' };
  }

  return { locationIds: [...new Set(body.locationIds)] };
};

const STAFF_RETURNING_SQL = `
  id,
  name,
  phone,
  email,
  staff_code,
  bookable,
  is_active,
  created_at,
  updated_at
`;

const createOwnerStaffManagement = ({
  pool,
  isUuid,
  runInTransaction,
  safeErrorCode
}) => {
  const sendError = (response, error, fallbackMessage) => {
    if (
      error instanceof OwnerStaffError &&
      [400, 404, 409].includes(error.status)
    ) {
      return response.status(error.status).json({
        success: false,
        code: error.code,
        message: error.publicMessage
      });
    }

    console.error('Owner staff management error:', safeErrorCode(error));
    return response.status(500).json({
      success: false,
      message: fallbackMessage
    });
  };

  const listStaff = async (request, response) => {
    let client;

    try {
      client = await pool.connect();
      const result = await client.query(
        `
        SELECT
          staff_member.id,
          staff_member.name,
          staff_member.phone,
          staff_member.email,
          staff_member.staff_code,
          staff_member.bookable,
          staff_member.is_active,
          staff_member.created_at,
          staff_member.updated_at,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', location.id,
                'name', location.name,
                'isPrimary', assignment.is_primary
              )
              ORDER BY location.name
            ) FILTER (WHERE location.id IS NOT NULL),
            '[]'::JSONB
          ) AS locations
        FROM staff AS staff_member
        LEFT JOIN staff_location_assignments AS assignment
          ON assignment.shop_id = staff_member.shop_id
         AND assignment.staff_id = staff_member.id
         AND assignment.is_active = TRUE
        LEFT JOIN locations AS location
          ON location.shop_id = staff_member.shop_id
         AND location.id = assignment.location_id
         AND location.is_active = TRUE
        WHERE staff_member.shop_id = $1
        GROUP BY staff_member.id
        ORDER BY staff_member.name ASC
        `,
        [request.ownerAuth.shopId]
      );

      return response.json({ success: true, data: result.rows });
    } catch (error) {
      return sendError(response, error, '读取员工资料失败');
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  const createStaff = async (request, response) => {
    const validation = validateStaffFields(request.body, {
      partial: false
    });

    if (validation.error) {
      return response.status(400).json({
        success: false,
        message: validation.error
      });
    }

    const values = validation.values;
    let client;

    try {
      client = await pool.connect();
      const result = await client.query(
        `
        INSERT INTO staff (
          shop_id,
          name,
          phone,
          email,
          staff_code,
          bookable,
          is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING ${STAFF_RETURNING_SQL}
        `,
        [
          request.ownerAuth.shopId,
          values.name,
          values.phone ?? null,
          values.email ?? null,
          values.staffCode ?? null,
          values.bookable ?? false,
          values.isActive ?? true
        ]
      );

      if (result.rows.length !== 1) {
        throw new Error('owner_staff_insert_rowcount');
      }

      return response.status(201).json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      return sendError(response, error, '创建员工失败');
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  const updateStaff = async (request, response) => {
    if (!isUuid(request.params.staffId)) {
      return response.status(400).json({
        success: false,
        message: '员工ID不正确'
      });
    }

    const validation = validateStaffFields(request.body, {
      partial: true
    });

    if (validation.error) {
      return response.status(400).json({
        success: false,
        message: validation.error
      });
    }

    const values = validation.values;
    const columnByField = {
      name: 'name',
      phone: 'phone',
      email: 'email',
      staffCode: 'staff_code',
      bookable: 'bookable',
      isActive: 'is_active'
    };

    try {
      const staff = await runInTransaction(pool, async client => {
        const currentResult = await client.query(
          `
          SELECT id, is_active
          FROM staff
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
          `,
          [request.params.staffId, request.ownerAuth.shopId]
        );

        if (currentResult.rows.length !== 1) {
          throw new OwnerStaffError(
            'STAFF_NOT_FOUND',
            404,
            '未找到该员工'
          );
        }

        if (
          currentResult.rows[0].is_active === true &&
          values.isActive === false
        ) {
          const futureResult = await client.query(
            `
            SELECT appointment.id
            FROM appointments AS appointment
            WHERE appointment.shop_id = $1
              AND appointment.end_at > NOW()
              AND appointment.status IN ('pending', 'confirmed')
              AND (
                appointment.staff_id = $2
                OR EXISTS (
                  SELECT 1
                  FROM appointment_items AS item
                  JOIN appointment_item_staff_assignments AS item_assignment
                    ON item_assignment.shop_id = item.shop_id
                   AND item_assignment.location_id = item.location_id
                   AND item_assignment.appointment_item_id = item.id
                  WHERE item.shop_id = appointment.shop_id
                    AND item.appointment_id = appointment.id
                    AND item_assignment.staff_id = $2
                )
              )
            LIMIT 1
            `,
            [request.ownerAuth.shopId, request.params.staffId]
          );

          if (futureResult.rows.length > 0) {
            throw new OwnerStaffError(
              'STAFF_HAS_FUTURE_APPOINTMENTS',
              409,
              '该员工仍有未来预约，暂时不能停用'
            );
          }
        }

        const entries = Object.entries(values);
        const parameters = entries.map(([, value]) => value);
        const assignments = entries.map(
          ([field], index) =>
            `${columnByField[field]} = $${index + 1}`
        );
        const staffIdParameter = parameters.length + 1;
        const shopIdParameter = parameters.length + 2;
        parameters.push(
          request.params.staffId,
          request.ownerAuth.shopId
        );

        const updateResult = await client.query(
          `
          UPDATE staff
          SET
            ${assignments.join(',\n            ')},
            updated_at = NOW()
          WHERE id = $${staffIdParameter}
            AND shop_id = $${shopIdParameter}
          RETURNING ${STAFF_RETURNING_SQL}
          `,
          parameters
        );

        if (updateResult.rows.length !== 1) {
          throw new Error('owner_staff_update_rowcount');
        }

        return updateResult.rows[0];
      });

      return response.json({ success: true, data: staff });
    } catch (error) {
      return sendError(response, error, '更新员工失败');
    }
  };

  const listStaffLocations = async (request, response) => {
    if (!isUuid(request.params.staffId)) {
      return response.status(400).json({
        success: false,
        message: '员工ID不正确'
      });
    }

    let client;

    try {
      client = await pool.connect();
      const staffResult = await client.query(
        `
        SELECT id
        FROM staff
        WHERE id = $1
          AND shop_id = $2
        LIMIT 1
        `,
        [request.params.staffId, request.ownerAuth.shopId]
      );

      if (staffResult.rows.length !== 1) {
        throw new OwnerStaffError(
          'STAFF_NOT_FOUND',
          404,
          '未找到该员工'
        );
      }

      const result = await client.query(
        `
        SELECT
          location.id,
          location.name,
          location.timezone,
          location.is_active,
          COALESCE(assignment.is_active, FALSE) AS assigned,
          COALESCE(assignment.is_primary, FALSE) AS is_primary
        FROM locations AS location
        LEFT JOIN staff_location_assignments AS assignment
          ON assignment.shop_id = location.shop_id
         AND assignment.location_id = location.id
         AND assignment.staff_id = $2
        WHERE location.shop_id = $1
        ORDER BY location.name ASC
        `,
        [request.ownerAuth.shopId, request.params.staffId]
      );

      return response.json({ success: true, data: result.rows });
    } catch (error) {
      return sendError(response, error, '读取员工地点失败');
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  const replaceStaffLocations = async (request, response) => {
    if (!isUuid(request.params.staffId)) {
      return response.status(400).json({
        success: false,
        message: '员工ID不正确'
      });
    }

    const validation = validateLocationIds(request.body, isUuid);

    if (validation.error) {
      return response.status(400).json({
        success: false,
        message: validation.error
      });
    }

    try {
      const locations = await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");

        const staffResult = await client.query(
          `
          SELECT id
          FROM staff
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
          `,
          [request.params.staffId, request.ownerAuth.shopId]
        );

        if (staffResult.rows.length !== 1) {
          throw new OwnerStaffError(
            'STAFF_NOT_FOUND',
            404,
            '未找到该员工'
          );
        }

        const locationResult = validation.locationIds.length === 0
          ? { rows: [] }
          : await client.query(
              `
              SELECT id
              FROM locations
              WHERE shop_id = $1
                AND id = ANY($2::UUID[])
                AND is_active = TRUE
              FOR UPDATE
              `,
              [request.ownerAuth.shopId, validation.locationIds]
            );

        if (locationResult.rows.length !== validation.locationIds.length) {
          throw new OwnerStaffError(
            'LOCATION_NOT_FOUND',
            404,
            '一个或多个地点不存在或不可用'
          );
        }

        await client.query(
          `
          SELECT id
          FROM staff_location_assignments
          WHERE shop_id = $1
            AND staff_id = $2
          FOR UPDATE
          `,
          [request.ownerAuth.shopId, request.params.staffId]
        );

        await client.query(
          `
          UPDATE staff_location_assignments
          SET
            is_active = FALSE,
            is_primary = FALSE,
            updated_at = NOW()
          WHERE shop_id = $1
            AND staff_id = $2
            AND is_active = TRUE
            AND NOT (location_id = ANY($3::UUID[]))
          `,
          [
            request.ownerAuth.shopId,
            request.params.staffId,
            validation.locationIds
          ]
        );

        const upsertResult = validation.locationIds.length === 0
          ? { rows: [] }
          : await client.query(
              `
              INSERT INTO staff_location_assignments (
                shop_id,
                staff_id,
                location_id,
                is_active,
                is_primary
              )
              SELECT $1, $2, location_id, TRUE, FALSE
              FROM UNNEST($3::UUID[]) AS location_id
              ON CONFLICT (shop_id, staff_id, location_id)
              DO UPDATE SET
                is_active = TRUE,
                updated_at = NOW()
              RETURNING location_id
              `,
              [
                request.ownerAuth.shopId,
                request.params.staffId,
                validation.locationIds
              ]
            );

        if (upsertResult.rows.length !== validation.locationIds.length) {
          throw new Error('staff_location_assignment_rowcount');
        }

        return locationResult.rows.map(row => row.id);
      });

      return response.json({
        success: true,
        data: { locationIds: locations }
      });
    } catch (error) {
      return sendError(response, error, '更新员工地点失败');
    }
  };

  return {
    listStaff,
    createStaff,
    updateStaff,
    listStaffLocations,
    replaceStaffLocations
  };
};

module.exports = {
  OwnerStaffError,
  createOwnerStaffManagement,
  validateLocationIds,
  validateStaffFields
};
