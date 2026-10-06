'use strict';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// NOTE: Temporary fallback business hours (10:00–21:00) until a structured location
// business hours data model is introduced. Used across customer availability,
// bookability validator, appointment editing, and owner/front-desk calendar.
// Keep in one place so all Phase 1 components share the exact same boundary.
// When structured location business hours are introduced, replace this fallback source.
const DEFAULT_BUSINESS_WINDOWS = Object.freeze([
  Object.freeze({ start: '10:00', end: '21:00' })
]);
const DEFAULT_BUSINESS_HOURS_SOURCE = 'fallback';

const normalizeTime = value => {
  if (value == null) return null;
  const match = String(value).trim().match(TIME_PATTERN);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
};

const timeToMinutes = value => {
  const normalized = normalizeTime(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  return hour * 60 + minute;
};

const minutesToTime = minutes => {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return null;
  if (minutes === 1440) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const isValidDate = value => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const isValidTimezone = value => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.trim() });
    return true;
  } catch (_) {
    return false;
  }
};

const getIsoWeekday = date => {
  if (!isValidDate(date)) return null;
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

const normalizeWindows = windows => {
  if (!Array.isArray(windows)) return null;
  const parsed = [];
  for (const window of windows) {
    const start = timeToMinutes(window && window.start);
    const end = timeToMinutes(window && window.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    parsed.push({ start, end });
  }
  parsed.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].start < parsed[index - 1].end) return null;
  }
  return parsed;
};

const serializeWindows = windows => windows.map(window => ({
  start: minutesToTime(window.start),
  end: minutesToTime(window.end)
}));

const intersectWindows = (leftWindows, rightWindows) => {
  const result = [];
  for (const left of leftWindows) {
    for (const right of rightWindows) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (end > start) result.push({ start, end });
    }
  }
  return result.sort((left, right) => left.start - right.start || left.end - right.end);
};

const subtractWindows = (windows, exclusions) => {
  let result = windows.slice();
  for (const exclusion of exclusions) {
    const next = [];
    for (const window of result) {
      if (exclusion.end <= window.start || exclusion.start >= window.end) {
        next.push(window);
        continue;
      }
      if (exclusion.start > window.start) {
        next.push({ start: window.start, end: Math.min(exclusion.start, window.end) });
      }
      if (exclusion.end < window.end) {
        next.push({ start: Math.max(exclusion.end, window.start), end: window.end });
      }
    }
    result = next;
  }
  return result;
};

const resultFor = (status, reason, source, workingWindows = []) => ({
  status,
  workingWindows,
  reason,
  source
});

