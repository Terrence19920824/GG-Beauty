'use strict';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WRITE_OVERRIDE_TYPES = new Set(['day_off', 'leave', 'custom_hours']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);

class OwnerScheduleError extends Error {
  constructor(code, status, publicMessage) {
    super(code);
    this.name = 'OwnerScheduleError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const isValidDate = value => {
  if (typeof value !== 'string') return false;
  const match = value.match(DATE_PATTERN);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
};

const validTimeRange = (startTime, endTime) =>
  typeof startTime === 'string' &&
  typeof endTime === 'string' &&
  TIME_PATTERN.test(startTime) &&
  TIME_PATTERN.test(endTime) &&
  startTime < endTime;

const validateWeeklyBody = (body, isUuid) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['locationId', 'days'].includes(key)) ||
      !isUuid(body.locationId) || !Array.isArray(body.days)) {
    return { error: '周排班资料格式不正确' };
  }
  if (body.days.length > 7) return { error: '周排班日期数量不正确' };
  const seen = new Set();
  const days = [];
  for (const day of body.days) {
    if (!day || typeof day !== 'object' || Array.isArray(day) ||
        Object.keys(day).some(key => !['dayOfWeek', 'isWorking', 'startTime', 'endTime'].includes(key)) ||
        !Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 1 || day.dayOfWeek > 7 ||
        typeof day.isWorking !== 'boolean' || seen.has(day.dayOfWeek)) {
      return { error: '周排班日期格式不正确' };
    }
    seen.add(day.dayOfWeek);
    if (day.isWorking) {
      if (!validTimeRange(day.startTime, day.endTime)) {
        return { error: '工作时间格式不正确' };
      }
      days.push({ dayOfWeek: day.dayOfWeek, isWorking: true, startTime: day.startTime, endTime: day.endTime });
    } else {
      if (day.startTime !== undefined || day.endTime !== undefined) {
        return { error: '休息日不能包含工作时间' };
      }
      days.push({ dayOfWeek: day.dayOfWeek, isWorking: false });
    }
  }
  return { locationId: body.locationId, days };
};

const normalizeOverride = input => {
  const value = { ...input };
  if (!WRITE_OVERRIDE_TYPES.has(value.overrideType) || !isValidDate(value.scheduleDate)) {
    return { error: '特殊排班类型或日期不正确' };
  }
  if (value.reason !== undefined && value.reason !== null) {
    if (typeof value.reason !== 'string' || value.reason.length > 1000) return { error: '原因格式不正确' };
    value.reason = value.reason.trim() || null;
  }
  if (value.overrideType === 'day_off') {
    if (value.startTime != null || value.endTime != null) return { error: '全天休息不能包含时间' };
    value.startTime = null; value.endTime = null;
  } else if (value.overrideType === 'leave') {
    const bothMissing = value.startTime == null && value.endTime == null;
    if (!bothMissing && !validTimeRange(value.startTime, value.endTime)) return { error: '请假时间格式不正确' };
    if (bothMissing) { value.startTime = null; value.endTime = null; }
  } else if (!validTimeRange(value.startTime, value.endTime)) {
    return { error: '特殊营业时间格式不正确' };
  }
  return { value };
};

const validateOverrideCreate = (body, isUuid) => {
  const fields = ['locationId', 'scheduleDate', 'overrideType', 'startTime', 'endTime', 'reason'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !fields.includes(key)) || !isUuid(body.locationId)) {
    return { error: '特殊排班资料格式不正确' };
  }
  const normalized = normalizeOverride(body);
  return normalized.error ? normalized : { value: { ...normalized.value, approvalStatus: 'approved', isActive: true } };
};

const validateOverridePatch = body => {
  const fields = ['scheduleDate', 'overrideType', 'startTime', 'endTime', 'reason', 'approvalStatus', 'isActive'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0 ||
      Object.keys(body).some(key => !fields.includes(key))) return { error: '特殊排班更新资料格式不正确' };
  if (body.approvalStatus !== undefined && !APPROVAL_STATUSES.has(body.approvalStatus)) return { error: '审批状态不正确' };
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return { error: 'active 状态不正确' };
  if (body.scheduleDate !== undefined && !isValidDate(body.scheduleDate)) return { error: '特殊排班日期不正确' };
  if (body.overrideType !== undefined && !WRITE_OVERRIDE_TYPES.has(body.overrideType)) return { error: '特殊排班类型不正确' };
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.length > 1000)) return { error: '原因格式不正确' };
  return { value: body };
};

