'use strict';

const {
  buildSequentialTimeline,
  planStaffAssignments
} = require('./customer-multi-service-booking');

const timeToSeconds = timeStr => {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts[2] !== undefined ? Number(parts[2]) : 0;
  return h * 3600 + m * 60 + s;
};

const getCalendarDatesRange = (startDate, endDate) => {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const dayCount = Math.floor((end - start) / 86400000) + 1;
  const dates = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    dates.push(new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10));
  }
  return dates;
};

const getTodayInTimezone = (dateObj, timezone) => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);
};

const getLocalParts = (instant, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isoWeekday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const secondsFromMidnight = hour * 3600 + minute * 60 + second;
  return { dateStr, isoWeekday, secondsFromMidnight, hour, minute, second };
};

const evaluateScheduleSemantics = ({
  requestedStartAt,
  requestedEndAt,
  staffId,
  serviceId,
  timezone,
  candidatesByService,
  workingHours = [],
  overrides = [],
  blockingAssignments = [],
  chosen = []
}) => {
  // 1. Staff capability
  if (candidatesByService) {
    const eligible = candidatesByService.get(serviceId);
    if (!eligible || !eligible.some(s => s.staff_id === staffId)) {
      const err = new Error('STAFF_SERVICE_NOT_ALLOWED');
      err.unavailable = true;
      throw err;
    }
  }

  // 2. Interval & Midnight check
  const startInstant = new Date(requestedStartAt);
  const endInstant = new Date(requestedEndAt);
  const startMs = startInstant.getTime();
  const endMs = endInstant.getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const err = new Error('BOOKABILITY_INTERVAL_INVALID');
    err.unavailable = true;
    throw err;
  }

  const localStart = getLocalParts(startInstant, timezone);
  const localEnd = getLocalParts(endInstant, timezone);

  // Must not cross midnight in local timezone: local_start::DATE = local_end::DATE
  if (localStart.dateStr !== localEnd.dateStr) {
    const err = new Error('BOOKABILITY_INTERVAL_INVALID');
    err.unavailable = true;
    throw err;
  }

  const itemStartSeconds = localStart.secondsFromMidnight;
  const itemEndSeconds = localEnd.secondsFromMidnight;

  // 3. Overrides check for localStart.dateStr
  const staffOverrides = overrides.filter(o => o.staff_id === staffId && o.schedule_date === localStart.dateStr);
  if (staffOverrides.length > 1) {
    const err = new Error('SCHEDULE_CONFIGURATION_INVALID');
    err.unavailable = true;
    throw err;
  }
  if (staffOverrides.some(o => o.approval_status === 'pending')) {
    const err = new Error('SCHEDULE_OVERRIDE_PENDING');
    err.unavailable = true;
    throw err;
  }

  const approvedOverrides = staffOverrides.filter(o => o.approval_status === 'approved');
  const hasCustomHours = approvedOverrides.some(o => o.override_type === 'custom_hours' || o.override_type === 'working');
  const isDayOff = approvedOverrides.some(o => o.override_type === 'day_off');
  const isFullDayLeave = approvedOverrides.some(o => o.override_type === 'leave' && !o.start_time && !o.end_time);

  if (isDayOff || isFullDayLeave) {
    const err = new Error('STAFF_ON_LEAVE');
    err.unavailable = true;
    throw err;
  }

  if (hasCustomHours) {
    const custom = approvedOverrides.find(o => o.override_type === 'custom_hours' || o.override_type === 'working');
    const customStartSec = custom.startSeconds !== undefined ? custom.startSeconds : timeToSeconds(custom.start_time);
    const customEndSec = custom.endSeconds !== undefined ? custom.endSeconds : timeToSeconds(custom.end_time);
    if (itemStartSeconds < customStartSec || itemEndSeconds > customEndSec) {
      const err = new Error('OUTSIDE_WORKING_HOURS');
      err.unavailable = true;
      throw err;
    }
  } else {
    // Weekly working hours
    const weekly = workingHours.filter(h => h.staff_id === staffId && Number(h.day_of_week) === localStart.isoWeekday);
    const activeWeekly = weekly.filter(h => {
      if (h.effective_from && h.effective_from > localStart.dateStr) return false;
      if (h.effective_to && h.effective_to < localStart.dateStr) return false;
      return true;
    }).map(h => ({
      ...h,
      startSeconds: h.startSeconds !== undefined ? h.startSeconds : timeToSeconds(h.start_time),
      endSeconds: h.endSeconds !== undefined ? h.endSeconds : timeToSeconds(h.end_time)
    }));

    // Overlapping weekly ranges check
    for (let i = 0; i < activeWeekly.length; i++) {
      for (let j = i + 1; j < activeWeekly.length; j++) {
        if (activeWeekly[i].startSeconds < activeWeekly[j].endSeconds && activeWeekly[j].startSeconds < activeWeekly[i].endSeconds) {
          const err = new Error('SCHEDULE_CONFIGURATION_INVALID');
          err.unavailable = true;
          throw err;
        }
      }
    }

    if (activeWeekly.length === 0) {
      const err = new Error('NO_WORKING_HOURS');
      err.unavailable = true;
      throw err;
    }

    const contained = activeWeekly.some(h => itemStartSeconds >= h.startSeconds && itemEndSeconds <= h.endSeconds);
    if (!contained) {
      const err = new Error('OUTSIDE_WORKING_HOURS');
      err.unavailable = true;
      throw err;
    }

    // Partial leave check
    const partialLeaves = approvedOverrides
      .filter(o => o.override_type === 'leave' && o.start_time && o.end_time)
      .map(o => ({
        ...o,
        startSeconds: o.startSeconds !== undefined ? o.startSeconds : timeToSeconds(o.start_time),
        endSeconds: o.endSeconds !== undefined ? o.endSeconds : timeToSeconds(o.end_time)
      }));

    for (const pl of partialLeaves) {
      if (itemStartSeconds < pl.endSeconds && itemEndSeconds > pl.startSeconds) {
        const err = new Error('STAFF_ON_LEAVE');
        err.unavailable = true;
        throw err;
      }
    }
  }

  // 4. Collision with existing blocking assignments
  const assignments = blockingAssignments.filter(a => a.staff_id === staffId);
  for (const a of assignments) {
    const aStartMs = a.startMs !== undefined ? a.startMs : new Date(a.start_at).getTime();
    const aEndMs = a.endMs !== undefined ? a.endMs : new Date(a.end_at).getTime();
    if (aStartMs < endMs && aEndMs > startMs) {
      const err = new Error('APPOINTMENT_COLLISION');
      err.unavailable = true;
      throw err;
    }
  }

  // 5. Collision with chosen items in multi-service cart
  if (chosen && chosen.length > 0) {
    for (const c of chosen) {
      if (c.staffId === staffId) {
        const cStartMs = c.startMs !== undefined ? c.startMs : new Date(c.startAt).getTime();
        const cEndMs = c.endMs !== undefined ? c.endMs : new Date(c.endAt).getTime();
        if (cStartMs < endMs && cEndMs > startMs) {
          const err = new Error('APPOINTMENT_COLLISION');
          err.unavailable = true;
          throw err;
        }
      }
    }
  }

  return true;
};

