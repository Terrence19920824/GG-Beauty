'use strict';

const ARRIVE_AND_START_PATHS = Object.freeze({
  pending: Object.freeze(['confirmed', 'arrived', 'in_service']),
  confirmed: Object.freeze(['arrived', 'in_service']),
  arrived: Object.freeze(['in_service']),
  in_service: Object.freeze([])
});

const MARK_ARRIVED_PATHS = Object.freeze({
  pending: Object.freeze(['confirmed', 'arrived']),
  confirmed: Object.freeze(['arrived']),
  arrived: Object.freeze([])
});

const START_SERVICE_PATHS = Object.freeze({
  arrived: Object.freeze(['in_service']),
  in_service: Object.freeze([])
});

const deriveArriveAndStartPath = status => {
  const path = ARRIVE_AND_START_PATHS[status];
  return path ? [...path] : null;
};

const deriveMarkArrivedPath = status => {
  const path = MARK_ARRIVED_PATHS[status];
  return path ? [...path] : null;
};

const deriveStartServicePath = status => {
  const path = START_SERVICE_PATHS[status];
  return path ? [...path] : null;
};

const createAppointmentLifecycleHandler = ({
  pool,
  isUuid,
  runInTransaction,
  AppointmentMutationError,
  loadAndValidatePhaseAStructure,
  syncAppointmentItemStatus,
  isKnownStatus,
  canTransition,
  ownerStatusHistoryActorType,
  recordStatusHistory,
  safeErrorCode,
  derivePath,
  source,
  successMessage,
  defaultFailedMessage,
  defaultFailedCode,
  unsupportedMessage,
  ineligibleMessage
}) => {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect is required');

  return async (req, res) => {
    const appointmentId = typeof req.params?.appointmentId === 'string'
      ? req.params.appointmentId.trim()
      : '';

    if (!isUuid(appointmentId)) {
      return res.status(400).json({
        success: false,
        code: 'APPOINTMENT_ID_INVALID',
        message: '预约ID不正确'
      });
    }

    try {
      const updated = await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");

        const appointmentResult = await client.query(
          `SELECT id, shop_id, location_id, service_id, staff_id,
                  start_at, end_at, status, updated_at
             FROM appointments
            WHERE id = $1
              AND shop_id = $2
            FOR UPDATE`,
          [appointmentId, req.ownerAuth.shopId]
        );

        if (appointmentResult.rows.length !== 1) {
          throw new AppointmentMutationError(
            'APPOINTMENT_NOT_FOUND',
            404,
            '未找到该预约'
          );
        }

        const appointment = appointmentResult.rows[0];
        const structure = await loadAndValidatePhaseAStructure(client, appointment);

        if (!isKnownStatus(appointment.status)) {
          throw new AppointmentMutationError(
            'APPOINTMENT_STATUS_UNSUPPORTED',
            409,
            unsupportedMessage
          );
        }

        const path = derivePath(appointment.status);
        if (path === null) {
          throw new AppointmentMutationError(
            'APPOINTMENT_STATUS_NOT_ELIGIBLE',
            409,
            ineligibleMessage
          );
        }

        if (path.length === 0) {
          return {
            id: appointment.id,
            status: appointment.status,
            start_at: appointment.start_at,
            end_at: appointment.end_at,
            updated_at: appointment.updated_at,
            applied_transitions: []
          };
        }

        const appliedTransitions = [];
        for (const nextStatus of path) {
          const fromStatus = appointment.status;
          if (!canTransition(fromStatus, nextStatus)) {
            throw new AppointmentMutationError(
              'APPOINTMENT_STATUS_TRANSITION_INVALID',
              409,
              '不允许进行该预约状态变更'
            );
          }

          const result = await client.query(
            `UPDATE appointments
                SET status = $1,
                    updated_at = NOW()
              WHERE id = $2
                AND shop_id = $3
                AND location_id = $4
                AND status = $5
              RETURNING id, status, start_at, end_at, updated_at`,
            [
              nextStatus,
              appointment.id,
              appointment.shop_id,
              appointment.location_id,
              fromStatus
            ]
          );

          if (result.rows.length !== 1) {
            throw new AppointmentMutationError(
              'APPOINTMENT_STATUS_UPDATE_MISMATCH',
              409,
              '预约状态已变化，请刷新后重试'
            );
          }

          await syncAppointmentItemStatus(client, {
            appointment,
            status: nextStatus,
            expectedItemCount: structure.itemCount
          });

          await recordStatusHistory(client, {
            appointment,
            fromStatus,
            toStatus: nextStatus,
            operatorType: ownerStatusHistoryActorType(req.ownerAuth.role),
            operatorId: req.ownerAuth.ownerAccountId,
            source
          });

          appointment.status = nextStatus;
          appointment.updated_at = result.rows[0].updated_at;
          appliedTransitions.push({ from: fromStatus, to: nextStatus });
        }

        return {
          id: appointment.id,
          status: appointment.status,
          start_at: appointment.start_at,
          end_at: appointment.end_at,
          updated_at: appointment.updated_at,
          applied_transitions: appliedTransitions
        };
      });

      return res.json({
        success: true,
        message: successMessage,
        data: updated
      });
    } catch (error) {
      const code = safeErrorCode(error);
      const status = ['23P01', '55P03'].includes(code)
        ? 409
        : error instanceof AppointmentMutationError
          ? error.status
          : 500;
      const message = code === '55P03'
        ? '预约正在被修改，请稍后重试'
        : error instanceof AppointmentMutationError
          ? error.publicMessage
          : defaultFailedMessage;

      return res.status(status).json({
        success: false,
        code: error instanceof AppointmentMutationError ? error.code : defaultFailedCode,
        message
      });
    }
  };
};

const createOwnerAppointmentArriveStart = options =>
  createAppointmentLifecycleHandler({
    ...options,
    derivePath: deriveArriveAndStartPath,
    source: 'owner_arrive_and_start',
    successMessage: '顾客已到店并开始服务',
    defaultFailedMessage: '到店并开始服务失败',
    defaultFailedCode: 'ARRIVE_AND_START_FAILED',
    unsupportedMessage: '当前预约状态不可开始服务',
    ineligibleMessage: '当前预约状态不可开始服务'
  });

const createOwnerAppointmentMarkArrived = options =>
  createAppointmentLifecycleHandler({
    ...options,
    derivePath: deriveMarkArrivedPath,
    source: 'owner_mark_arrived',
    successMessage: '顾客已到店',
    defaultFailedMessage: '标记到店失败',
    defaultFailedCode: 'MARK_ARRIVED_FAILED',
    unsupportedMessage: '当前预约状态不可标记到店',
    ineligibleMessage: '当前预约状态不可标记到店'
  });

const createOwnerAppointmentStartService = options =>
  createAppointmentLifecycleHandler({
    ...options,
    derivePath: deriveStartServicePath,
    source: 'owner_start_service',
    successMessage: '已开始服务',
    defaultFailedMessage: '开始服务失败',
    defaultFailedCode: 'START_SERVICE_FAILED',
    unsupportedMessage: '当前预约状态不可开始服务',
    ineligibleMessage: '当前预约状态不可开始服务'
  });
module.exports = {
  ARRIVE_AND_START_PATHS,
  MARK_ARRIVED_PATHS,
  START_SERVICE_PATHS,
  createAppointmentLifecycleHandler,
  createOwnerAppointmentArriveStart,
  createOwnerAppointmentMarkArrived,
  createOwnerAppointmentStartService,
  deriveArriveAndStartPath,
  deriveMarkArrivedPath,
  deriveStartServicePath
};
