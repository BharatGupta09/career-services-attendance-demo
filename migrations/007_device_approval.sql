-- 007_device_approval.sql
-- Student sign-in is locked to devices an admin has approved.
--
-- Additive: new nullable columns, constraints and indexes, and a wider list of
-- audit actions. No existing row is changed or deleted. Written so that running
-- it a second time is harmless (IF NOT EXISTS / DROP ... IF EXISTS).
--
-- A "device" is the existing application-issued device key (devices.device_key,
-- kept in an HttpOnly cookie). user_devices already links one student to one
-- device; it now also carries that link's approval state, so a request is
-- exactly "student + device" and there can never be two requests for the same pair:
--
--   status NULL      the student used this device for attendance before device
--                    locking existed (history only; not approved for sign-in)
--   status pending   the student tried to sign in from this device; waiting for an admin
--   status approved  the student may sign in from this device
--   status denied    an admin refused this device; sign-in stays blocked
--
-- The first device a student signs in from is approved automatically
-- (decided_by NULL). Every other approval names the admin in decided_by.

ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS status          text,
  ADD COLUMN IF NOT EXISTS requested_at    timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS decided_at      timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

ALTER TABLE user_devices DROP CONSTRAINT IF EXISTS user_devices_status_check;
ALTER TABLE user_devices ADD CONSTRAINT user_devices_status_check
  CHECK (status IN ('pending', 'approved', 'denied'));

ALTER TABLE user_devices DROP CONSTRAINT IF EXISTS user_devices_attempt_count_check;
ALTER TABLE user_devices ADD CONSTRAINT user_devices_attempt_count_check CHECK (attempt_count >= 0);

-- Each state carries exactly the fields it needs: a pending request has no
-- decision; a denial always names the admin; every request has a time.
ALTER TABLE user_devices DROP CONSTRAINT IF EXISTS user_devices_decision_check;
ALTER TABLE user_devices ADD CONSTRAINT user_devices_decision_check CHECK (
  (status IS NULL       AND requested_at IS NULL     AND decided_by IS NULL     AND decided_at IS NULL)
  OR (status = 'pending'  AND requested_at IS NOT NULL AND decided_by IS NULL     AND decided_at IS NULL)
  OR (status = 'approved' AND requested_at IS NOT NULL                            AND decided_at IS NOT NULL)
  OR (status = 'denied'   AND requested_at IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL));

-- At most ONE device per student can ever be approved without an admin (the
-- first device). Two simultaneous first sign-ins from different devices cannot
-- both succeed: the second insert violates this index and is rolled back.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_one_self_registered
  ON user_devices (user_id) WHERE status = 'approved' AND decided_by IS NULL;

-- Serves: the admin dashboard's list of pending requests.
CREATE INDEX IF NOT EXISTS user_devices_pending_idx
  ON user_devices (requested_at) WHERE status = 'pending';

-- The device a session was signed in from. A student session is only valid
-- while the request comes from that same device and the device is approved.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_id bigint REFERENCES devices (id) ON DELETE CASCADE;

-- New audit actions for the device approval workflow.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
  'ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT', 'INVALID_ATTENDANCE_CODE',
  'DEVICE_SHARING_DETECTED', 'NEW_DEVICE',
  'DEVICE_REGISTERED',     -- first device approved automatically at first sign-in
  'DEVICE_LOGIN_BLOCKED',  -- sign-in refused: device pending or denied
  'DEVICE_APPROVED',       -- an admin approved student + device
  'DEVICE_DENIED',         -- an admin denied student + device
  'SIGN_IN'));             -- a student signed in from an approved device
