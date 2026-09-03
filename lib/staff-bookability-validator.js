'use strict';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

class StaffBookabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StaffBookabilityError';
    this.code = code;
  }
}

const fail = code => {
  throw new StaffBookabilityError(code);
};

const VALIDATION_SQL = `
  WITH input AS (
    SELECT
      $1::UUID AS shop_id,
      $2::UUID AS location_id,
      $3::UUID AS staff_id,
      $4::UUID AS service_id,
      $5::TIMESTAMPTZ AS requested_start_at,
      $6::TIMESTAMPTZ AS requested_end_at
  ),
  identity_scope AS (
    SELECT
      input.*,
      location.id IS NOT NULL AS location_matches_tenant,
      location.is_active IS TRUE AS location_active,
      timezone.name AS location_timezone,
      timezone.name IS NOT NULL AS location_timezone_valid,
      staff_member.id IS NOT NULL AS staff_matches_tenant,
      staff_member.is_active IS TRUE AS staff_active,
      staff_member.bookable IS TRUE AS staff_bookable,
      service.id IS NOT NULL AS service_matches_tenant,
      service.is_active IS TRUE AS service_active,
      service.bookable IS TRUE AS service_bookable,
      service.name AS service_name,
      service.duration_minutes,
      capability.id IS NOT NULL AS capability_active,
      assignment.id AS location_assignment_id
    FROM input
    LEFT JOIN locations AS location
      ON location.id = input.location_id
     AND location.shop_id = input.shop_id
    LEFT JOIN pg_catalog.pg_timezone_names AS timezone
      ON timezone.name = location.timezone
    LEFT JOIN staff AS staff_member
      ON staff_member.id = input.staff_id
     AND staff_member.shop_id = input.shop_id
    LEFT JOIN services AS service
      ON service.id = input.service_id
     AND service.shop_id = input.shop_id
    LEFT JOIN staff_services AS capability
      ON capability.shop_id = input.shop_id
     AND capability.staff_id = input.staff_id
     AND capability.service_id = input.service_id
     AND capability.is_active = TRUE
    LEFT JOIN staff_location_assignments AS assignment
      ON assignment.shop_id = input.shop_id
     AND assignment.location_id = input.location_id
     AND assignment.staff_id = input.staff_id
     AND assignment.is_active = TRUE
  ),
  local_context AS (
    SELECT
      scope.*,
      scope.requested_start_at AT TIME ZONE scope.location_timezone
        AS local_start,
      scope.requested_end_at AT TIME ZONE scope.location_timezone
        AS local_end,
      (scope.requested_start_at AT TIME ZONE scope.location_timezone)::DATE
        AS local_date,
      EXTRACT(
        ISODOW FROM
        scope.requested_start_at AT TIME ZONE scope.location_timezone
      )::INTEGER AS iso_weekday
    FROM identity_scope AS scope
  ),
  weekly AS (
    SELECT hours.*
    FROM local_context AS context
    JOIN staff_location_working_hours AS hours
      ON hours.shop_id = context.shop_id
     AND hours.location_id = context.location_id
     AND hours.staff_id = context.staff_id
     AND hours.day_of_week = context.iso_weekday
     AND hours.is_active = TRUE
     AND (
       hours.effective_from IS NULL
       OR hours.effective_from <= context.local_date
     )
     AND (
       hours.effective_to IS NULL
       OR hours.effective_to >= context.local_date
     )
  ),
  weekly_state AS (
    SELECT
      COUNT(*) AS range_count,
      EXISTS (
        SELECT 1
        FROM weekly AS left_range
        JOIN weekly AS right_range
          ON left_range.id < right_range.id
         AND left_range.start_time < right_range.end_time
         AND right_range.start_time < left_range.end_time
      ) AS ranges_overlap,
      EXISTS (
        SELECT 1
        FROM weekly AS hours
        CROSS JOIN local_context AS context
        WHERE context.local_start::TIME >= hours.start_time
          AND context.local_end::TIME <= hours.end_time
      ) AS interval_contained
  ),
  controlling_overrides AS (
    SELECT override.*
    FROM local_context AS context
    JOIN staff_schedule_overrides AS override
      ON override.shop_id = context.shop_id
     AND override.location_id = context.location_id
     AND override.staff_id = context.staff_id
     AND override.schedule_date = context.local_date
     AND override.is_active = TRUE
     AND override.approval_status IN ('pending', 'approved')
  ),
  override_state AS (
    SELECT
      COUNT(*) AS controlling_count,
      COUNT(*) FILTER (
        WHERE approval_status = 'pending'
      ) AS pending_count,
      COUNT(*) FILTER (
        WHERE approval_status = 'approved'
      ) AS approved_count,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type = 'day_off'
      ) AS is_day_off,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type = 'leave'
        AND start_time IS NULL
        AND end_time IS NULL
      ) AS is_full_day_leave,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type = 'leave'
        AND start_time IS NOT NULL
        AND end_time IS NOT NULL
      ) AS has_partial_leave,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type IN ('custom_hours', 'working')
      ) AS has_custom_hours,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type = 'working'
      ) AS uses_working_alias,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type = 'leave'
        AND start_time IS NOT NULL
        AND end_time IS NOT NULL
        AND context.local_start::TIME < end_time
        AND context.local_end::TIME > start_time
      ) AS partial_leave_overlaps,
      BOOL_OR(
        approval_status = 'approved'
        AND override_type IN ('custom_hours', 'working')
        AND context.local_start::TIME >= start_time
        AND context.local_end::TIME <= end_time
      ) AS custom_interval_contained,
      MIN(start_time) FILTER (
        WHERE approval_status = 'approved'
          AND override_type IN ('custom_hours', 'working')
      ) AS custom_start_time,
      MAX(end_time) FILTER (
        WHERE approval_status = 'approved'
          AND override_type IN ('custom_hours', 'working')
      ) AS custom_end_time
    FROM controlling_overrides AS override
    CROSS JOIN local_context AS context
  ),
  collision_state AS (
    SELECT EXISTS (
      SELECT 1
      FROM appointments AS appointment
      CROSS JOIN local_context AS context
      WHERE appointment.shop_id = context.shop_id
        AND appointment.location_id = context.location_id
        AND appointment.staff_id = context.staff_id
        AND appointment.status IN ('pending', 'confirmed')
        AND appointment.override_conflict = FALSE
        AND appointment.start_at < context.requested_end_at
        AND appointment.end_at > context.requested_start_at
    ) AS has_collision
  )
  SELECT
    context.location_matches_tenant,
    context.location_active,
    context.location_timezone,
    context.location_timezone_valid,
    context.staff_matches_tenant,
    context.staff_active,
    context.staff_bookable,
    context.service_matches_tenant,
    context.service_active,
    context.service_bookable,
    context.service_name,
    context.duration_minutes,
    context.capability_active,
    context.location_assignment_id,
    context.requested_end_at > context.requested_start_at
      AND context.local_start::DATE = context.local_end::DATE
      AS interval_valid,
    context.requested_end_at = context.requested_start_at
      + context.duration_minutes * INTERVAL '1 minute'
      AS duration_matches,
    weekly_state.range_count AS weekly_range_count,
    weekly_state.ranges_overlap AS weekly_ranges_overlap,
    weekly_state.interval_contained AS weekly_interval_contained,
    override_state.controlling_count AS override_count,
    override_state.pending_count AS pending_override_count,
    override_state.approved_count AS approved_override_count,
    COALESCE(override_state.is_day_off, FALSE) AS is_day_off,
    COALESCE(override_state.is_full_day_leave, FALSE)
      AS is_full_day_leave,
    COALESCE(override_state.has_partial_leave, FALSE)
      AS has_partial_leave,
    COALESCE(override_state.partial_leave_overlaps, FALSE)
      AS partial_leave_overlaps,
    COALESCE(override_state.has_custom_hours, FALSE)
      AS has_custom_hours,
    COALESCE(override_state.uses_working_alias, FALSE)
      AS uses_working_alias,
    COALESCE(override_state.custom_interval_contained, FALSE)
      AS custom_interval_contained,
    collision_state.has_collision,
    CASE
      WHEN COALESCE(override_state.has_custom_hours, FALSE)
      THEN 'override'
      WHEN COALESCE(override_state.has_partial_leave, FALSE)
      THEN 'weekly_with_leave'
      ELSE 'weekly'
    END AS schedule_source,
    CASE
      WHEN COALESCE(override_state.has_custom_hours, FALSE)
      THEN JSON_BUILD_OBJECT(
        'startAt',
        (context.local_date + override_state.custom_start_time)
          AT TIME ZONE context.location_timezone,
        'endAt',
        (context.local_date + override_state.custom_end_time)
          AT TIME ZONE context.location_timezone
      )
      ELSE (
        SELECT JSON_BUILD_OBJECT(
          'startAt',
          (context.local_date + hours.start_time)
            AT TIME ZONE context.location_timezone,
          'endAt',
          (context.local_date + hours.end_time)
            AT TIME ZONE context.location_timezone
        )
        FROM weekly AS hours
        WHERE context.local_start::TIME >= hours.start_time
          AND context.local_end::TIME <= hours.end_time
        ORDER BY hours.start_time, hours.end_time, hours.id
        LIMIT 1
      )
    END AS effective_work_window
  FROM local_context AS context
  CROSS JOIN weekly_state
  CROSS JOIN override_state
  CROSS JOIN collision_state
`;

