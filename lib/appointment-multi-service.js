'use strict';

class AppointmentMutationError extends Error {
  constructor(code, status, publicMessage) {
    super(code);
    this.name = 'AppointmentMutationError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const runInTransaction = async (pool, operation) => {
  let client;
  let transactionActive = false;
  let transactionCommitted = false;
  let discardClient = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionActive = true;

    const result = await operation(client);

    await client.query('COMMIT');
    transactionActive = false;
    transactionCommitted = true;

    return result;
  } catch (error) {
    if (
      client &&
      transactionActive &&
      !transactionCommitted
    ) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        discardClient = true;
        error.rollbackFailed = true;
      }

      transactionActive = false;
    }

    throw error;
  } finally {
    if (client) {
      client.release(discardClient || undefined);
    }
  }
};

const createSingleServiceCompatibilityRows = async (
  client,
  { appointment, service }
) => {
  const itemResult = await client.query(
    `
    INSERT INTO appointment_items (
      shop_id,
      location_id,
      appointment_id,
      service_id,
      sequence_no,
      service_name_snapshot,
      duration_minutes_snapshot,
      price_snapshot,
      snapshot_source,
      start_at,
      end_at,
      status
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      1,
      $5,
      $6,
      NULL,
      'booking',
      $7,
      $8,
      $9
    )
    RETURNING id
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      appointment.id,
      appointment.service_id,
      service.name,
      service.duration_minutes,
      appointment.start_at,
      appointment.end_at,
      appointment.status
    ]
  );

  if (itemResult.rows.length !== 1) {
    throw new AppointmentMutationError(
      'appointment_item_insert_mismatch',
      500,
      '预约创建失败'
    );
  }

  const itemId = itemResult.rows[0].id;

  const assignmentResult = await client.query(
    `
    INSERT INTO appointment_item_staff_assignments (
      shop_id,
      location_id,
      appointment_item_id,
      staff_id,
      role,
      start_at,
      end_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      'primary',
      $5,
      $6
    )
    RETURNING id
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      itemId,
      appointment.staff_id,
      appointment.start_at,
      appointment.end_at
    ]
  );

  if (assignmentResult.rows.length !== 1) {
    throw new AppointmentMutationError(
      'appointment_assignment_insert_mismatch',
      500,
      '预约创建失败'
    );
  }

  return {
    itemId,
    assignmentId: assignmentResult.rows[0].id
  };
};

