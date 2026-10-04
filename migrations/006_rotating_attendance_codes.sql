-- 006_rotating_attendance_codes.sql
-- Admin attendance codes rotate every 30 minutes.
--
-- Additive only: two new nullable columns on sessions/audit_log and two CHECK
-- constraints. No existing row is changed, nothing is dropped or deleted.

-- ---------------------------------------------------------------------------
-- sessions.attendance_code_issued_at
-- When the session's current code was generated. The code is valid for 30
-- minutes from this moment (and never beyond the session itself); the Worker
-- then replaces it with a new random code in the same row. The previous code is
-- overwritten, not kept, so unused codes never accumulate anywhere.
--
-- NULL on rows created before this migration: those codes are treated as
-- expired, and a fresh code is issued the next time the admin's dashboard asks.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN attendance_code_issued_at timestamptz;

-- ---------------------------------------------------------------------------
-- audit_log.verified_code / audit_log.code_issued_at
-- Written only when a student successfully uses a code: the code that verified
-- that LOGIN or LOGOUT and the start of its 30-minute window. Codes that are
-- generated but never used leave no trace here. The CHECK constraints make the
-- database itself refuse a code on any other kind of row, so an incorrect code a
-- student typed can never be stored.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log
  ADD COLUMN verified_code  text,
  ADD COLUMN code_issued_at timestamptz;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_verified_code_check CHECK (
    verified_code IS NULL
    OR (verified_code ~ '^[0-9]{4}$'
        AND result = 'SUCCESS'
        AND action IN ('ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT'))),
  ADD CONSTRAINT audit_log_code_issued_at_check CHECK (
    (verified_code IS NULL) = (code_issued_at IS NULL));
