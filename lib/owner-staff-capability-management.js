'use strict';

const MAX_SERVICE_IDS = 500;

class OwnerStaffCapabilityError extends Error {
  constructor(code, status, publicMessage) {
    super(code);
    this.name = 'OwnerStaffCapabilityError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const validateServiceIds = (body, isUuid) => {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(key => key !== 'serviceIds') ||
    !Array.isArray(body.serviceIds)
  ) {
    return { error: '服务项目列表格式不正确' };
  }

  if (body.serviceIds.length > MAX_SERVICE_IDS) {
    return { error: '服务项目数量超过限制' };
  }

  if (body.serviceIds.some(id => !isUuid(id))) {
    return { error: '服务项目ID不正确' };
  }

  return { serviceIds: [...new Set(body.serviceIds)] };
};

const createOwnerStaffCapabilityManagement = ({
  pool,
  isUuid,
  runInTransaction,
  safeErrorCode
}) => {
  const sendError = (response, error, fallbackMessage) => {
    if (
      error instanceof OwnerStaffCapabilityError &&
      [400, 404, 409].includes(error.status)
    ) {
      return response.status(error.status).json({
        success: false,
        code: error.code,
        message: error.publicMessage
      });
    }

    console.error(
      'Owner staff capability error:',
      safeErrorCode(error)
    );
    return response.status(500).json({
      success: false,
      message: fallbackMessage
    });
  };

  const listStaffServices = async (request, response) => {
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
        throw new OwnerStaffCapabilityError(
          'STAFF_NOT_FOUND',
          404,
          '未找到该员工'
        );
      }

      const result = await client.query(
        `
        SELECT
          service.id AS service_id,
          service.name,
          service.category,
          service.is_active,
          service.bookable,
          COALESCE(capability.is_active, FALSE) AS assigned
        FROM services AS service
        LEFT JOIN staff_services AS capability
          ON capability.shop_id = service.shop_id
         AND capability.service_id = service.id
         AND capability.staff_id = $2
        WHERE service.shop_id = $1
        ORDER BY service.sort_order ASC, service.name ASC
        `,
        [request.ownerAuth.shopId, request.params.staffId]
      );

      return response.json({ success: true, data: result.rows });
    } catch (error) {
      return sendError(response, error, '读取员工服务项目失败');
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  const replaceStaffServices = async (request, response) => {
    if (!isUuid(request.params.staffId)) {
      return response.status(400).json({
        success: false,
        message: '员工ID不正确'
      });
    }

    const validation = validateServiceIds(request.body, isUuid);

    if (validation.error) {
      return response.status(400).json({
        success: false,
        message: validation.error
      });
    }

    try {
      const serviceIds = await runInTransaction(
        pool,
        async client => {
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
            throw new OwnerStaffCapabilityError(
              'STAFF_NOT_FOUND',
              404,
              '未找到该员工'
            );
          }

          const mappingResult = await client.query(
            `
            SELECT service_id, is_active
            FROM staff_services
            WHERE shop_id = $1
              AND staff_id = $2
            FOR UPDATE
            `,
            [request.ownerAuth.shopId, request.params.staffId]
          );

          const serviceResult = validation.serviceIds.length === 0
            ? { rows: [] }
            : await client.query(
                `
                SELECT id, is_active, bookable
                FROM services
                WHERE shop_id = $1
                  AND id = ANY($2::UUID[])
                FOR SHARE
                `,
                [request.ownerAuth.shopId, validation.serviceIds]
              );

          if (serviceResult.rows.length !== validation.serviceIds.length) {
            throw new OwnerStaffCapabilityError(
              'SERVICE_NOT_FOUND',
              404,
              '一个或多个服务项目不存在或不可用'
            );
          }

          const activeMappingIds = new Set(
            mappingResult.rows
              .filter(row => row.is_active === true)
              .map(row => row.service_id)
          );
          const newlyAssignedInactiveService = serviceResult.rows.find(
            service =>
              service.is_active !== true &&
              !activeMappingIds.has(service.id)
          );

          if (newlyAssignedInactiveService) {
            throw new OwnerStaffCapabilityError(
              'INACTIVE_SERVICE_CAPABILITY_NOT_ALLOWED',
              409,
              '停用的服务项目不能新增员工能力'
            );
          }

          const requestedIds = new Set(validation.serviceIds);
          const removedServiceIds = [...activeMappingIds].filter(
            serviceId => !requestedIds.has(serviceId)
          );

          if (removedServiceIds.length > 0) {
            const futureResult = await client.query(
              `
              SELECT item.id
              FROM appointment_items AS item
              JOIN appointment_item_staff_assignments AS item_assignment
                ON item_assignment.shop_id = item.shop_id
               AND item_assignment.location_id = item.location_id
               AND item_assignment.appointment_item_id = item.id
              JOIN appointments AS appointment
                ON appointment.shop_id = item.shop_id
               AND appointment.location_id = item.location_id
               AND appointment.id = item.appointment_id
              WHERE item.shop_id = $1
                AND item_assignment.staff_id = $2
                AND item_assignment.role IN ('primary', 'assistant')
                AND item.service_id = ANY($3::UUID[])
                AND item.end_at > NOW()
                AND appointment.status IN ('pending', 'confirmed')
              LIMIT 1
              `,
              [
                request.ownerAuth.shopId,
                request.params.staffId,
                removedServiceIds
              ]
            );

            if (futureResult.rows.length > 0) {
              throw new OwnerStaffCapabilityError(
                'STAFF_SERVICE_HAS_FUTURE_APPOINTMENTS',
                409,
                '该员工服务能力仍有关联的未来预约'
              );
            }
          }

          const deactivateResult = await client.query(
            `
            UPDATE staff_services
            SET is_active = FALSE
            WHERE shop_id = $1
              AND staff_id = $2
              AND is_active = TRUE
              AND NOT (service_id = ANY($3::UUID[]))
            RETURNING service_id
            `,
            [
              request.ownerAuth.shopId,
              request.params.staffId,
              validation.serviceIds
            ]
          );

          if (deactivateResult.rows.length !== removedServiceIds.length) {
            throw new Error('staff_capability_deactivate_rowcount');
          }

          const upsertResult = validation.serviceIds.length === 0
            ? { rows: [] }
            : await client.query(
                `
                INSERT INTO staff_services (
                  shop_id,
                  staff_id,
                  service_id,
                  is_active
                )
                SELECT $1, $2, service_id, TRUE
                FROM UNNEST($3::UUID[]) AS service_id
                ON CONFLICT (shop_id, staff_id, service_id)
                DO UPDATE SET is_active = TRUE
                RETURNING service_id
                `,
                [
                  request.ownerAuth.shopId,
                  request.params.staffId,
                  validation.serviceIds
                ]
              );

          if (upsertResult.rows.length !== validation.serviceIds.length) {
            throw new Error('staff_capability_upsert_rowcount');
          }

          return validation.serviceIds;
        }
      );

      return response.json({
        success: true,
        data: { serviceIds }
      });
    } catch (error) {
      return sendError(response, error, '更新员工服务项目失败');
    }
  };

  return { listStaffServices, replaceStaffServices };
};

module.exports = {
  MAX_SERVICE_IDS,
  OwnerStaffCapabilityError,
  createOwnerStaffCapabilityManagement,
  validateServiceIds
};