const loadAndValidatePhaseAStructure = async (
  client,
  appointment
) => {
  const lockedItems = await client.query(
    `
    SELECT id
    FROM appointment_items
    WHERE shop_id = $1
      AND location_id = $2
      AND appointment_id = $3
    ORDER BY sequence_no ASC, id ASC
    FOR UPDATE
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      appointment.id
    ]
  );

  if (lockedItems.rows.length === 0) {
    throw new AppointmentMutationError(
      'phase_a_items_missing',
      409,
      '预约项目结构暂不可修改'
    );
  }

  await client.query(
    `
    SELECT assignment.id
    FROM appointment_item_staff_assignments assignment
    JOIN appointment_items item
      ON item.shop_id = assignment.shop_id
     AND item.location_id = assignment.location_id
     AND item.id = assignment.appointment_item_id
    WHERE item.shop_id = $1
      AND item.location_id = $2
      AND item.appointment_id = $3
    ORDER BY item.sequence_no ASC, assignment.id ASC
    FOR UPDATE OF assignment
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      appointment.id
    ]
  );

  const validationResult = await client.query(
    `
    WITH parent AS (
      SELECT
        id,
        shop_id,
        location_id,
        service_id,
        staff_id,
        start_at,
        end_at,
        status
      FROM appointments
      WHERE id = $3
        AND shop_id = $1
        AND location_id = $2
      FOR UPDATE
    ),
    ordered_items AS (
      SELECT
        item.id,
        item.shop_id,
        item.location_id,
        item.appointment_id,
        item.service_id,
        item.sequence_no,
        item.start_at,
        item.end_at,
        item.status,
        ROW_NUMBER() OVER (
          ORDER BY item.sequence_no, item.id
        ) AS expected_sequence,
        COUNT(*) OVER () AS item_count,
        LAG(item.end_at) OVER (
          ORDER BY item.sequence_no, item.id
        ) AS previous_end_at
      FROM appointment_items item
      WHERE item.shop_id = $1
        AND item.location_id = $2
        AND item.appointment_id = $3
    ),
    item_validation AS (
      SELECT
        COUNT(*)::INTEGER AS item_count,
        COALESCE(
          BOOL_AND(
            item.sequence_no = item.expected_sequence
            AND item.end_at > item.start_at
            AND item.status = parent.status
            AND (
              item.expected_sequence <> 1
              OR (
                item.service_id = parent.service_id
                AND item.start_at IS NOT DISTINCT FROM
                  parent.start_at
              )
            )
            AND (
              item.expected_sequence = 1
              OR item.start_at IS NOT DISTINCT FROM
                item.previous_end_at
            )
            AND (
              item.expected_sequence <> item.item_count
              OR item.end_at IS NOT DISTINCT FROM
                parent.end_at
            )
          ),
          FALSE
        ) AS items_valid
      FROM ordered_items item
      CROSS JOIN parent
    ),
    assignment_per_item AS (
      SELECT
        item.id AS item_id,
        COUNT(assignment.id)::INTEGER AS assignment_count,
        COUNT(*) FILTER (
          WHERE assignment.role = 'primary'
        )::INTEGER AS primary_count,
        COUNT(*) FILTER (
          WHERE assignment.role = 'assistant'
        )::INTEGER AS assistant_count,
        COALESCE(
          BOOL_AND(
            assignment.id IS NOT NULL
            AND assignment.shop_id = parent.shop_id
            AND assignment.location_id = parent.location_id
            AND assignment.staff_id = parent.staff_id
            AND assignment.role = 'primary'
            AND assignment.start_at IS NOT DISTINCT FROM
              item.start_at
            AND assignment.end_at IS NOT DISTINCT FROM
              item.end_at
          ),
          FALSE
        ) AS assignment_rows_valid
      FROM ordered_items item
      CROSS JOIN parent
      LEFT JOIN appointment_item_staff_assignments assignment
        ON assignment.appointment_item_id = item.id
      GROUP BY item.id
    ),
    assignment_validation AS (
      SELECT
        COALESCE(
          SUM(assignment_count),
          0
        )::INTEGER AS assignment_count,
        COALESCE(
          BOOL_AND(
            assignment_count = 1
            AND primary_count = 1
            AND assistant_count = 0
            AND assignment_rows_valid
          ),
          FALSE
        ) AS assignments_valid
      FROM assignment_per_item
    )
    SELECT
      item_validation.item_count,
      assignment_validation.assignment_count,
      (
        item_validation.item_count > 0
        AND item_validation.items_valid
        AND assignment_validation.assignments_valid
      ) AS structure_valid
    FROM item_validation
    CROSS JOIN assignment_validation
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      appointment.id
    ]
  );

  const validation = validationResult.rows[0];

  if (
    validationResult.rows.length !== 1 ||
    !validation ||
    validation.structure_valid !== true
  ) {
    throw new AppointmentMutationError(
      'phase_a_structure_invalid',
      409,
      '预约项目结构暂不可修改'
    );
  }

  return {
    itemCount: validation.item_count,
    assignmentCount: validation.assignment_count
  };
};

const moveAppointmentStructurePrecisely = async (
  client,
  {
    appointment,
    newStartAt,
    expectedItemCount,
    expectedAssignmentCount,
    actorStaffId
  }
) => {
  const result = await client.query(
    `
    WITH parent_before AS (
      SELECT
        id,
        shop_id,
        location_id,
        staff_id,
        start_at AS old_start_at,
        end_at AS old_end_at,
        $5::TIMESTAMPTZ - start_at AS exact_delta
      FROM appointments
      WHERE id = $1
        AND shop_id = $2
        AND location_id = $3
        AND staff_id = $4
        AND status IN ('pending', 'confirmed')
        AND override_conflict = FALSE
      FOR UPDATE
    ),
    parent_updated AS (
      UPDATE appointments parent
      SET
        start_at = $5::TIMESTAMPTZ,
        end_at = parent.end_at + before.exact_delta,
        updated_at = NOW()
      FROM parent_before before
      WHERE parent.id = before.id
        AND parent.shop_id = before.shop_id
        AND parent.location_id = before.location_id
        AND parent.staff_id = before.staff_id
      RETURNING
        parent.id,
        parent.shop_id,
        parent.location_id,
        parent.staff_id,
        parent.start_at,
        parent.end_at,
        parent.status,
        before.old_start_at,
        before.old_end_at,
        before.exact_delta
    ),
    items_updated AS (
      UPDATE appointment_items item
      SET
        start_at = item.start_at + parent.exact_delta,
        end_at = item.end_at + parent.exact_delta,
        updated_at = NOW()
      FROM parent_updated parent
      WHERE item.shop_id = parent.shop_id
        AND item.location_id = parent.location_id
        AND item.appointment_id = parent.id
      RETURNING item.id
    ),
    assignments_updated AS (
      UPDATE appointment_item_staff_assignments assignment
      SET
        start_at = assignment.start_at + parent.exact_delta,
        end_at = assignment.end_at + parent.exact_delta,
        updated_at = NOW()
      FROM appointment_items item,
        parent_updated parent
      WHERE item.shop_id = assignment.shop_id
        AND item.location_id = assignment.location_id
        AND item.id = assignment.appointment_item_id
        AND item.shop_id = parent.shop_id
        AND item.location_id = parent.location_id
        AND item.appointment_id = parent.id
      RETURNING assignment.id
    ),
    affected_counts AS (
      SELECT
        (SELECT COUNT(*) FROM items_updated) AS item_count,
        (
          SELECT COUNT(*)
          FROM assignments_updated
        ) AS assignment_count
    ),
    audit_insert AS (
      INSERT INTO appointment_time_change_history (
        shop_id,
        location_id,
        appointment_id,
        staff_id,
        actor_type,
        actor_id,
        old_start_at,
        old_end_at,
        new_start_at,
        new_end_at,
        reason,
        source
      )
      SELECT
        parent.shop_id,
        parent.location_id,
        parent.id,
        parent.staff_id,
        'staff',
        $8::UUID,
        parent.old_start_at,
        parent.old_end_at,
        parent.start_at,
        parent.end_at,
        NULL,
        'staff_time_picker'
      FROM parent_updated parent
      CROSS JOIN affected_counts counts
      WHERE counts.item_count = $6::INTEGER
        AND counts.assignment_count = $7::INTEGER
      RETURNING appointment_id
    )
    SELECT
      parent.id,
      parent.start_at,
      parent.end_at,
      parent.status
    FROM parent_updated parent
    JOIN audit_insert audit
      ON audit.appointment_id = parent.id
    `,
    [
      appointment.id,
      appointment.shop_id,
      appointment.location_id,
      appointment.staff_id,
      newStartAt,
      expectedItemCount,
      expectedAssignmentCount,
      actorStaffId
    ]
  );

  if (result.rows.length !== 1) {
    throw new AppointmentMutationError(
      'appointment_structure_move_mismatch',
      500,
      '修改预约时间失败'
    );
  }

  return result.rows[0];
};

const syncAppointmentItemStatus = async (
  client,
  { appointment, status, expectedItemCount }
) => {
  const result = await client.query(
    `
    UPDATE appointment_items
    SET
      status = $4,
      updated_at = NOW()
    WHERE shop_id = $1
      AND location_id = $2
      AND appointment_id = $3
    RETURNING id
    `,
    [
      appointment.shop_id,
      appointment.location_id,
      appointment.id,
      status
    ]
  );

  if (result.rows.length !== expectedItemCount) {
    throw new AppointmentMutationError(
      'status_item_count_mismatch',
      500,
      '更新预约状态失败'
    );
  }
};

module.exports = {
  AppointmentMutationError,
  runInTransaction,
  createSingleServiceCompatibilityRows,
  loadAndValidatePhaseAStructure,
  moveAppointmentStructurePrecisely,
  syncAppointmentItemStatus
};
