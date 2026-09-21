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

const createBatchValidator = ({
  candidatesByService,
  workingHours,
  overrides,
  blockingAssignments
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

  return (item, staffId, candidateDate, slotStartTime, precedingMinutes, chosen) => {
    // 1. Staff capability
    const eligible = candidatesByService.get(item.serviceId);
    if (!eligible || !eligible.some(s => s.staff_id === staffId)) {
      const err = new Error('STAFF_SERVICE_NOT_ALLOWED');
      err.unavailable = true;
      throw err;
    }

    // 2. Interval & Midnight check
    const slotStartSeconds = timeToSeconds(slotStartTime);
    const itemStartSeconds = slotStartSeconds + precedingMinutes * 60;
    const itemDurationMinutes = Number(item.duration_minutes || item.durationMinutes);
    const itemEndSeconds = itemStartSeconds + itemDurationMinutes * 60;

    if (itemEndSeconds > 86400 || itemStartSeconds >= 86400) {
      const err = new Error('BOOKABILITY_INTERVAL_INVALID');
      err.unavailable = true;
      throw err;
    }

    // 3. Overrides check
    const staffOverrides = overridesByStaffDate.get(`${staffId}:${candidateDate}`) || [];
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
      const [y, m, d] = candidateDate.split('-').map(Number);
      const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const isoWeekday = dayOfWeek === 0 ? 7 : dayOfWeek;

      const weekly = hoursByStaffDay.get(`${staffId}:${isoWeekday}`) || [];
      const activeWeekly = weekly.filter(h => {
        if (h.effective_from && h.effective_from > candidateDate) return false;
        if (h.effective_to && h.effective_to < candidateDate) return false;
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
    const itemStartMs = new Date(item.startAt).getTime();
    const itemEndMs = new Date(item.endAt).getTime();
    const assignments = assignmentsByStaff.get(staffId) || [];
    for (const a of assignments) {
      if (a.startMs < itemEndMs && a.endMs > itemStartMs) {
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
          if (cStartMs < itemEndMs && cEndMs > itemStartMs) {
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
  earlyExitPerDate = false
}) => {
  const dates = getCalendarDatesRange(startDate, endDate);
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
      const emptyResult = new Map();
      for (const d of dates) emptyResult.set(d, []);
      return emptyResult;
    }
  }

  const isCustomValidator = validator && defaultValidator && validator !== defaultValidator;

  if (isCustomValidator) {
    // Custom mock validator provided by tests (fallback loop using the mock validator)
    const result = new Map();
    for (const date of dates) {
      const instantResult = await client.query(
        `SELECT candidate.time,
           TO_CHAR((($1::DATE+candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at
         FROM locations location CROSS JOIN UNNEST($2::TEXT[]) WITH ORDINALITY candidate(time,position)
         WHERE location.shop_id=$3 AND location.id=$4 AND location.is_active=TRUE ORDER BY candidate.position`,
        [date, bookingTimes, context.scope.shop_id, context.scope.location_id]
      );
      const available = [];
      for (const candidate of instantResult.rows) {
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
      result.set(date, available);
    }
    return result;
  }

  // 2. Authoritative Batch queries for the entire date range
  const allStaffIds = [...new Set(
    Array.from(candidatesByService.values()).flatMap(list => list.map(c => c.staff_id))
  )];

  // 2a. Slot instants query across all dates
  const slotInstantsResult = await client.query(
    `SELECT
       d.date,
       candidate.time,
       TO_CHAR(((d.date::DATE + candidate.time::TIME) AT TIME ZONE location.timezone) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at
     FROM locations location
     CROSS JOIN UNNEST($1::TEXT[]) WITH ORDINALITY d(date, d_pos)
     CROSS JOIN UNNEST($2::TEXT[]) WITH ORDINALITY candidate(time, position)
     WHERE location.shop_id = $3 AND location.id = $4 AND location.is_active = TRUE
     ORDER BY d.d_pos, candidate.position`,
    [dates, bookingTimes, context.scope.shop_id, context.scope.location_id]
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
    [context.scope.shop_id, context.scope.location_id, allStaffIds, startDate, endDate]
  );

  // 2d. Blocking assignments in date range
  const totalCartMinutes = context.services.reduce((s, item) => s + Number(item.duration_minutes || item.durationMinutes), 0);
  const earliestSlotStart = slotInstantsResult.rows[0]?.start_at || `${startDate}T00:00:00.000Z`;
  const latestSlotStart = slotInstantsResult.rows[slotInstantsResult.rows.length - 1]?.start_at || `${endDate}T23:59:59.000Z`;
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
    blockingAssignments: blockingAssignmentsResult.rows
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

  const resultByDate = new Map();

  for (const date of dates) {
    const slots = slotsByDate.get(date) || [];
    const available = [];

    const candidatesMapForDate = new Map();
    for (const serviceId of uniqueServiceIds) {
      candidatesMapForDate.set(serviceId, getCandidatesForDate(serviceId, date));
    }

    for (const candidate of slots) {
      const timeline = buildSequentialTimeline(context.services, candidate.start_at);
      let elapsedMinutes = 0;
      const itemPrecedingMinutes = new Map();
      for (const item of timeline) {
        itemPrecedingMinutes.set(item, elapsedMinutes);
        elapsedMinutes += Number(item.duration_minutes || item.durationMinutes);
      }

      const plan = await planStaffAssignments({
        items: timeline,
        candidatesByService: candidatesMapForDate,
        validate: async (item, staffId, chosen) => {
          const precMin = itemPrecedingMinutes.get(item) || 0;
          batchValidator(item, staffId, date, candidate.time, precMin, chosen);
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
  createBatchValidator,
  computeBatchAvailability
};