const createBatchValidator = ({
  candidatesByService,
  workingHours,
  overrides,
  blockingAssignments,
  timezone
}) => {
  // Index working hours by `${staff_id}:${day_of_week}`
  const hoursByStaffDay = new Map();
  for (const h of workingHours) {
    const key = `${h.staff_id}:${h.day_of_week}`;
    if (!hoursByStaffDay.has(key)) hoursByStaffDay.set(key, []);
    hoursByStaffDay.get(key).push({
      ...h,
      startSeconds: timeToSeconds(h.start_time),
      endSeconds: timeToSeconds(h.end_time)
    });
  }

  // Index overrides by `${staff_id}:${schedule_date}`
  const overridesByStaffDate = new Map();
  for (const o of overrides) {
    const key = `${o.staff_id}:${o.schedule_date}`;
    if (!overridesByStaffDate.has(key)) overridesByStaffDate.set(key, []);
    overridesByStaffDate.get(key).push({
      ...o,
      startSeconds: timeToSeconds(o.start_time),
      endSeconds: timeToSeconds(o.end_time)
    });
  }

  // Index blocking assignments by `staff_id`
  const assignmentsByStaff = new Map();
  for (const a of blockingAssignments) {
    if (!assignmentsByStaff.has(a.staff_id)) assignmentsByStaff.set(a.staff_id, []);
    assignmentsByStaff.get(a.staff_id).push({
      startMs: new Date(a.start_at).getTime(),
      endMs: new Date(a.end_at).getTime()
    });
  }

  return (item, staffId, chosen) => {
    // 1. Staff capability
    const eligible = candidatesByService.get(item.serviceId);
    if (!eligible || !eligible.some(s => s.staff_id === staffId)) {
      const err = new Error('STAFF_SERVICE_NOT_ALLOWED');
      err.unavailable = true;
      throw err;
    }

    // 2. Interval & Midnight check
    const startInstant = new Date(item.startAt);
    const endInstant = new Date(item.endAt);
    const startMs = startInstant.getTime();
    const endMs = endInstant.getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      const err = new Error('BOOKABILITY_INTERVAL_INVALID');
      err.unavailable = true;
      throw err;
    }

    const localStart = getLocalParts(startInstant, timezone);
    const localEnd = getLocalParts(endInstant, timezone);

    // Must not cross midnight in local timezone: local_start::DATE = local_end::DATE
    if (localStart.dateStr !== localEnd.dateStr) {
      const err = new Error('BOOKABILITY_INTERVAL_INVALID');
      err.unavailable = true;
      throw err;
    }

    const itemStartSeconds = localStart.secondsFromMidnight;
    const itemEndSeconds = localEnd.secondsFromMidnight;

    // 3. Overrides check
    const staffOverrides = overridesByStaffDate.get(`${staffId}:${localStart.dateStr}`) || [];
    if (staffOverrides.length > 1) {
      const err = new Error('SCHEDULE_CONFIGURATION_INVALID');
      err.unavailable = true;
      throw err;
    }
    if (staffOverrides.some(o => o.approval_status === 'pending')) {
      const err = new Error('SCHEDULE_OVERRIDE_PENDING');
      err.unavailable = true;
      throw err;
    }

    const approvedOverrides = staffOverrides.filter(o => o.approval_status === 'approved');
    const hasCustomHours = approvedOverrides.some(o => o.override_type === 'custom_hours' || o.override_type === 'working');
    const isDayOff = approvedOverrides.some(o => o.override_type === 'day_off');
    const isFullDayLeave = approvedOverrides.some(o => o.override_type === 'leave' && !o.start_time && !o.end_time);

    if (isDayOff || isFullDayLeave) {
      const err = new Error('STAFF_ON_LEAVE');
      err.unavailable = true;
      throw err;
    }

    if (hasCustomHours) {
      const custom = approvedOverrides.find(o => o.override_type === 'custom_hours' || o.override_type === 'working');
      if (itemStartSeconds < custom.startSeconds || itemEndSeconds > custom.endSeconds) {
        const err = new Error('OUTSIDE_WORKING_HOURS');
        err.unavailable = true;
        throw err;
      }
    } else {
      // Weekly working hours
      const weekly = hoursByStaffDay.get(`${staffId}:${localStart.isoWeekday}`) || [];
      const activeWeekly = weekly.filter(h => {
        if (h.effective_from && h.effective_from > localStart.dateStr) return false;
        if (h.effective_to && h.effective_to < localStart.dateStr) return false;
        return true;
      });

      // Overlapping weekly ranges check
      for (let i = 0; i < activeWeekly.length; i++) {
        for (let j = i + 1; j < activeWeekly.length; j++) {
          if (activeWeekly[i].startSeconds < activeWeekly[j].endSeconds && activeWeekly[j].startSeconds < activeWeekly[i].endSeconds) {
            const err = new Error('SCHEDULE_CONFIGURATION_INVALID');
            err.unavailable = true;
            throw err;
          }
        }
      }

      if (activeWeekly.length === 0) {
        const err = new Error('NO_WORKING_HOURS');
        err.unavailable = true;
        throw err;
      }

      const contained = activeWeekly.some(h => itemStartSeconds >= h.startSeconds && itemEndSeconds <= h.endSeconds);
      if (!contained) {
        const err = new Error('OUTSIDE_WORKING_HOURS');
        err.unavailable = true;
        throw err;
      }

      // Partial leave check
      const partialLeaves = approvedOverrides.filter(o => o.override_type === 'leave' && o.start_time && o.end_time);
      for (const pl of partialLeaves) {
        if (itemStartSeconds < pl.endSeconds && itemEndSeconds > pl.startSeconds) {
          const err = new Error('STAFF_ON_LEAVE');
          err.unavailable = true;
          throw err;
        }
      }
    }

    // 4. Collision with existing blocking assignments
    const assignments = assignmentsByStaff.get(staffId) || [];
    for (const a of assignments) {
      if (a.startMs < endMs && a.endMs > startMs) {
        const err = new Error('APPOINTMENT_COLLISION');
        err.unavailable = true;
        throw err;
      }
    }

    // 5. Collision with chosen items in the same multi-service cart (if assigned to same staff)
    if (chosen && chosen.length > 0) {
      for (const c of chosen) {
        if (c.staffId === staffId) {
          const cStartMs = new Date(c.startAt).getTime();
          const cEndMs = new Date(c.endAt).getTime();
          if (cStartMs < endMs && cEndMs > startMs) {
            const err = new Error('APPOINTMENT_COLLISION');
            err.unavailable = true;
            throw err;
          }
        }
      }
    }
  };
};

