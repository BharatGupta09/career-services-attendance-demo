-- 005_devices_codes_audit.sql
-- Device identification, admin attendance codes and an append-only audit trail.
--
-- Additive only: new tables, new nullable columns and new indexes. No existing
-- row is changed, so attendance recorded before this migration keeps working
-- and simply has no device / verification information ("Not recorded").

-- ---------------------------------------------------------------------------
-- devices
-- One row per browser/device, identified by a random application-issued key
-- ("DEV-" + 12 hex) kept in an HttpOnly cookie. No hardware identifiers and no
-- cross-site fingerprinting: the metadata is what the browser reports, and the
-- row holds the latest values seen (history lives in audit_log.metadata).
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_key      text        NOT NULL CHECK (device_key ~ '^DEV-[0-9A-F]{12}$'),
  browser         text        CHECK (length(browser) <= 40),
  browser_version text        CHECK (length(browser_version) <= 20),
  os              text        CHECK (length(os) <= 40),
  device_type     text        NOT NULL DEFAULT 'unknown' CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'unknown')),
  screen_width    integer     CHECK (screen_width BETWEEN 1 AND 20000),
  screen_height   integer     CHECK (screen_height BETWEEN 1 AND 20000),
  timezone        text        CHECK (length(timezone) <= 64),
  user_agent      text        CHECK (length(user_agent) <= 400),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_device_key_key UNIQUE (device_key)
);

CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which users have used which device (one row per pair, not per use).
CREATE TABLE user_devices (
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id     bigint      NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX user_devices_device_idx ON user_devices (device_id);

-- ---------------------------------------------------------------------------
-- attendance_events: the device used and the admin whose code verified it.
-- Set once when the event is recorded and never updated, so history keeps the
-- device and admin that applied at the time. NULL on pre-005 events.
-- ---------------------------------------------------------------------------
ALTER TABLE attendance_events
  ADD COLUMN device_id   bigint REFERENCES devices (id) ON DELETE RESTRICT,
  ADD COLUMN verified_by uuid   REFERENCES users (id) ON DELETE RESTRICT;

-- Serves: shared-device detection (recent events on one device).
CREATE INDEX attendance_events_device_time_idx ON attendance_events (device_id, event_timestamp)
  WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sessions.attendance_code
-- The current 4-digit code of an ADMIN session. It lives only on the session
-- row, which is deleted on sign-out and purged after expiry, so a code is never
-- stored permanently and stops working the moment its admin session ends.
-- Unique among live rows so a code always identifies exactly one admin session.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN attendance_code text CHECK (attendance_code ~ '^[0-9]{4}$');

CREATE UNIQUE INDEX sessions_attendance_code_key ON sessions (attendance_code)
  WHERE attendance_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- audit_log (append-only)
-- One row per security-relevant attendance event. No passwords, session
-- tokens or attendance codes are ever written here: a successful verification
-- is identified by the verifying admin and the admin session id.
--
-- attendance_event_id and admin_session_ref deliberately have no foreign key:
-- sessions are short-lived, and the audit record must outlive both.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  action              text        NOT NULL CHECK (action IN (
                        'ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT', 'INVALID_ATTENDANCE_CODE',
                        'DEVICE_SHARING_DETECTED', 'NEW_DEVICE')),
  result              text        NOT NULL CHECK (result IN ('SUCCESS', 'FAILED', 'FLAGGED', 'INFO')),
  actor_user_id       uuid        REFERENCES users (id) ON DELETE RESTRICT,   -- the student
  related_user_id     uuid        REFERENCES users (id) ON DELETE RESTRICT,   -- other student (device sharing)
  verified_by         uuid        REFERENCES users (id) ON DELETE RESTRICT,   -- admin whose code was used
  attendance_event_id bigint,
  admin_session_ref   uuid,
  device_id           bigint      REFERENCES devices (id) ON DELETE RESTRICT,
  ip_address          text        CHECK (length(ip_address) <= 64),
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_created_idx       ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor_created_idx ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_log_action_created_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_log_device_created_idx ON audit_log (device_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
