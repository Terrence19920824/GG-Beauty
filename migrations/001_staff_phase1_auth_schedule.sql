-- GG-Beauty Phase 1: staff authentication, permissions, locations, and schedules
--
-- REVIEW ONLY. Do not run against production until the pre-migration audit below
-- has been completed on the target Supabase PostgreSQL database.
--
-- This migration is additive. It does not delete or rebuild appointments,
-- customers, staff, services, locations, or any historical business data.
-- It intentionally contains no DROP TABLE, TRUNCATE, or DELETE statements.
--
-- Default business timezone remains Asia/Singapore. Weekly hours and schedule
-- override times are stored as local wall-clock TIME values; appointment
-- start_at/end_at remain absolute timestamps managed by the existing system.

BEGIN;

-- REQUIRES PRE-MIGRATION AUDIT
-- Confirm the production types and constraints for:
--   shops(id)
--   staff(id, shop_id)
--   locations(id, shop_id)
--   appointments(shop_id, staff_id, start_at)
-- This migration assumes those identifiers are UUID, as used by the current
-- application. Confirm there are no orphaned or cross-shop relationships before
-- validating any new composite foreign keys.

-- A primary-key id is already globally unique, so these additive composite
-- unique indexes do not rewrite business relationships. They allow new tables
-- to use tenant-safe (shop_id, id) composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS staff_shop_id_id_uidx
  ON staff (shop_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS locations_shop_id_id_uidx
  ON locations (shop_id, id);


-- ==================================================
-- Staff accounts
-- Authentication credentials are kept separate from the historical staff row.
-- password_hash must contain an Argon2id/bcrypt (or equivalent) password hash;
-- plaintext or reversibly encrypted passwords must never be stored here.
-- Future staff authentication must require both staff.can_login = TRUE and
-- staff_accounts.status = 'active'. An active account must never bypass the
-- existing staff.can_login business-level login switch. Do not modify or remove
-- staff.can_login as part of this migration.
-- ==================================================

CREATE TABLE staff_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  login_identifier TEXT NOT NULL,
  login_identifier_normalized TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_accounts_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_accounts_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_accounts_status_check
    CHECK (status IN ('active', 'disabled', 'locked')),

  CONSTRAINT staff_accounts_session_version_check
    CHECK (session_version >= 1),

  CONSTRAINT staff_accounts_failed_login_attempts_check
    CHECK (failed_login_attempts >= 0),

  CONSTRAINT staff_accounts_login_identifier_check
    CHECK (
      BTRIM(login_identifier) <> ''
      AND BTRIM(login_identifier_normalized) <> ''
    ),

  CONSTRAINT staff_accounts_password_hash_check
    CHECK (CHAR_LENGTH(password_hash) >= 40),

  CONSTRAINT staff_accounts_shop_staff_key
    UNIQUE (shop_id, staff_id),

  CONSTRAINT staff_accounts_shop_login_key
    UNIQUE (shop_id, login_identifier_normalized),

  CONSTRAINT staff_accounts_shop_account_key
    UNIQUE (shop_id, id),

  -- Supports tenant-safe session foreign keys that also bind the account to
  -- the same staff member rather than merely to any account in the same shop.
  CONSTRAINT staff_accounts_shop_account_staff_key
    UNIQUE (shop_id, id, staff_id)
);

CREATE INDEX staff_accounts_login_lookup_idx
  ON staff_accounts (
    shop_id,
    login_identifier_normalized,
    status
  );

CREATE INDEX staff_accounts_status_idx
  ON staff_accounts (shop_id, status);


-- ==================================================
-- Staff-to-location assignments
-- A staff member may work at multiple locations owned by the same shop.
-- ==================================================

CREATE TABLE staff_location_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  location_id UUID NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_location_assignments_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_assignments_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_assignments_shop_location_fkey
    FOREIGN KEY (shop_id, location_id)
    REFERENCES locations (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_assignments_shop_staff_location_key
    UNIQUE (shop_id, staff_id, location_id)
);

CREATE INDEX staff_location_assignments_staff_idx
  ON staff_location_assignments (shop_id, staff_id, is_active);

CREATE INDEX staff_location_assignments_location_idx
  ON staff_location_assignments (shop_id, location_id, is_active);

-- A staff member can have only one active primary location per shop.
CREATE UNIQUE INDEX staff_location_assignments_primary_uidx
  ON staff_location_assignments (shop_id, staff_id)
  WHERE is_active = TRUE AND is_primary = TRUE;


