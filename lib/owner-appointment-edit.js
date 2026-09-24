'use strict';

class OwnerAppointmentEditError extends Error {
  constructor(code, status, publicMessage, extra = {}) {
    super(code);
    this.name = 'OwnerAppointmentEditError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    Object.assign(this, extra);
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const createOwnerAppointmentEdit = ({
  pool,
  isUuid,
  runInTransaction,
  safeErrorCode = () => 'INTERNAL_ERROR'
}) => {
  const sendError = (response, error) => {
    if (error instanceof OwnerAppointmentEditError && [400, 404, 409, 422].includes(error.status)) {
      const payload = {
        success: false,
        code: error.code,
        message: error.publicMessage
      };
      if (error.messageEn) payload.messageEn = error.messageEn;
      if (error.canOverride !== undefined) payload.canOverride = error.canOverride;
      if (error.conflicts) payload.conflicts = error.conflicts;
      return response.status(error.status).json(payload);
    }

    console.error('Owner appointment edit unexpected error:', safeErrorCode(error));
    return response.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: '调整预约失败'
    });
  };

  const adjustAppointment = async (req, res) => {
    const { appointmentId } = req.params;

    if (!isUuid(appointmentId)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_APPOINTMENT_ID',
        message: '预约ID无效'
      });
    }

    const {
      newDate,
      newTime,
      newStaffId,
      reassignmentReason = '',
      customerNotified = false,
      customerAgreed = false,
      overrideConflict = false,
      conflictReason = '',
      // Disallowed mutation fields in Phase 1A:
      serviceIds,
      services,
      price,
      items
    } = req.body || {};

    if (
      serviceIds !== undefined ||
      services !== undefined ||
      price !== undefined ||
      items !== undefined
    ) {
      return res.status(400).json({
        success: false,
        code: 'NO_SERVICE_OR_PRICE_CHANGE_ALLOWED',
        message: '本阶段不允许修改服务项目或价格'
      });
    }

    if (!newDate || typeof newDate !== 'string' || !DATE_PATTERN.test(newDate.trim())) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_DATE',
        message: '预约日期格式无效，需为 YYYY-MM-DD'
      });
    }

    if (!newTime || typeof newTime !== 'string' || !TIME_PATTERN.test(newTime.trim())) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_TIME',
        message: '预约时间格式无效，需为 HH:mm'
      });
    }

    if (!newStaffId || !isUuid(newStaffId)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_STAFF_ID',
        message: '目标员工ID无效'
      });
    }

    const cleanDate = newDate.trim();
    const cleanTime = newTime.trim().length === 5 ? `${newTime.trim()}:00` : newTime.trim();
    const cleanStaffId = String(newStaffId).trim();
    const shopId = req.ownerAuth?.shopId;
    const actorRole = req.ownerAuth?.role;
    const actorId = req.ownerAuth?.ownerAccountId || req.ownerAuth?.membershipId || req.ownerAuth?.staffId;
    const actorName = req.ownerAuth?.displayName || req.ownerAuth?.loginIdentifier || req.ownerAuth?.role || 'Staff';

    if (!shopId || !isUuid(shopId) || !actorId || !isUuid(actorId) || !actorRole) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '无权操作此店铺预约'
      });
    }

    try {
      const result = await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");

        // 1. Lock appointment
        const appointmentResult = await client.query(
          `
          SELECT
            id,
            shop_id,
            location_id,
            staff_id,
            service_id,
            start_at,
            end_at,
            status,
            override_conflict,
            staff_selection_type
          FROM appointments
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
          `,
          [appointmentId, shopId]
        );

        if (appointmentResult.rows.length === 0) {
          throw new OwnerAppointmentEditError('APPOINTMENT_NOT_FOUND', 404, '未找到预约');
        }

        const appointment = appointmentResult.rows[0];

        if (!['pending', 'confirmed'].includes(appointment.status)) {
          throw new OwnerAppointmentEditError(
            'APPOINTMENT_STATUS_NOT_EDITABLE',
            409,
            '只能调整待确认或已确认的预约'
          );
        }

        // 2. Lock location and retrieve timezone
        const locationResult = await client.query(
          `
          SELECT id, timezone, is_active
          FROM locations
          WHERE id = $1
            AND shop_id = $2
            AND is_active = TRUE
          LIMIT 1
          `,
          [appointment.location_id, shopId]
        );

        if (locationResult.rows.length === 0) {
          throw new OwnerAppointmentEditError(
            'LOCATION_NOT_FOUND',
            404,
            '预约所在门店不存在或已停用'
          );
        }

        const location = locationResult.rows[0];
        const timezone = location.timezone;

        // 3. Lock appointment items
        const itemsResult = await client.query(
          `
          SELECT
            id,
            service_id,
            sequence_no,
            service_name_snapshot,
            duration_minutes_snapshot,
            price_snapshot,
            start_at,
            end_at
          FROM appointment_items
          WHERE shop_id = $1
            AND location_id = $2
            AND appointment_id = $3
          ORDER BY sequence_no ASC, id ASC
          FOR UPDATE
          `,
          [shopId, appointment.location_id, appointment.id]
        );

        if (itemsResult.rows.length === 0) {
          throw new OwnerAppointmentEditError(
            'APPOINTMENT_ITEMS_MISSING',
            409,
            '预约项目数据缺失'
          );
        }

        const items = itemsResult.rows;

        // Calculate total duration from items
        const sumItemDuration = items.reduce(
          (sum, it) => sum + Number(it.duration_minutes_snapshot || 0),
          0
        );
        const oldDurationMinutes = Math.round(
          (new Date(appointment.end_at).getTime() - new Date(appointment.start_at).getTime()) / 60000
        );
        const effectiveDuration = sumItemDuration > 0 ? sumItemDuration : oldDurationMinutes;

        // 4. Derive authoritative start_at and end_at in PostgreSQL
        const timeCalcResult = await client.query(
          `
          SELECT
            (($1::DATE + $2::TIME) AT TIME ZONE $3) AS new_start_at,
            ((($1::DATE + $2::TIME) AT TIME ZONE $3) + ($4::INTEGER * INTERVAL '1 minute')) AS new_end_at
          `,
          [cleanDate, cleanTime, timezone, effectiveDuration]
        );

        const newStartAt = timeCalcResult.rows[0].new_start_at;
        const newEndAt = timeCalcResult.rows[0].new_end_at;

        if (newEndAt <= newStartAt) {
          throw new OwnerAppointmentEditError('INVALID_TIME_RANGE', 400, '预约结束时间必须晚于开始时间');
        }

        // 5. Verify target staff exists, is active, and assigned to this location
        const staffResult = await client.query(
          `
          SELECT id, name, is_active
          FROM staff
          WHERE id = $1
            AND shop_id = $2
            AND is_active = TRUE
          LIMIT 1
          `,
          [cleanStaffId, shopId]
        );

        if (staffResult.rows.length === 0) {
          throw new OwnerAppointmentEditError('STAFF_NOT_FOUND', 422, '未找到目标员工或员工已停用');
        }

        const locationAssignResult = await client.query(
          `
          SELECT id
          FROM staff_location_assignments
          WHERE shop_id = $1
            AND staff_id = $2
            AND location_id = $3
            AND is_active = TRUE
          LIMIT 1
          `,
          [shopId, cleanStaffId, appointment.location_id]
        );

        if (locationAssignResult.rows.length === 0) {
          throw new OwnerAppointmentEditError(
            'STAFF_NOT_ASSIGNED_TO_LOCATION',
            422,
            '目标员工未分配到当前门店'
          );
        }

        // 6. Check Staff Skills (RULE #1, #8, #9): Hard block, zero bypass
        const uniqueServiceIds = [...new Set(items.map(it => it.service_id).filter(Boolean))];
        if (uniqueServiceIds.length > 0) {
          const skillResult = await client.query(
            `
            SELECT service_id
            FROM staff_services
            WHERE shop_id = $1
              AND staff_id = $2
              AND service_id = ANY($3::UUID[])
              AND is_active = TRUE
            `,
            [shopId, cleanStaffId, uniqueServiceIds]
          );

          if (skillResult.rows.length !== uniqueServiceIds.length) {
            throw new OwnerAppointmentEditError(
              'STAFF_SKILL_MISMATCH',
              422,
              '该员工不会此项目，不能改派',
              { messageEn: 'This staff member cannot perform this service' }
            );
          }
        }

        // 7. Check Target Staff Working Hours / Overrides (RULE #8)
        const overrideResult = await client.query(
          `
          SELECT override_type, start_time, end_time, approval_status
          FROM staff_schedule_overrides
          WHERE shop_id = $1
            AND location_id = $2
            AND staff_id = $3
            AND schedule_date = ($4::TIMESTAMPTZ AT TIME ZONE $5)::DATE
            AND is_active = TRUE
            AND approval_status = 'approved'
          ORDER BY created_at DESC
          `,
          [shopId, appointment.location_id, cleanStaffId, newStartAt, timezone]
        );

        let isWorking = false;
        let workStartTime = null;
        let workEndTime = null;

        if (overrideResult.rows.length > 0) {
          const override = overrideResult.rows[0];
          if (['day_off', 'time_off', 'leave'].includes(override.override_type)) {
            throw new OwnerAppointmentEditError('STAFF_NOT_WORKING', 422, '目标员工在所选日期已休假');
          }
          if (['custom_hours', 'working'].includes(override.override_type) && override.start_time && override.end_time) {
            isWorking = true;
            workStartTime = override.start_time;
            workEndTime = override.end_time;
          }
        }

        if (!isWorking) {
          const weeklyResult = await client.query(
            `
            SELECT start_time, end_time
            FROM staff_location_working_hours
            WHERE shop_id = $1
              AND location_id = $2
              AND staff_id = $3
              AND day_of_week = EXTRACT(ISODOW FROM $4::TIMESTAMPTZ AT TIME ZONE $5)::INTEGER
              AND is_active = TRUE
              AND (effective_from IS NULL OR effective_from <= ($4::TIMESTAMPTZ AT TIME ZONE $5)::DATE)
              AND (effective_to IS NULL OR effective_to >= ($4::TIMESTAMPTZ AT TIME ZONE $5)::DATE)
            LIMIT 1
            `,
            [shopId, appointment.location_id, cleanStaffId, newStartAt, timezone]
          );

          if (weeklyResult.rows.length === 0) {
            throw new OwnerAppointmentEditError('STAFF_NOT_WORKING', 422, '目标员工在所选日期未排班');
          }

          isWorking = true;
          workStartTime = weeklyResult.rows[0].start_time;
          workEndTime = weeklyResult.rows[0].end_time;
        }

        // Verify [newStartAt, newEndAt] is inside [workStartTime, workEndTime]
        const intervalCheck = await client.query(
          `
          SELECT
            (($1::TIMESTAMPTZ AT TIME ZONE $3)::TIME >= $4::TIME
             AND ($2::TIMESTAMPTZ AT TIME ZONE $3)::TIME <= $5::TIME) AS is_contained
          `,
          [newStartAt, newEndAt, timezone, workStartTime, workEndTime]
        );

        if (!intervalCheck.rows[0]?.is_contained) {
          throw new OwnerAppointmentEditError('STAFF_NOT_WORKING', 422, '所选预约时间超出目标员工工作时间');
        }

        // 8. Check Specified Staff Reassignment (RULE #10)
        const isReassigned = cleanStaffId !== String(appointment.staff_id).trim();
        const wasSpecific = String(appointment.staff_selection_type || '').toLowerCase() === 'specific';

        if (isReassigned && wasSpecific) {
          if (!reassignmentReason || typeof reassignmentReason !== 'string' || reassignmentReason.trim().length < 2) {
            throw new OwnerAppointmentEditError(
              'REASSIGNMENT_REASON_REQUIRED',
              400,
              '顾客原指定此员工，改派必须填写原因'
            );
          }
          if (customerNotified !== true || customerAgreed !== true) {
            throw new OwnerAppointmentEditError(
              'CUSTOMER_CONSENT_REQUIRED',
              400,
              '改派原指定员工必须确认已通知顾客且顾客已同意'
            );
          }
        }

        // 9. Conflict Check (RULE #8, #11)
        const conflictResult = await client.query(
          `
          SELECT
            p.id AS appointment_id,
            p.appointment_no,
            p.start_at,
            p.end_at,
            COALESCE(p.recipient_name_snapshot, p.booker_name_snapshot, '顾客') AS customer_name
          FROM appointment_item_staff_assignments a
          JOIN appointment_items i
            ON i.shop_id = a.shop_id
           AND i.location_id = a.location_id
           AND i.id = a.appointment_item_id
          JOIN appointments p
            ON p.shop_id = i.shop_id
           AND p.location_id = i.location_id
           AND p.id = i.appointment_id
          WHERE a.shop_id = $1
            AND a.location_id = $2
            AND a.staff_id = $3
            AND a.role IN ('primary', 'assistant')
            AND p.id <> $4
            AND p.status IN ('pending', 'confirmed', 'arrived', 'in_service')
            AND a.start_at < $6::TIMESTAMPTZ
            AND a.end_at > $5::TIMESTAMPTZ
          `,
          [shopId, appointment.location_id, cleanStaffId, appointment.id, newStartAt, newEndAt]
        );

        const conflicts = conflictResult.rows;
        let willOverrideConflict = false;

        if (conflicts.length > 0) {
          if (actorRole === 'front_desk') {
            throw new OwnerAppointmentEditError(
              'APPOINTMENT_COLLISION',
              409,
              '所选时间与现有预约存在冲突，前台角色无权强制重叠安排',
              { canOverride: false }
            );
          }

          if (overrideConflict !== true) {
            throw new OwnerAppointmentEditError(
              'APPOINTMENT_COLLISION',
              409,
              '所选时间与现有预约存在冲突',
              { canOverride: true, conflicts }
            );
          }

          if (!conflictReason || typeof conflictReason !== 'string' || conflictReason.trim().length < 2) {
            throw new OwnerAppointmentEditError(
              'CONFLICT_REASON_REQUIRED',
              400,
              '强制重叠安排必须填写原因'
            );
          }

          willOverrideConflict = true;
        } else {
          willOverrideConflict = false;
        }

        // 10. Execute updates atomically (RULE #7, #8, #9, #10, #12)
        // a. Update appointments
        await client.query(
          `
          UPDATE appointments
          SET
            staff_id = $1,
            start_at = $2,
            end_at = $3,
            override_conflict = $4,
            updated_at = NOW()
          WHERE id = $5
            AND shop_id = $6
            AND location_id = $7
          `,
          [cleanStaffId, newStartAt, newEndAt, willOverrideConflict, appointment.id, shopId, appointment.location_id]
        );

        // b. Shift appointment_items by exact delta (NO service_id, price, name, duration modifications!)
        await client.query(
          `
          UPDATE appointment_items
          SET
            start_at = start_at + ($1::TIMESTAMPTZ - $2::TIMESTAMPTZ),
            end_at = end_at + ($1::TIMESTAMPTZ - $2::TIMESTAMPTZ),
            updated_at = NOW()
          WHERE shop_id = $3
            AND location_id = $4
            AND appointment_id = $5
          `,
          [newStartAt, appointment.start_at, shopId, appointment.location_id, appointment.id]
        );

        // c. Shift and reassign appointment_item_staff_assignments
        await client.query(
          `
          UPDATE appointment_item_staff_assignments a
          SET
            staff_id = $1,
            start_at = a.start_at + ($2::TIMESTAMPTZ - $3::TIMESTAMPTZ),
            end_at = a.end_at + ($2::TIMESTAMPTZ - $3::TIMESTAMPTZ),
            updated_at = NOW()
          FROM appointment_items i
          WHERE a.shop_id = i.shop_id
            AND a.location_id = i.location_id
            AND a.appointment_item_id = i.id
            AND i.appointment_id = $4
            AND a.shop_id = $5
            AND a.location_id = $6
            AND a.role = 'primary'
          `,
          [cleanStaffId, newStartAt, appointment.start_at, appointment.id, shopId, appointment.location_id]
        );

        // d. Record audit history in appointment_edit_history
        const itemsSnapshot = items.map(it => ({
          serviceId: it.service_id,
          serviceName: it.service_name_snapshot,
          durationMinutes: it.duration_minutes_snapshot,
          price: it.price_snapshot
        }));

        const auditResult = await client.query(
          `
          INSERT INTO appointment_edit_history (
            shop_id,
            location_id,
            appointment_id,
            actor_role,
            actor_id,
            actor_name,
            old_start_at,
            new_start_at,
            old_end_at,
            new_end_at,
            old_staff_id,
            new_staff_id,
            items_snapshot,
            reassignment_reason,
            override_conflict,
            conflict_reason,
            customer_notified,
            customer_agreed
          ) VALUES (
            $1, $2, $3,
            $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12,
            $13,
            $14,
            $15, $16,
            $17, $18
          )
          RETURNING id, created_at
          `,
          [
            shopId,
            appointment.location_id,
            appointment.id,
            actorRole,
            actorId,
            actorName,
            appointment.start_at,
            newStartAt,
            appointment.end_at,
            newEndAt,
            appointment.staff_id,
            cleanStaffId,
            JSON.stringify(itemsSnapshot),
            isReassigned ? (reassignmentReason.trim() || null) : null,
            willOverrideConflict,
            willOverrideConflict ? conflictReason.trim() : null,
            customerNotified === true,
            customerAgreed === true
          ]
        );

        return {
          appointmentId: appointment.id,
          startAt: newStartAt,
          endAt: newEndAt,
          staffId: cleanStaffId,
          overrideConflict: willOverrideConflict,
          auditId: auditResult.rows[0].id
        };
      });

      return res.json({
        success: true,
        data: result,
        message: '预约调整成功'
      });
    } catch (error) {
      return sendError(res, error);
    }
  };

  return {
    adjustAppointment
  };
};

module.exports = {
  OwnerAppointmentEditError,
  createOwnerAppointmentEdit
};