const assertInput = input => {
  if (!input || typeof input !== 'object') {
    fail('BOOKABILITY_INPUT_INVALID');
  }

  if (!input.dbClient || typeof input.dbClient.query !== 'function') {
    fail('BOOKABILITY_INPUT_INVALID');
  }

  for (const value of [
    input.shopId,
    input.locationId,
    input.staffId,
    input.serviceId
  ]) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      fail('BOOKABILITY_INPUT_INVALID');
    }
  }

  for (const value of [
    input.requestedStartAt,
    input.requestedEndAt
  ]) {
    if (
      typeof value !== 'string' ||
      !OFFSET_TIMESTAMP_PATTERN.test(value)
    ) {
      fail('BOOKABILITY_INPUT_INVALID');
    }
  }
};

const interpretValidationRow = (row, input) => {
  if (
    !row ||
    row.location_matches_tenant !== true ||
    row.location_active !== true ||
    row.location_timezone_valid !== true ||
    row.staff_matches_tenant !== true ||
    row.service_matches_tenant !== true
  ) {
    fail('BOOKABILITY_SCOPE_INVALID');
  }

  if (row.staff_active !== true || row.staff_bookable !== true) {
    fail('STAFF_NOT_BOOKABLE');
  }

  if (row.service_active !== true || row.service_bookable !== true) {
    fail('SERVICE_NOT_BOOKABLE');
  }

  if (
    !Number.isInteger(row.duration_minutes) ||
    row.duration_minutes <= 0
  ) {
    fail('SCHEDULE_CONFIGURATION_INVALID');
  }

  if (row.capability_active !== true) {
    fail('STAFF_SERVICE_NOT_ALLOWED');
  }

  if (!row.location_assignment_id) {
    fail('STAFF_LOCATION_NOT_ASSIGNED');
  }

  if (row.interval_valid !== true || row.duration_matches !== true) {
    fail('BOOKABILITY_INTERVAL_INVALID');
  }

  if (Number(row.override_count) > 1) {
    fail('SCHEDULE_CONFIGURATION_INVALID');
  }

  if (Number(row.pending_override_count) > 0) {
    fail('SCHEDULE_OVERRIDE_PENDING');
  }

  if (row.weekly_ranges_overlap === true) {
    fail('SCHEDULE_CONFIGURATION_INVALID');
  }

  if (row.is_day_off === true || row.is_full_day_leave === true) {
    fail('STAFF_ON_LEAVE');
  }

  if (row.has_custom_hours === true) {
    if (row.custom_interval_contained !== true) {
      fail('OUTSIDE_WORKING_HOURS');
    }
  } else {
    if (Number(row.weekly_range_count) === 0) {
      fail('NO_WORKING_HOURS');
    }

    if (row.weekly_interval_contained !== true) {
      fail('OUTSIDE_WORKING_HOURS');
    }

    if (
      row.has_partial_leave === true &&
      row.partial_leave_overlaps === true
    ) {
      fail('STAFF_ON_LEAVE');
    }
  }

  if (row.has_collision === true) {
    fail('APPOINTMENT_COLLISION');
  }

  return {
    shopId: input.shopId,
    locationId: input.locationId,
    locationTimezone: row.location_timezone,
    staffId: input.staffId,
    serviceId: input.serviceId,
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    locationAssignmentId: row.location_assignment_id,
    scheduleSource: row.schedule_source,
    effectiveWorkWindow: row.effective_work_window
  };
};

const validateStaffBookability = async input => {
  assertInput(input);

  const result = await input.dbClient.query(
    VALIDATION_SQL,
    [
      input.shopId,
      input.locationId,
      input.staffId,
      input.serviceId,
      input.requestedStartAt,
      input.requestedEndAt
    ]
  );

  if (!result || result.rows.length !== 1) {
    fail('SCHEDULE_CONFIGURATION_INVALID');
  }

  return interpretValidationRow(result.rows[0], input);
};

module.exports = {
  StaffBookabilityError,
  validateStaffBookability
};