-- ==================================================
-- Staff sessions
-- The application stores only a one-way hash of the random session token.
-- Account disable/password reset increments staff_accounts.session_version and
-- revokes outstanding rows so old sessions can no longer authorize requests.
-- ==================================================

CREATE TABLE staff_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  staff_account_id UUID NOT NULL,
  shop_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  location_id UUID NOT NULL,
  session_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,

  CONSTRAINT staff_sessions_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT staff_sessions_token_hash_check
    CHECK (CHAR_LENGTH(token_hash) = 64),

  CONSTRAINT staff_sessions_expiry_check
    CHECK (expires_at > created_at),

  CONSTRAINT staff_sessions_session_version_check
    CHECK (session_version >= 1),

  CONSTRAINT staff_sessions_shop_account_staff_fkey
    FOREIGN KEY (shop_id, staff_account_id, staff_id)
    REFERENCES staff_accounts (shop_id, id, staff_id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_sessions_shop_staff_location_fkey
    FOREIGN KEY (shop_id, staff_id, location_id)
    REFERENCES staff_location_assignments (
      shop_id,
      staff_id,
      location_id
    )
    ON DELETE RESTRICT
);

CREATE INDEX staff_sessions_account_active_idx
  ON staff_sessions (shop_id, staff_account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX staff_sessions_expiry_idx
  ON staff_sessions (expires_at)
  WHERE revoked_at IS NULL;


-- ==================================================
-- Staff permissions
-- All optional permissions use least-privilege defaults. In particular, full
-- customer phone access is denied unless an authorized admin explicitly grants
-- it. Employees must never be allowed to update this row themselves.
-- ==================================================

CREATE TABLE staff_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  staff_account_id UUID NOT NULL,
  can_view_customer_history BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_service_notes BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_own_sales BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_own_commission BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_full_customer_phone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_admin_id UUID,

  CONSTRAINT staff_permissions_shop_account_fkey
    FOREIGN KEY (shop_id, staff_account_id)
    REFERENCES staff_accounts (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_permissions_shop_account_key
    UNIQUE (shop_id, staff_account_id)
);

-- REQUIRES PRE-MIGRATION AUDIT
-- updated_by_admin_id intentionally has no foreign key in this migration because
-- the current repository has no tenant-aware admin_accounts schema. Add a
-- composite (shop_id, updated_by_admin_id) foreign key only after that schema is
-- introduced and existing admin ownership is verified.


-- ==================================================
-- Legacy weekly recurring staff hours
-- The existing production staff_working_hours table is intentionally left
-- completely unchanged for historical compatibility. It remains the legacy
-- single-location schedule structure and is not altered, rebuilt, renamed, or
-- indexed by this migration.
-- ==================================================

-- ==================================================
-- Location-aware weekly recurring staff hours
-- This new table supports multiple locations, split shifts on the same day, and
-- different effective-date periods without changing the legacy table. Approved
-- active date-specific overrides below take precedence in application logic.
-- ==================================================

CREATE TABLE staff_location_working_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TIME WITHOUT TIME ZONE NOT NULL,
  end_time TIME WITHOUT TIME ZONE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_location_working_hours_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_working_hours_shop_staff_fkey
    FOREIGN KEY (shop_id, staff_id)
    REFERENCES staff (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_working_hours_shop_location_fkey
    FOREIGN KEY (shop_id, location_id)
    REFERENCES locations (shop_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_working_hours_assignment_fkey
    FOREIGN KEY (shop_id, staff_id, location_id)
    REFERENCES staff_location_assignments (
      shop_id,
      staff_id,
      location_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT staff_location_working_hours_day_of_week_check
    CHECK (day_of_week BETWEEN 1 AND 7),

  CONSTRAINT staff_location_working_hours_time_check
    CHECK (start_time < end_time),

  CONSTRAINT staff_location_working_hours_effective_dates_check
    CHECK (
      effective_to IS NULL
      OR effective_from IS NULL
      OR effective_to >= effective_from
    )
);

-- Prevent exact duplicate active periods while still allowing split shifts,
-- different locations, and different effective-date ranges. NULL effective
-- bounds are normalized only for duplicate detection.
CREATE UNIQUE INDEX staff_location_working_hours_active_period_uidx
  ON staff_location_working_hours (
    shop_id,
    location_id,
    staff_id,
    day_of_week,
    start_time,
    end_time,
    COALESCE(effective_from, '-infinity'::DATE),
    COALESCE(effective_to, 'infinity'::DATE)
  )
  WHERE is_active = TRUE;

CREATE INDEX staff_location_working_hours_lookup_idx
  ON staff_location_working_hours (
    shop_id,
    location_id,
    staff_id,
    day_of_week,
    is_active,
    effective_from,
    effective_to
  );


-- ==================================================
-- Date-specific schedule overrides and leave
-- Approved active overrides take precedence over weekly recurring hours; weekly
-- hours are then bounded by the location's business hours in application logic.
-- This table never deletes or changes appointments when leave/day_off is added.
-- Existing appointments must be detected and handled by a separate reviewed
-- reassignment/manual-resolution workflow.
-- ==================================================

CREATE TABLE staff_schedule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL,
  location_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  schedule_date DATE NOT NULL,
  override_type TEXT NOT NULL,
  start_time TIME WITHOUT TIME ZONE,
  end_time TIME WITHOUT TIME ZONE,
  reason TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_by_type TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_schedule_overrides_shop_fkey
    FOREIGN KEY (shop_id)
    REFERENCES shops (id)
    ON DELETE RESTRICT,

  CONSTRAINT staff_schedule_overrides_shop_staff_location_fkey
    FOREIGN KEY (shop_id, staff_id, location_id)
    REFERENCES staff_location_assignments (
      shop_id,
      staff_id,
      location_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT staff_schedule_overrides_type_check
    CHECK (
      override_type IN (
        'day_off',
        'leave',
        'custom_hours',
        'working'
      )
    ),

  CONSTRAINT staff_schedule_overrides_approval_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),

  CONSTRAINT staff_schedule_overrides_created_by_type_check
    CHECK (created_by_type IN ('admin', 'staff', 'system')),

  CONSTRAINT staff_schedule_overrides_time_check
    CHECK (
      (
        override_type = 'day_off'
        AND start_time IS NULL
        AND end_time IS NULL
      )
      OR
      (
        override_type = 'leave'
        AND (
          (start_time IS NULL AND end_time IS NULL)
          OR
          (
            start_time IS NOT NULL
            AND end_time IS NOT NULL
            AND start_time < end_time
          )
        )
      )
      OR
      (
        override_type IN ('custom_hours', 'working')
        AND start_time IS NOT NULL
        AND end_time IS NOT NULL
        AND start_time < end_time
      )
    )
);

-- Only one current pending/approved override may control a staff member's date
-- at one location. Replaced/rejected records remain available for audit by
-- setting is_active = FALSE rather than deleting them.
CREATE UNIQUE INDEX staff_schedule_overrides_current_uidx
  ON staff_schedule_overrides (
    shop_id,
    location_id,
    staff_id,
    schedule_date
  )
  WHERE is_active = TRUE
    AND approval_status IN ('pending', 'approved');

CREATE INDEX staff_schedule_overrides_lookup_idx
  ON staff_schedule_overrides (
    shop_id,
    location_id,
    staff_id,
    schedule_date,
    approval_status,
    is_active
  );

CREATE INDEX staff_schedule_overrides_date_idx
  ON staff_schedule_overrides (
    shop_id,
    location_id,
    schedule_date,
    override_type
  )
  WHERE is_active = TRUE AND approval_status = 'approved';


-- ==================================================
-- Existing appointment lookup support
-- Additive only: do not remove or replace existing indexes.
-- ==================================================

CREATE INDEX IF NOT EXISTS appointments_shop_staff_start_idx
  ON appointments (shop_id, staff_id, start_at);

CREATE INDEX IF NOT EXISTS appointments_shop_location_staff_start_idx
  ON appointments (shop_id, location_id, staff_id, start_at);


-- REQUIRES PRE-MIGRATION AUDIT
-- Before this migration is applied:
--   1. Confirm all assumed UUID column types match production.
--   2. Confirm the legacy staff_working_hours table remains untouched.
--   3. Create staff_location_assignments before inserting any rows into the new
--      staff_location_working_hours or staff_schedule_overrides tables.
--   4. Confirm staff.shop_id and locations.shop_id contain no invalid values.
--   5. Confirm gen_random_uuid() is available in the target PostgreSQL version.
--   6. Review index creation strategy for production table size and lock impact.
--   7. Define an explicit, reviewed compatibility/backfill plan before any
--      legacy weekly hours are copied into the location-aware schedule table.
--
-- No employee accounts, password hashes, sessions, permissions, assignments,
-- working hours, or leave rows are inserted by this migration.

COMMIT;