const createOwnerScheduleManagement = ({ pool, isUuid, runInTransaction, safeErrorCode }) => {
  const sendError = (res, error, fallback) => {
    if (error instanceof OwnerScheduleError && [400, 404, 409].includes(error.status)) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.publicMessage });
    }
    if (safeErrorCode(error) === '23505' || safeErrorCode(error) === '55P03') {
      return res.status(409).json({ success: false, message: '排班资料发生冲突，请刷新后重试' });
    }
    console.error('Owner schedule error:', safeErrorCode(error));
    return res.status(500).json({ success: false, message: fallback });
  };

  const loadScope = async (client, shopId, staffId, locationId, lock = false) => {
    const result = await client.query(`
      SELECT location.id AS location_id, location.timezone
      FROM staff AS staff_member
      JOIN staff_location_assignments AS assignment
        ON assignment.shop_id = staff_member.shop_id
       AND assignment.staff_id = staff_member.id
       AND assignment.location_id = $3
       AND assignment.is_active = TRUE
      JOIN locations AS location
        ON location.shop_id = staff_member.shop_id
       AND location.id = assignment.location_id
       AND location.is_active = TRUE
      WHERE staff_member.id = $2
        AND staff_member.shop_id = $1
      ${lock ? 'FOR UPDATE OF staff_member, assignment, location' : ''}
    `, [shopId, staffId, locationId]);
    if (result.rows.length !== 1) throw new OwnerScheduleError('SCHEDULE_SCOPE_NOT_FOUND', 404, '未找到员工地点排班范围');
    return result.rows[0];
  };

  const assertNoFutureConflict = async (client, { shopId, staffId, locationId, timezone, mode, days, override }) => {
    let predicate;
    let params = [shopId, staffId, locationId, timezone];
    if (mode === 'weekly') {
      const working = days.filter(day => day.isWorking);
      params.push(working.map(day => day.dayOfWeek), working.map(day => day.startTime), working.map(day => day.endTime));
      predicate = `NOT EXISTS (
        SELECT 1 FROM UNNEST($5::INTEGER[], $6::TIME[], $7::TIME[]) AS proposed(day_of_week, start_time, end_time)
        WHERE proposed.day_of_week = EXTRACT(ISODOW FROM item.start_at AT TIME ZONE $4)::INTEGER
          AND (item.start_at AT TIME ZONE $4)::DATE = (item.end_at AT TIME ZONE $4)::DATE
          AND (item.start_at AT TIME ZONE $4)::TIME >= proposed.start_time
          AND (item.end_at AT TIME ZONE $4)::TIME <= proposed.end_time
      )`;
    } else {
      params.push(override.scheduleDate, override.overrideType, override.startTime, override.endTime, override.approvalStatus);
      predicate = `(item.start_at AT TIME ZONE $4)::DATE = $5::DATE AND (
        $9::TEXT = 'pending' OR
        ($6::TEXT = 'day_off') OR
        ($6::TEXT = 'leave' AND ($7::TIME IS NULL OR ((item.start_at AT TIME ZONE $4)::TIME < $8::TIME AND (item.end_at AT TIME ZONE $4)::TIME > $7::TIME))) OR
        ($6::TEXT = 'custom_hours' AND NOT ((item.start_at AT TIME ZONE $4)::DATE = (item.end_at AT TIME ZONE $4)::DATE AND (item.start_at AT TIME ZONE $4)::TIME >= $7::TIME AND (item.end_at AT TIME ZONE $4)::TIME <= $8::TIME))
      )`;
    }
    const result = await client.query(`
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
        AND item.location_id = $3
        AND item_assignment.staff_id = $2
        AND item_assignment.role IN ('primary', 'assistant')
        AND item.end_at > NOW()
        AND appointment.status IN ('pending', 'confirmed')
        AND ${predicate}
      LIMIT 1
    `, params);
    if (result.rows.length > 0) throw new OwnerScheduleError('SCHEDULE_CONFLICTS_WITH_FUTURE_APPOINTMENTS', 409, '新排班与已有未来预约冲突');
  };

  const getWeekly = async (req, res) => {
    if (!isUuid(req.params.staffId) || !isUuid(req.query.locationId)) return res.status(400).json({ success: false, message: '员工或地点ID不正确' });
    let client;
    try {
      client = await pool.connect();
      const scope = await loadScope(client, req.ownerAuth.shopId, req.params.staffId, req.query.locationId);
      const result = await client.query(`
        SELECT day_of_week, start_time, end_time, effective_from, effective_to
        FROM staff_location_working_hours
        WHERE shop_id = $1 AND staff_id = $2 AND location_id = $3
          AND is_active = TRUE
        ORDER BY day_of_week, start_time
      `, [req.ownerAuth.shopId, req.params.staffId, req.query.locationId]);
      if (result.rows.some(row => row.effective_from != null || row.effective_to != null) ||
          new Set(result.rows.map(row => row.day_of_week)).size !== result.rows.length) {
        throw new OwnerScheduleError('SCHEDULE_CONFIGURATION_UNSUPPORTED', 409, '当前排班包含多个同日时段，暂不能用此接口管理');
      }
      const byDay = new Map(result.rows.map(row => [row.day_of_week, row]));
      return res.json({ success: true, data: {
        staffId: req.params.staffId, locationId: req.query.locationId, timezone: scope.timezone,
        days: Array.from({ length: 7 }, (_, index) => {
          const row = byDay.get(index + 1);
          return row ? { dayOfWeek: index + 1, isWorking: true, startTime: String(row.start_time).slice(0, 5), endTime: String(row.end_time).slice(0, 5) } : { dayOfWeek: index + 1, isWorking: false };
        })
      } });
    } catch (error) { return sendError(res, error, '读取周排班失败'); }
    finally { if (client) client.release(); }
  };

  const putWeekly = async (req, res) => {
    if (!isUuid(req.params.staffId)) return res.status(400).json({ success: false, message: '员工ID不正确' });
    const validation = validateWeeklyBody(req.body, isUuid);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    try {
      await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        const scope = await loadScope(client, req.ownerAuth.shopId, req.params.staffId, validation.locationId, true);
        const current = await client.query(`
          SELECT id, day_of_week, start_time, end_time, is_active
          FROM staff_location_working_hours
          WHERE shop_id = $1 AND staff_id = $2 AND location_id = $3
          FOR UPDATE
        `, [req.ownerAuth.shopId, req.params.staffId, validation.locationId]);
        await assertNoFutureConflict(client, { shopId: req.ownerAuth.shopId, staffId: req.params.staffId, locationId: validation.locationId, timezone: scope.timezone, mode: 'weekly', days: validation.days });
        const desired = new Map(validation.days.filter(day => day.isWorking).map(day => [day.dayOfWeek, day]));
        const used = new Set();
        for (const [dayOfWeek, day] of desired) {
          const existing = current.rows.find(row => row.day_of_week === dayOfWeek && row.is_active && !used.has(row.id)) ||
            current.rows.find(row => row.day_of_week === dayOfWeek && !used.has(row.id));
          if (existing) {
            const updated = await client.query(`UPDATE staff_location_working_hours SET start_time=$1, end_time=$2, is_active=TRUE, effective_from=NULL, effective_to=NULL, updated_at=NOW() WHERE id=$3 AND shop_id=$4 AND staff_id=$5 AND location_id=$6 RETURNING id`, [day.startTime, day.endTime, existing.id, req.ownerAuth.shopId, req.params.staffId, validation.locationId]);
            if (updated.rows.length !== 1) throw new Error('weekly_update_rowcount');
            used.add(existing.id);
          } else {
            const inserted = await client.query(`INSERT INTO staff_location_working_hours (shop_id,location_id,staff_id,day_of_week,start_time,end_time,is_active,effective_from,effective_to) VALUES ($1,$2,$3,$4,$5,$6,TRUE,NULL,NULL) RETURNING id`, [req.ownerAuth.shopId, validation.locationId, req.params.staffId, dayOfWeek, day.startTime, day.endTime]);
            if (inserted.rows.length !== 1) throw new Error('weekly_insert_rowcount');
          }
        }
        const deactivateIds = current.rows.filter(row => row.is_active && !used.has(row.id)).map(row => row.id);
        const deactivated = deactivateIds.length === 0 ? { rows: [] } : await client.query(`UPDATE staff_location_working_hours SET is_active=FALSE, updated_at=NOW() WHERE shop_id=$1 AND staff_id=$2 AND location_id=$3 AND id=ANY($4::UUID[]) RETURNING id`, [req.ownerAuth.shopId, req.params.staffId, validation.locationId, deactivateIds]);
        if (deactivated.rows.length !== deactivateIds.length) throw new Error('weekly_deactivate_rowcount');
      });
      return res.json({ success: true });
    } catch (error) { return sendError(res, error, '更新周排班失败'); }
  };

  const getOverrides = async (req, res) => {
    if (!isUuid(req.params.staffId) || (req.query.locationId !== undefined && !isUuid(req.query.locationId))) return res.status(400).json({ success: false, message: '员工或地点ID不正确' });
    let client;
    try {
      client = await pool.connect();
      const staff = await client.query(`SELECT id FROM staff WHERE id=$1 AND shop_id=$2 LIMIT 1`, [req.params.staffId, req.ownerAuth.shopId]);
      if (staff.rows.length !== 1) throw new OwnerScheduleError('STAFF_NOT_FOUND', 404, '未找到该员工');
      if (req.query.locationId) await loadScope(client, req.ownerAuth.shopId, req.params.staffId, req.query.locationId);
      const result = await client.query(`
        SELECT override.id, override.location_id, location.name AS location_name, location.timezone,
          override.schedule_date, override.override_type, override.start_time, override.end_time,
          override.reason, override.approval_status, override.is_active, override.created_at, override.updated_at
        FROM staff_schedule_overrides AS override
        JOIN locations AS location ON location.shop_id=override.shop_id AND location.id=override.location_id
        JOIN staff_location_assignments AS assignment ON assignment.shop_id=override.shop_id AND assignment.staff_id=override.staff_id AND assignment.location_id=override.location_id
        WHERE override.shop_id=$1 AND override.staff_id=$2 AND ($3::UUID IS NULL OR override.location_id=$3)
        ORDER BY override.schedule_date DESC, override.created_at DESC
      `, [req.ownerAuth.shopId, req.params.staffId, req.query.locationId || null]);
      return res.json({ success: true, data: result.rows });
    } catch (error) { return sendError(res, error, '读取特殊排班失败'); }
    finally { if (client) client.release(); }
  };

  const postOverride = async (req, res) => {
    if (!isUuid(req.params.staffId)) return res.status(400).json({ success: false, message: '员工ID不正确' });
    const validation = validateOverrideCreate(req.body, isUuid);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const value = validation.value;
    try {
      const row = await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        const scope = await loadScope(client, req.ownerAuth.shopId, req.params.staffId, value.locationId, true);
        await assertNoFutureConflict(client, { shopId: req.ownerAuth.shopId, staffId: req.params.staffId, locationId: value.locationId, timezone: scope.timezone, mode: 'override', override: value });
        const result = await client.query(`
          INSERT INTO staff_schedule_overrides (shop_id,location_id,staff_id,schedule_date,override_type,start_time,end_time,reason,approval_status,is_active,created_by,created_by_type)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',TRUE,$9,'admin')
          RETURNING id,location_id,schedule_date,override_type,start_time,end_time,reason,approval_status,is_active,created_at,updated_at
        `, [req.ownerAuth.shopId, value.locationId, req.params.staffId, value.scheduleDate, value.overrideType, value.startTime, value.endTime, value.reason ?? null, req.ownerAuth.accountId]);
        if (result.rows.length !== 1) throw new Error('override_insert_rowcount');
        return result.rows[0];
      });
      return res.status(201).json({ success: true, data: row });
    } catch (error) { return sendError(res, error, '创建特殊排班失败'); }
  };

  const patchOverride = async (req, res) => {
    if (!isUuid(req.params.staffId) || !isUuid(req.params.overrideId)) return res.status(400).json({ success: false, message: '员工或特殊排班ID不正确' });
    const validation = validateOverridePatch(req.body);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    try {
      const row = await runInTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        const currentResult = await client.query(`
          SELECT override.*, location.timezone
          FROM staff_schedule_overrides AS override
          JOIN staff AS staff_member ON staff_member.shop_id=override.shop_id AND staff_member.id=override.staff_id
          JOIN locations AS location ON location.shop_id=override.shop_id AND location.id=override.location_id
          JOIN staff_location_assignments AS assignment ON assignment.shop_id=override.shop_id AND assignment.staff_id=override.staff_id AND assignment.location_id=override.location_id AND assignment.is_active=TRUE
          WHERE override.id=$1 AND override.staff_id=$2 AND override.shop_id=$3
          FOR UPDATE OF override, staff_member, location, assignment
        `, [req.params.overrideId, req.params.staffId, req.ownerAuth.shopId]);
        if (currentResult.rows.length !== 1) throw new OwnerScheduleError('OVERRIDE_NOT_FOUND', 404, '未找到该特殊排班');
        const current = currentResult.rows[0];
        const merged = {
          scheduleDate: validation.value.scheduleDate ?? (current.schedule_date instanceof Date ? current.schedule_date.toISOString().slice(0, 10) : String(current.schedule_date).slice(0, 10)),
          overrideType: validation.value.overrideType ?? (current.override_type === 'working' ? 'custom_hours' : current.override_type),
          startTime: validation.value.startTime !== undefined ? validation.value.startTime : (current.start_time == null ? null : String(current.start_time).slice(0, 5)),
          endTime: validation.value.endTime !== undefined ? validation.value.endTime : (current.end_time == null ? null : String(current.end_time).slice(0, 5)),
          reason: validation.value.reason !== undefined ? validation.value.reason : current.reason,
          approvalStatus: validation.value.approvalStatus ?? current.approval_status,
          isActive: validation.value.isActive ?? current.is_active
        };
        const normalized = normalizeOverride(merged);
        if (normalized.error) throw new OwnerScheduleError('INVALID_OVERRIDE', 400, normalized.error);
        Object.assign(merged, normalized.value);
        if (merged.isActive && ['pending', 'approved'].includes(merged.approvalStatus)) await assertNoFutureConflict(client, { shopId: req.ownerAuth.shopId, staffId: req.params.staffId, locationId: current.location_id, timezone: current.timezone, mode: 'override', override: merged });
        const result = await client.query(`
          UPDATE staff_schedule_overrides SET schedule_date=$1,override_type=$2,start_time=$3,end_time=$4,reason=$5,approval_status=$6,is_active=$7,updated_at=NOW()
          WHERE id=$8 AND staff_id=$9 AND shop_id=$10 AND location_id=$11
          RETURNING id,location_id,schedule_date,override_type,start_time,end_time,reason,approval_status,is_active,created_at,updated_at
        `, [merged.scheduleDate, merged.overrideType, merged.startTime, merged.endTime, merged.reason == null ? null : String(merged.reason).trim() || null, merged.approvalStatus, merged.isActive, req.params.overrideId, req.params.staffId, req.ownerAuth.shopId, current.location_id]);
        if (result.rows.length !== 1) throw new Error('override_update_rowcount');
        return result.rows[0];
      });
      return res.json({ success: true, data: row });
    } catch (error) { return sendError(res, error, '更新特殊排班失败'); }
  };

  return { getWeekly, putWeekly, getOverrides, postOverride, patchOverride };
};

module.exports = { OwnerScheduleError, createOwnerScheduleManagement, isValidDate, validTimeRange, validateWeeklyBody, validateOverrideCreate, validateOverridePatch };