const computeBatchAvailability = async ({
  client,
  context,
  startDate,
  endDate,
  validator,
  defaultValidator,
  loadEligibleBookingStaff,
  planMultiServiceStaff,
  bookingTimes,
  earlyExitPerDate = false,
  now = new Date()
}) => {
  const timezone = context.scope.timezone || 'UTC';
  const effectiveNow = now instanceof Date ? now : (now ? new Date(now) : new Date());
  const nowMs = effectiveNow.getTime();
  const todayInZone = getTodayInTimezone(effectiveNow, timezone);

  const allDates = getCalendarDatesRange(startDate, endDate);
  const resultByDate = new Map();

  // Any date prior to today in shop authoritative timezone is strictly unavailable
  for (const date of allDates) {
    if (date < todayInZone) {
      resultByDate.set(date, []);
    }
  }

  const eligibleDates = allDates.filter(d => d >= todayInZone);
  if (eligibleDates.length === 0) {
    return resultByDate;
  }

  const uniqueServiceIds = [...new Set(context.services.map(item => item.serviceId))];

  // 1. Authoritative candidate staff loaded ONCE for the request
  const candidatesByService = new Map();
  for (const serviceId of uniqueServiceIds) {
    const list = await loadEligibleBookingStaff(client, {
      shopId: context.scope.shop_id,
      locationId: context.scope.location_id,
      serviceId
    });
    candidatesByService.set(serviceId, list);
  }

  // If any service has 0 qualified staff, no slot is available
  for (const serviceId of uniqueServiceIds) {
    if (!candidatesByService.get(serviceId) || candidatesByService.get(serviceId).length === 0) {
      for (const d of eligibleDates) resultByDate.set(d, []);
      return resultByDate;
    }
  }

  const isCustomValidator = validator && defaultValidator && validator !== defaultValidator;

  if (isCustomValidator) {
    // Custom mock validator provided by tests (fallback loop using the mock validator)
    for (const date of eligibleDates) {
      const instantResult = await client.query(
        `SELECT candidate.time,
           TO_CHAR((($1::DATE+candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at
         FROM locations location CROSS JOIN UNNEST($2::TEXT[]) WITH ORDINALITY candidate(time,position)
         WHERE location.shop_id=$3 AND location.id=$4 AND location.is_active=TRUE
           AND TO_CHAR(((($1::DATE+candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE location.timezone), 'HH24:MI') = candidate.time
         ORDER BY candidate.position`,
        [date, bookingTimes, context.scope.shop_id, context.scope.location_id]
      );
      const available = [];
      for (const candidate of instantResult.rows) {
        if (new Date(candidate.start_at).getTime() <= nowMs) {
          continue;
        }
        const timeline = buildSequentialTimeline(context.services, candidate.start_at);
        const plan = await planMultiServiceStaff({
          client,
          scope: context.scope,
          date,
          timeline,
          validator,
          candidatesByService
        });
        if (plan) {
          available.push({ time: candidate.time, startAt: new Date(candidate.start_at).toISOString() });
          if (earlyExitPerDate) break;
        }
      }
      resultByDate.set(date, available);
    }
    return resultByDate;
  }

  // 2. Authoritative Batch queries for the entire date range
  const allStaffIds = [...new Set(
    Array.from(candidatesByService.values()).flatMap(list => list.map(c => c.staff_id))
  )];

  // 2a. Slot instants query across all eligible dates (filters out nonexistent local wall-clock times)
  const slotInstantsResult = await client.query(
    `SELECT
       d.date,
       candidate.time,
       TO_CHAR(((d.date::DATE + candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at
     FROM locations location
     CROSS JOIN UNNEST($1::TEXT[]) WITH ORDINALITY d(date, d_pos)
     CROSS JOIN UNNEST($2::TEXT[]) WITH ORDINALITY candidate(time, position)
     WHERE location.shop_id = $3 AND location.id = $4 AND location.is_active = TRUE
       AND TO_CHAR(((d.date::DATE + candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE location.timezone, 'HH24:MI') = candidate.time
     ORDER BY d.d_pos, candidate.position`,
    [eligibleDates, bookingTimes, context.scope.shop_id, context.scope.location_id]
  );

  const slotsByDate = new Map();
  for (const row of slotInstantsResult.rows) {
    if (!slotsByDate.has(row.date)) slotsByDate.set(row.date, []);
    slotsByDate.get(row.date).push({ time: row.time, start_at: row.start_at });
  }

  // 2b. Working hours for these staff
  const workingHoursResult = await client.query(
    `SELECT
       hours.staff_id,
       hours.day_of_week,
       hours.start_time::TEXT AS start_time,
       hours.end_time::TEXT AS end_time,
       hours.effective_from::TEXT AS effective_from,
       hours.effective_to::TEXT AS effective_to
     FROM staff_location_working_hours AS hours
     WHERE hours.shop_id = $1::UUID
       AND hours.location_id = $2::UUID
       AND hours.staff_id = ANY($3::UUID[])
       AND hours.is_active = TRUE
     ORDER BY hours.staff_id, hours.day_of_week, hours.start_time, hours.id`,
    [context.scope.shop_id, context.scope.location_id, allStaffIds]
  );

  // 2c. Schedule overrides in date range
  const overridesResult = await client.query(
    `SELECT
       override.id,
       override.staff_id,
       override.schedule_date::TEXT AS schedule_date,
       override.override_type,
       override.start_time::TEXT AS start_time,
       override.end_time::TEXT AS end_time,
       override.approval_status
     FROM staff_schedule_overrides AS override
     WHERE override.shop_id = $1::UUID
       AND override.location_id = $2::UUID
       AND override.staff_id = ANY($3::UUID[])
       AND override.schedule_date >= $4::DATE
       AND override.schedule_date <= $5::DATE
       AND override.is_active = TRUE
       AND override.approval_status IN ('pending', 'approved')`,
    [context.scope.shop_id, context.scope.location_id, allStaffIds, eligibleDates[0], eligibleDates[eligibleDates.length - 1]]
  );

  // 2d. Blocking assignments in date range
  const totalCartMinutes = context.services.reduce((s, item) => s + Number(item.duration_minutes || item.durationMinutes), 0);
  const earliestSlotStart = slotInstantsResult.rows[0]?.start_at || `${eligibleDates[0]}T00:00:00.000Z`;
  const latestSlotStart = slotInstantsResult.rows[slotInstantsResult.rows.length - 1]?.start_at || `${eligibleDates[eligibleDates.length - 1]}T23:59:59.000Z`;
  const minStartAt = earliestSlotStart;
  const maxEndAt = new Date(new Date(latestSlotStart).getTime() + (totalCartMinutes + 60) * 60000).toISOString();

  const blockingAssignmentsResult = await client.query(
    `SELECT
       assignment.staff_id,
       collision_item.appointment_id,
       (assignment.start_at AT TIME ZONE location.timezone)::DATE::TEXT AS local_date,
       assignment.start_at,
       assignment.end_at
     FROM locations location
     JOIN appointment_item_staff_assignments AS assignment
       ON assignment.shop_id = location.shop_id AND assignment.location_id = location.id
     JOIN appointment_items AS collision_item
       ON collision_item.shop_id = assignment.shop_id
      AND collision_item.location_id = assignment.location_id
      AND collision_item.id = assignment.appointment_item_id
     WHERE location.shop_id = $1::UUID
       AND location.id = $2::UUID
       AND assignment.staff_id = ANY($3::UUID[])
       AND assignment.role IN ('primary', 'assistant')
       AND assignment.blocks_time = TRUE
       AND assignment.start_at < $5::TIMESTAMPTZ
       AND assignment.end_at > $4::TIMESTAMPTZ`,
    [context.scope.shop_id, context.scope.location_id, allStaffIds, minStartAt, maxEndAt]
  );

  // 3. In-memory validation engine setup
  const batchValidator = createBatchValidator({
    candidatesByService,
    workingHours: workingHoursResult.rows,
    overrides: overridesResult.rows,
    blockingAssignments: blockingAssignmentsResult.rows,
    timezone
  });

  // Track appointments per staff and local_date for candidate ordering
  const appointmentsCountByStaffAndDate = new Map();
  for (const row of blockingAssignmentsResult.rows) {
    const key = `${row.staff_id}:${row.local_date}`;
    if (!appointmentsCountByStaffAndDate.has(key)) {
      appointmentsCountByStaffAndDate.set(key, new Set());
    }
    appointmentsCountByStaffAndDate.get(key).add(row.appointment_id);
  }

  const getCandidatesForDate = (serviceId, date) => {
    const base = candidatesByService.get(serviceId) || [];
    return base.slice().sort((a, b) => {
      const countA = appointmentsCountByStaffAndDate.get(`${a.staff_id}:${date}`)?.size || 0;
      const countB = appointmentsCountByStaffAndDate.get(`${b.staff_id}:${date}`)?.size || 0;
      if (countA !== countB) return countA - countB;
      return a.staff_id.localeCompare(b.staff_id);
    });
  };

  for (const date of eligibleDates) {
    const slots = slotsByDate.get(date) || [];
    const available = [];

    const candidatesMapForDate = new Map();
    for (const serviceId of uniqueServiceIds) {
      candidatesMapForDate.set(serviceId, getCandidatesForDate(serviceId, date));
    }

    for (const candidate of slots) {
      // Exclude past slots (current instant or earlier)
      if (new Date(candidate.start_at).getTime() <= nowMs) {
        continue;
      }

      const timeline = buildSequentialTimeline(context.services, candidate.start_at);

      const plan = await planStaffAssignments({
        items: timeline,
        candidatesByService: candidatesMapForDate,
        validate: async (item, staffId, chosen) => {
          batchValidator(item, staffId, chosen);
        }
      });

      if (plan) {
        available.push({ time: candidate.time, startAt: new Date(candidate.start_at).toISOString() });
        if (earlyExitPerDate) break;
      }
    }

    resultByDate.set(date, available);
  }

  return resultByDate;
};

module.exports = {
  timeToSeconds,
  getCalendarDatesRange,
  getTodayInTimezone,
  getLocalParts,
  evaluateScheduleSemantics,
  createBatchValidator,
  computeBatchAvailability
};
