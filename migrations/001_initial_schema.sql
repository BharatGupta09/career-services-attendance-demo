-- 001_initial_schema.sql
-- Users and attendance events.
--
-- Timestamps are timestamptz (stored as UTC). The working day is the
-- Asia/Dubai calendar day, which the database derives itself (event_date), so
-- no client or Worker clock can put an event on the wrong day.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), crypt(), gen_salt()

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- users
-- password_hash is a bcrypt hash produced by pgcrypto: crypt(pw, gen_salt('bf', 10)).
-- NULL means "no password set yet": the account cannot sign in.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 100),
  email         text        NOT NULL CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  password_hash text,
  role          text        NOT NULL CHECK (role IN ('student', 'admin')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)   -- also the index for sign-in lookups
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- attendance_events
--
-- One row per LOGIN or LOGOUT. `seq` numbers a user's events 0, 1, 2, ...
-- and the constraints make an invalid sequence impossible to store:
--   * even seq  <=> LOGIN, odd seq <=> LOGOUT   (strict alternation)
--   * UNIQUE (user_id, seq)                     (two concurrent LOGINs compute
--                                                the same seq; only one wins)
-- So LOGIN -> LOGIN and a LOGOUT with no LOGIN cannot exist, whatever the
-- client sends and however fast it sends it. A session is the pair
-- (seq = 2k LOGIN, seq = 2k+1 LOGOUT).
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  seq             integer     NOT NULL CHECK (seq >= 0),
  event_type      text        NOT NULL CHECK (event_type IN ('LOGIN', 'LOGOUT')),
  event_timestamp timestamptz NOT NULL DEFAULT now(),
  event_date      date        GENERATED ALWAYS AS ((event_timestamp AT TIME ZONE 'Asia/Dubai')::date) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_events_alternation CHECK ((event_type = 'LOGIN') = (seq % 2 = 0))
);

-- Serves: per-user sequence (next seq, latest event) and pairing LOGIN with LOGOUT.
-- Its leading column also serves every lookup by user_id.
CREATE UNIQUE INDEX attendance_events_user_seq_key ON attendance_events (user_id, seq);
-- Serves: a user's events in chronological order / by time range.
CREATE INDEX attendance_events_user_timestamp_idx ON attendance_events (user_id, event_timestamp);
-- Serves: a user's history for a Dubai date range.
CREATE INDEX attendance_events_user_date_idx ON attendance_events (user_id, event_date);
-- Serves: the admin dashboard's "today" across all coordinators.
CREATE INDEX attendance_events_date_idx ON attendance_events (event_date);