const resolveEffectiveSchedule = ({
  staff,
  assignmentActive,
  workingHours = [],
  overrides = [],
  businessWindows = DEFAULT_BUSINESS_WINDOWS,
  businessHoursSource = DEFAULT_BUSINESS_HOURS_SOURCE,
  date,
  timezone
}) => {
  if (!staff || typeof staff !== 'object' || !isValidDate(date) || !isValidTimezone(timezone)) {
    return resultFor('invalid', 'SCHEDULE_INPUT_INVALID', 'invalid');
  }
  if (staff.is_active !== true) return resultFor('invalid', 'STAFF_INACTIVE', 'staff');
  if (staff.bookable !== true) return resultFor('invalid', 'STAFF_NOT_BOOKABLE', 'staff');
  if (assignmentActive !== true) return resultFor('invalid', 'STAFF_LOCATION_NOT_ASSIGNED', 'assignment');

  const normalizedBusiness = normalizeWindows(businessWindows);
  if (!normalizedBusiness || normalizedBusiness.length === 0) {
    return resultFor('invalid', 'BUSINESS_HOURS_INVALID', 'business_hours');
  }

  const controlling = overrides.filter(override =>
    override &&
    override.is_active !== false &&
    String(override.schedule_date || '').slice(0, 10) === date &&
    ['pending', 'approved'].includes(String(override.approval_status || '').toLowerCase())
  );

  if (controlling.length > 1) {
    return resultFor('invalid', 'SCHEDULE_CONFIGURATION_INVALID', 'override');
  }
  if (controlling.some(override => String(override.approval_status).toLowerCase() === 'pending')) {
    return resultFor('pending', 'SCHEDULE_OVERRIDE_PENDING', 'override');
  }

  const approved = controlling.filter(override => String(override.approval_status).toLowerCase() === 'approved');
  const override = approved[0] || null;
  const overrideType = String(override && override.override_type || '').toLowerCase();

  if (overrideType === 'day_off' ||
      (overrideType === 'leave' && !override.start_time && !override.end_time)) {
    return resultFor('off_day', overrideType === 'day_off' ? 'DAY_OFF' : 'FULL_DAY_LEAVE', 'override');
  }

  const isoWeekday = getIsoWeekday(date);
  const weeklyRows = workingHours.filter(hours => {
    if (!hours || hours.is_active === false || Number(hours.day_of_week) !== isoWeekday) return false;
    const effectiveFrom = hours.effective_from ? String(hours.effective_from).slice(0, 10) : null;
    const effectiveTo = hours.effective_to ? String(hours.effective_to).slice(0, 10) : null;
    return (!effectiveFrom || effectiveFrom <= date) && (!effectiveTo || effectiveTo >= date);
  });
  const weeklyWindows = normalizeWindows(weeklyRows.map(hours => ({
    start: hours.start_time,
    end: hours.end_time
  })));

  if (!weeklyWindows) {
    return resultFor('invalid', 'SCHEDULE_CONFIGURATION_INVALID', 'weekly');
  }

  let effectiveWindows = weeklyWindows;
  let source = 'weekly';
  let reason = 'WEEKLY_HOURS';

  if (overrideType === 'custom_hours' || overrideType === 'working') {
    const customWindows = normalizeWindows([{ start: override.start_time, end: override.end_time }]);
    if (!customWindows || customWindows.length !== 1) {
      return resultFor('invalid', 'SCHEDULE_CONFIGURATION_INVALID', 'override');
    }
    effectiveWindows = customWindows;
    source = 'override';
    reason = 'CUSTOM_HOURS';
  } else if (overrideType === 'leave') {
    const leaveWindows = normalizeWindows([{ start: override.start_time, end: override.end_time }]);
    if (!leaveWindows || leaveWindows.length !== 1) {
      return resultFor('invalid', 'SCHEDULE_CONFIGURATION_INVALID', 'override');
    }
    effectiveWindows = subtractWindows(weeklyWindows, leaveWindows);
    source = 'weekly_with_leave';
    reason = 'PARTIAL_LEAVE';
  } else if (override && overrideType) {
    return resultFor('invalid', 'SCHEDULE_CONFIGURATION_INVALID', 'override');
  }

  if (effectiveWindows.length === 0) {
    return resultFor('off_day', weeklyWindows.length === 0 ? 'NO_WORKING_HOURS' : 'FULL_DAY_LEAVE', source);
  }

  const clippedWindows = intersectWindows(effectiveWindows, normalizedBusiness);
  if (clippedWindows.length === 0) {
    return resultFor('off_day', 'OUTSIDE_BUSINESS_HOURS', `${source}+${businessHoursSource}`);
  }

  return resultFor(
    'working',
    reason,
    `${source}+${businessHoursSource}`,
    serializeWindows(clippedWindows)
  );
};

const isIntervalWithinWorkingWindows = ({ start, end, workingWindows }) => {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  const normalized = normalizeWindows(workingWindows);
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes) || endMinutes <= startMinutes || !normalized) {
    return false;
  }
  return normalized.some(window => startMinutes >= window.start && endMinutes <= window.end);
};

