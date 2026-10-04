-- 002_authentication.sql
-- Server-side application sessions and failed sign-in tracking.

-- ---------------------------------------------------------------------------
-- sessions
-- The browser holds a random 256-bit token in an HttpOnly cookie. Only its
-- SHA-256 hash (hex) is stored, so a database leak does not yield usable
-- cookies. Expired rows are removed on each successful sign-in (no cron).
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_token_hash text        NOT NULL CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_key UNIQUE (session_token_hash)  -- lookup index
);

CREATE INDEX sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- login_failures
-- Basic brute-force protection without extra infrastructure: failed sign-ins
-- are recorded here and counted over the last 15 minutes. Rows older than a
-- day are pruned whenever a new failure is recorded.
-- ---------------------------------------------------------------------------
CREATE TABLE login_failures (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text        NOT NULL,
  ip_address   text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_failures_email_idx ON login_failures (email, attempted_at);
CREATE INDEX login_failures_ip_idx    ON login_failures (ip_address, attempted_at);