const getLocalDateTimeParts = (instant, timezone) => {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime()) || !isValidTimezone(timezone)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((map, part) => {
    if (part.type !== 'literal') map[part.type] = part.value;
    return map;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
};

const loadCalendarStaffAvailability = async ({
  dbClient,
  shopId,
  locationId,
  date,
  businessWindows = DEFAULT_BUSINESS_WINDOWS,
  businessHoursSource = DEFAULT_BUSINESS_HOURS_SOURCE
}) => {
  if (!dbClient || typeof dbClient.query !== 'function' || !shopId || !locationId || !isValidDate(date)) {
    const error = new Error('CALENDAR_STAFF_INPUT_INVALID');
    error.code = 'CALENDAR_STAFF_INPUT_INVALID';
    throw error;
  }

  const locationResult = await dbClient.query(
    `SELECT id, timezone
       FROM locations
      WHERE id = $1::UUID
        AND shop_id = $2::UUID
        AND is_active = TRUE
      LIMIT 1`,
    [locationId, shopId]
  );
  if (locationResult.rows.length !== 1) {
    const error = new Error('LOCATION_NOT_FOUND');
    error.code = 'LOCATION_NOT_FOUND';
    throw error;
  }
  const location = locationResult.rows[0];
  if (!isValidTimezone(location.timezone)) {
    const error = new Error('LOCATION_TIMEZONE_INVALID');
    error.code = 'LOCATION_TIMEZONE_INVALID';
    throw error;
  }

  const staffResult = await dbClient.query(
    `SELECT staff.id AS staff_id, staff.name, staff.is_active, staff.bookable
       FROM staff
       JOIN staff_location_assignments AS assignment
         ON assignment.shop_id = staff.shop_id
        AND assignment.staff_id = staff.id
        AND assignment.location_id = $2::UUID
        AND assignment.is_active = TRUE
      WHERE staff.shop_id = $1::UUID
        AND staff.is_active = TRUE
        AND staff.bookable = TRUE
      ORDER BY staff.name ASC, staff.id ASC`,
    [shopId, locationId]
  );

  if (staffResult.rows.length === 0) {
    return {
      locationId: location.id,
      timezone: location.timezone,
      date,
      businessWindows: serializeWindows(normalizeWindows(businessWindows) || []),
      businessHoursSource,
      staff: []
    };
  }

  const staffIds = staffResult.rows.map(row => row.staff_id);
  const workingResult = await dbClient.query(
    `SELECT staff_id, day_of_week, start_time::TEXT AS start_time,
            end_time::TEXT AS end_time, effective_from::TEXT AS effective_from,
            effective_to::TEXT AS effective_to, is_active
       FROM staff_location_working_hours
      WHERE shop_id = $1::UUID
        AND location_id = $2::UUID
        AND staff_id = ANY($3::UUID[])
        AND day_of_week = EXTRACT(ISODOW FROM $4::DATE)::INTEGER
        AND is_active = TRUE
        AND (effective_from IS NULL OR effective_from <= $4::DATE)
        AND (effective_to IS NULL OR effective_to >= $4::DATE)
      ORDER BY staff_id, start_time, end_time, id`,
    [shopId, locationId, staffIds, date]
  );
  const overrideResult = await dbClient.query(
    `SELECT id, staff_id, schedule_date::TEXT AS schedule_date,
            override_type, start_time::TEXT AS start_time,
            end_time::TEXT AS end_time, approval_status, is_active
       FROM staff_schedule_overrides
      WHERE shop_id = $1::UUID
        AND location_id = $2::UUID
        AND staff_id = ANY($3::UUID[])
        AND schedule_date = $4::DATE
        AND is_active = TRUE
        AND approval_status IN ('pending', 'approved')
      ORDER BY staff_id, created_at DESC, id`,
    [shopId, locationId, staffIds, date]
  );

  const visibleStaff = [];
  for (const staff of staffResult.rows) {
    const schedule = resolveEffectiveSchedule({
      staff,
      assignmentActive: true,
      workingHours: workingResult.rows.filter(row => row.staff_id === staff.staff_id),
      overrides: overrideResult.rows.filter(row => row.staff_id === staff.staff_id),
      businessWindows,
      businessHoursSource,
      date,
      timezone: location.timezone
    });
    if (schedule.status === 'working') {
      visibleStaff.push({
        id: staff.staff_id,
        name: staff.name,
        status: schedule.status,
        workingWindows: schedule.workingWindows,
        reason: schedule.reason,
        source: schedule.source
      });
    }
  }

  return {
    locationId: location.id,
    timezone: location.timezone,
    date,
    businessWindows: serializeWindows(normalizeWindows(businessWindows) || []),
    businessHoursSource,
    staff: visibleStaff
  };
};

module.exports = {
  DEFAULT_BUSINESS_WINDOWS,
  DEFAULT_BUSINESS_HOURS_SOURCE,
  normalizeTime,
  timeToMinutes,
  isValidDate,
  isValidTimezone,
  normalizeWindows,
  resolveEffectiveSchedule,
  isIntervalWithinWorkingWindows,
  getLocalDateTimeParts,
  loadCalendarStaffAvailability
};
