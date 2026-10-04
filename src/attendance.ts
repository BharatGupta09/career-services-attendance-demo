// Attendance: recording LOGIN / LOGOUT and turning events into sessions and
// daily totals.
//
// Pairing rule: a user's events are numbered seq 0, 1, 2, ... and alternate
// LOGIN, LOGOUT, LOGIN, ... (enforced by database constraints). The session
// starting at LOGIN seq = n ends at LOGOUT seq = n + 1. Each session's
// duration is computed independently and a day's total is the sum of its
// completed sessions — never "last logout minus first login".
//
// A session belongs to the Dubai day of its LOGIN. If it is still open after
// that day ends, or its LOGOUT falls on a later Dubai day, it is "unresolved":
// shown, but not counted, because an overnight duration would be a guess.
import { getSql, toIso, type Sql } from './db';
import { clientIp, deviceCookie, describeDevice, type DeviceInfo } from './device';
import { assertSameOrigin, fail, HttpError, ok, readJson } from './http';
import { requireUser } from './auth';
import { addDays, daysBetween, dubaiDateOf, isIsoDate } from './time';
import type { Env, EventType } from './types';
import {
  CODE_DAILY_LIMIT_MESSAGE, CODE_RE, CODE_THROTTLE_MESSAGE, CODE_WINDOW_MINUTES, EXPIRED_CODE_MESSAGE, INVALID_CODE_MESSAGE,
  MAX_BAD_CODES_PER_IP, MAX_BAD_CODES_PER_USER, MAX_BAD_CODES_PER_USER_DAY, SHARED_DEVICE_MESSAGE, schemaLevel, verificationReady,
  type SchemaLevel,
} from './verification';

export const SUCCESS_MESSAGE = 'Your attendance has been marked successfully. Thank you.';
// A page loaded before attendance codes existed (a tab left open) sends LOGIN /
// LOGOUT without a body. The request is still refused; the message says how to recover.
export const OUTDATED_PAGE_MESSAGE = 'This page is out of date. Please reload the page, then try again.';

export type SessionStatus = 'complete' | 'open' | 'unresolved';

export interface DeviceSummary {
  key: string;
  browser: string | null;
  os: string | null;
  type: string;
}

/** Admin-only detail: device and verifying admin for each side of a session (null = not recorded). */
export interface SessionDetail {
  loginDevice: DeviceSummary | null;
  logoutDevice: DeviceSummary | null;
  loginVerifiedBy: string | null;
  logoutVerifiedBy: string | null;
}

export interface AttendanceSession {
  date: string; // Dubai date of the LOGIN (YYYY-MM-DD)
  loginAt: string; // ISO-8601 UTC
  logoutAt: string | null;
  status: SessionStatus;
  seconds: number; // counted duration; 0 unless complete
  detail?: SessionDetail;
}

export interface DaySummary {
  date: string;
  sessions: AttendanceSession[];
  sessionCount: number;
  totalSeconds: number; // completed sessions only
  hasOpen: boolean;
  hasUnresolved: boolean;
}

export interface CurrentState {
  status: 'LOGGED_IN' | 'LOGGED_OUT';
  /** When LOGGED_IN: the open session's login time, and whether it began before today. */
  openSince: string | null;
  openSinceDate: string | null;
  openOvernight: boolean;
}

// ---------------------------------------------------------------------------
// Queries (all parameterised; user ids always come from the server)
// ---------------------------------------------------------------------------

/** Sessions for one user whose LOGIN falls in [from, to] (Dubai dates). */
export function sessionsQuery(sql: Sql, userId: string, from: string, to: string) {
  return sql`
    SELECT l.event_date::text AS work_date, l.event_timestamp AS login_at,
           o.event_timestamp AS logout_at, o.event_date::text AS logout_date
    FROM attendance_events l
    LEFT JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
    WHERE l.user_id = ${userId}::uuid
      AND l.event_type = 'LOGIN'
      AND l.event_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY l.event_timestamp`;
}

/**
 * Admin view of the same sessions, with the device and verifying admin of the
 * LOGIN and of the LOGOUT kept separately (they can differ). Needs migration 005.
 */
export function detailedSessionsQuery(sql: Sql, userId: string, from: string, to: string) {
  return sql`
    SELECT l.event_date::text AS work_date, l.event_timestamp AS login_at,
           o.event_timestamp AS logout_at, o.event_date::text AS logout_date,
           ld.device_key AS login_device_key, ld.browser AS login_browser, ld.os AS login_os, ld.device_type AS login_device_type,
           od.device_key AS logout_device_key, od.browser AS logout_browser, od.os AS logout_os, od.device_type AS logout_device_type,
           lv.full_name AS login_verified_by, ov.full_name AS logout_verified_by
    FROM attendance_events l
    LEFT JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
    LEFT JOIN devices ld ON ld.id = l.device_id
    LEFT JOIN devices od ON od.id = o.device_id
    LEFT JOIN users lv ON lv.id = l.verified_by
    LEFT JOIN users ov ON ov.id = o.verified_by
    WHERE l.user_id = ${userId}::uuid
      AND l.event_type = 'LOGIN'
      AND l.event_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY l.event_timestamp`;
}

/** A user's most recent event, which determines their current state. */
export function latestEventQuery(sql: Sql, userId: string) {
  return sql`
    SELECT event_type, event_timestamp, event_date::text AS event_date
    FROM attendance_events
    WHERE user_id = ${userId}::uuid
    ORDER BY seq DESC
    LIMIT 1`;
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

export function deviceSummary(row: Row, prefix: string): DeviceSummary | null {
  const key = row[`${prefix}device_key`];
  if (!key) return null;
  return { key, browser: row[`${prefix}browser`] ?? null, os: row[`${prefix}os`] ?? null, type: row[`${prefix}device_type`] ?? 'unknown' };
}

export function toSession(row: Row, today: string): AttendanceSession {
  const session = baseSession(row, today);
  // Present only for rows from detailedSessionsQuery (admin views).
  if ('login_verified_by' in row) {
    session.detail = {
      loginDevice: deviceSummary(row, 'login_'),
      logoutDevice: deviceSummary(row, 'logout_'),
      loginVerifiedBy: row.login_verified_by ?? null,
      logoutVerifiedBy: row.logout_verified_by ?? null,
    };
  }
  return session;
}

function baseSession(row: Row, today: string): AttendanceSession {
  const date: string = row.work_date;
  const loginAt = toIso(row.login_at);
  if (row.logout_at == null) {
    return { date, loginAt, logoutAt: null, status: date < today ? 'unresolved' : 'open', seconds: 0 };
  }
  const logoutAt = toIso(row.logout_at);
  if (row.logout_date !== date) {
    return { date, loginAt, logoutAt, status: 'unresolved', seconds: 0 };
  }
  // Whole seconds of the displayed HH:MM:SS times, so 10:00:00 -> 12:30:00 is
  // always exactly 2h 30m even though timestamps are stored with sub-second precision.
  const seconds = Math.max(0, Math.floor(Date.parse(logoutAt) / 1000) - Math.floor(Date.parse(loginAt) / 1000));
  return { date, loginAt, logoutAt, status: 'complete', seconds };
}

export function summariseDay(date: string, sessions: AttendanceSession[]): DaySummary {
  return {
    date,
    sessions,
    sessionCount: sessions.length,
    totalSeconds: sessions.reduce((sum, s) => sum + s.seconds, 0),
    hasOpen: sessions.some((s) => s.status === 'open'),
    hasUnresolved: sessions.some((s) => s.status === 'unresolved'),
  };
}

/** Group sessions by Dubai day, most recent day first. */
export function groupByDay(sessions: AttendanceSession[]): DaySummary[] {
  const byDate = new Map<string, AttendanceSession[]>();
  for (const s of sessions) {
    const list = byDate.get(s.date);
    if (list) list.push(s);
    else byDate.set(s.date, [s]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => summariseDay(date, list));
}

export function currentState(latest: Row | undefined, today: string): CurrentState {
  if (!latest || latest.event_type !== 'LOGIN') {
    return { status: 'LOGGED_OUT', openSince: null, openSinceDate: null, openOvernight: false };
  }
  return {
    status: 'LOGGED_IN',
    openSince: toIso(latest.event_timestamp),
    openSinceDate: latest.event_date,
    openOvernight: latest.event_date < today,
  };
}

/** Read a validated { from, to } Dubai date range from the query string. */
export function dateRange(url: URL, today: string, defaultDays = 30): { from: string; to: string } {
  const to = url.searchParams.get('to') ?? today;
  const from = url.searchParams.get('from') ?? addDays(to, -(defaultDays - 1));
  if (!isIsoDate(from) || !isIsoDate(to)) throw new HttpError(400, 'Dates must be in YYYY-MM-DD format.');
  if (from > to) throw new HttpError(400, 'The start date must be on or before the end date.');
  if (daysBetween(from, to) > 366) throw new HttpError(400, 'Please choose a range of one year or less.');
  return { from, to };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Atomically record LOGIN or LOGOUT for a user with a database-generated
 * timestamp. The next seq must have the right parity for the event type
 * (LOGIN = even), so a LOGIN while logged in, or a LOGOUT while logged out,
 * inserts nothing. Two simultaneous requests compute the same seq; the unique
 * (user_id, seq) index lets exactly one of them in.
 */
export async function recordEvent(sql: Sql, userId: string, type: EventType) {
  const rows = await sql`
    INSERT INTO attendance_events (user_id, seq, event_type)
    SELECT ${userId}::uuid, n.next_seq, ${type}::text
    FROM (
      SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
      FROM attendance_events
      WHERE user_id = ${userId}::uuid
    ) AS n
    WHERE (n.next_seq % 2 = 0) = (${type}::text = 'LOGIN')
    ON CONFLICT (user_id, seq) DO NOTHING
    RETURNING event_type, event_timestamp, event_date::text AS event_date`;
  const row = rows[0];
  if (!row) {
    throw new HttpError(409, type === 'LOGIN' ? 'You are already logged in.' : 'You are not currently logged in.');
  }
  return { type: row.event_type as EventType, timestamp: toIso(row.event_timestamp), date: row.event_date as string };
}

// ---------------------------------------------------------------------------
// Student endpoints. Every query is scoped to the signed-in user's own id;
// any user_id supplied by the client is never read.
// ---------------------------------------------------------------------------

/**
 * Record a code-verified LOGIN or LOGOUT (migration 005). One transaction,
 * serialised per student by an advisory lock, so concurrent requests cannot
 * slip past the incorrect-code limit or record twice. In a single statement:
 *
 *   1. count the student's (and IP's) incorrect codes in the last 15 minutes
 *      and the student's in the last 24 hours;
 *   2. find the LIVE admin session whose code matches: the session has not
 *      expired or been signed out, and (migration 006) the code is still inside
 *      its 30-minute window. A code that matches only an expired window or
 *      session is reported as expired; rotated-out codes no longer exist;
 *   3. upsert the device;
 *   4. insert the event only if the code matched and the LOGIN/LOGOUT sequence
 *      allows it (the same seq/parity rule and unique index as before);
 *   5. append audit rows: success, or an incorrect-code attempt; a new device
 *      for this student; and a neutral shared-device flag when another student
 *      used the same device within 2 hours or still has a session open on it.
 *
 * Codes that are never used leave no record. A successful verification is
 * recorded as the verifying admin and admin session id and, with migration 006,
 * the code used and the start of its window. An incorrect code is never stored.
 */
export async function recordVerifiedEvent(
  sql: Sql, userId: string, type: EventType, code: string, d: DeviceInfo, ip: string | null, level: SchemaLevel = 6,
) {
  const rotating = level >= 6;
  const inWindow = rotating
    ? sql`AND s.attendance_code_issued_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES}::int)`
    : sql``;
  const issuedAt = rotating ? sql`s.attendance_code_issued_at` : sql`NULL::timestamptz`;
  const codeAuditColumns = rotating ? sql`, verified_code, code_issued_at` : sql``;
  const codeAuditValues = rotating ? sql`, adm.code, adm.code_issued_at` : sql``;
  const [, rows] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`,
    sql`
      WITH
      lim AS (
        SELECT count(*) FILTER (WHERE actor_user_id = ${userId}::uuid AND created_at > now() - interval '15 minutes') AS by_user,
               count(*) FILTER (WHERE ip_address = ${ip}::text AND created_at > now() - interval '15 minutes') AS by_ip,
               count(*) FILTER (WHERE actor_user_id = ${userId}::uuid) AS by_user_day
        FROM audit_log
        WHERE action = 'INVALID_ATTENDANCE_CODE'
          AND created_at > now() - interval '24 hours'
          AND (actor_user_id = ${userId}::uuid OR ip_address = ${ip}::text)
      ),
      gate AS (
        SELECT (by_user < ${MAX_BAD_CODES_PER_USER}::int AND by_ip < ${MAX_BAD_CODES_PER_IP}::int
                AND by_user_day < ${MAX_BAD_CODES_PER_USER_DAY}::int) AS allowed,
               by_user_day >= ${MAX_BAD_CODES_PER_USER_DAY}::int AS daily_limit
        FROM lim
      ),
      adm AS (
        SELECT s.id AS session_id, a.id AS admin_id, a.full_name AS admin_name, s.attendance_code AS code, ${issuedAt} AS code_issued_at
        FROM sessions s
        JOIN users a ON a.id = s.user_id AND a.role = 'admin' AND a.is_active
        WHERE s.attendance_code = ${code}::text
          AND s.expires_at > now()
          ${inWindow}
          AND (SELECT allowed FROM gate)
        LIMIT 1
      ),
      -- The code is still on an admin session, but its window or the session has ended.
      stale AS (
        SELECT 1 AS x FROM sessions s
        WHERE s.attendance_code = ${code}::text
          AND (SELECT allowed FROM gate) AND NOT EXISTS (SELECT 1 FROM adm)
        LIMIT 1
      ),
      dev AS (
        INSERT INTO devices (device_key, browser, browser_version, os, device_type, screen_width, screen_height, timezone, user_agent)
        VALUES (${d.key}::text, ${d.browser}::text, ${d.browserVersion}::text, ${d.os}::text, ${d.deviceType}::text,
                ${d.screenWidth}::int, ${d.screenHeight}::int, ${d.timezone}::text, ${d.userAgent}::text)
        ON CONFLICT (device_key) DO UPDATE SET
          browser = EXCLUDED.browser, browser_version = EXCLUDED.browser_version, os = EXCLUDED.os,
          device_type = EXCLUDED.device_type,
          screen_width = COALESCE(EXCLUDED.screen_width, devices.screen_width),
          screen_height = COALESCE(EXCLUDED.screen_height, devices.screen_height),
          timezone = COALESCE(EXCLUDED.timezone, devices.timezone),
          user_agent = EXCLUDED.user_agent, last_seen_at = now()
        RETURNING id
      ),
      snap AS (
        SELECT jsonb_strip_nulls(jsonb_build_object(
          'browser', ${d.browser}::text, 'browser_version', ${d.browserVersion}::text, 'os', ${d.os}::text,
          'device_type', ${d.deviceType}::text, 'timezone', ${d.timezone}::text)) AS j
      ),
      nxt AS (SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM attendance_events WHERE user_id = ${userId}::uuid),
      ev AS (
        INSERT INTO attendance_events (user_id, seq, event_type, device_id, verified_by)
        SELECT ${userId}::uuid, nxt.next_seq, ${type}::text, dev.id, adm.admin_id
        FROM nxt, dev, adm
        WHERE (nxt.next_seq % 2 = 0) = (${type}::text = 'LOGIN')
        ON CONFLICT (user_id, seq) DO NOTHING
        RETURNING id, event_type, event_timestamp, event_date::text AS event_date
      ),
      ud AS (
        INSERT INTO user_devices (user_id, device_id)
        SELECT ${userId}::uuid, dev.id FROM dev, ev
        ON CONFLICT (user_id, device_id) DO UPDATE SET last_used_at = now()
        RETURNING (xmax = 0) AS is_new
      ),
      bad AS (
        INSERT INTO audit_log (action, result, actor_user_id, device_id, ip_address, metadata)
        SELECT 'INVALID_ATTENDANCE_CODE', 'FAILED', ${userId}::uuid, dev.id, ${ip}::text,
               snap.j || jsonb_build_object('attempted_action', ${type}::text,
                                            'reason', CASE WHEN EXISTS (SELECT 1 FROM stale) THEN 'expired_code' ELSE 'invalid_code' END)
        FROM dev, snap
        WHERE (SELECT allowed FROM gate) AND NOT EXISTS (SELECT 1 FROM adm)
        RETURNING id
      ),
      good AS (
        INSERT INTO audit_log (action, result, actor_user_id, verified_by, attendance_event_id, admin_session_ref, device_id, ip_address,
                               metadata ${codeAuditColumns})
        SELECT 'ATTENDANCE_' || ev.event_type, 'SUCCESS', ${userId}::uuid, adm.admin_id, ev.id, adm.session_id, dev.id, ${ip}::text,
               snap.j || jsonb_build_object('code_verified', true) ${codeAuditValues}
        FROM ev, adm, dev, snap
        RETURNING id
      ),
      newdev AS (
        INSERT INTO audit_log (action, result, actor_user_id, attendance_event_id, device_id, ip_address, metadata)
        SELECT 'NEW_DEVICE', 'INFO', ${userId}::uuid, ev.id, dev.id, ${ip}::text, snap.j
        FROM ud, ev, dev, snap
        WHERE ud.is_new
        RETURNING id
      ),
      others AS (
        SELECT DISTINCT e.user_id
        FROM attendance_events e, dev, ev
        WHERE e.device_id = dev.id
          AND e.user_id <> ${userId}::uuid
          AND (e.event_timestamp > now() - interval '2 hours'
               OR (e.event_type = 'LOGIN' AND NOT EXISTS (
                     SELECT 1 FROM attendance_events o WHERE o.user_id = e.user_id AND o.seq = e.seq + 1)))
      ),
      share AS (
        INSERT INTO audit_log (action, result, actor_user_id, related_user_id, attendance_event_id, device_id, ip_address, metadata)
        SELECT 'DEVICE_SHARING_DETECTED', 'FLAGGED', ${userId}::uuid, others.user_id, ev.id, dev.id, ${ip}::text,
               jsonb_build_object('message', ${SHARED_DEVICE_MESSAGE}::text)
        FROM others, ev, dev
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_log a
          WHERE a.action = 'DEVICE_SHARING_DETECTED' AND a.device_id = dev.id
            AND a.created_at > now() - interval '12 hours'
            AND ((a.actor_user_id = ${userId}::uuid AND a.related_user_id = others.user_id)
              OR (a.actor_user_id = others.user_id AND a.related_user_id = ${userId}::uuid)))
        RETURNING id
      )
      SELECT (SELECT allowed FROM gate) AS allowed, (SELECT daily_limit FROM gate) AS daily_limit,
             (SELECT admin_name FROM adm) AS admin_name, EXISTS (SELECT 1 FROM stale) AS expired,
             ev.event_type, ev.event_timestamp, ev.event_date,
             (SELECT count(*) FROM share)::int AS flagged
      FROM (SELECT 1) AS one
      LEFT JOIN ev ON true`,
  ]);
  const row = (rows as Row[])[0]!;
  if (!row.allowed) throw new HttpError(429, row.daily_limit ? CODE_DAILY_LIMIT_MESSAGE : CODE_THROTTLE_MESSAGE);
  if (!row.admin_name) throw new HttpError(403, row.expired ? EXPIRED_CODE_MESSAGE : INVALID_CODE_MESSAGE);
  if (!row.event_type) {
    throw new HttpError(409, type === 'LOGIN' ? 'You are already logged in.' : 'You are not currently logged in.');
  }
  return {
    event: { type: row.event_type as EventType, timestamp: toIso(row.event_timestamp), date: row.event_date as string },
    verifiedBy: row.admin_name as string,
  };
}

async function handleMark(request: Request, env: Env, type: EventType): Promise<Response> {
  assertSameOrigin(request);
  const user = await requireUser(request, env, 'student');
  const sql = getSql(env);

  const level = await schemaLevel(sql);
  if (level < 5) {
    // Migration 005 not applied yet: original V1 behaviour, no code required.
    const event = await recordEvent(sql, user.id, type);
    return ok({ message: SUCCESS_MESSAGE, event });
  }

  const body = await readJson(request).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 415) throw new HttpError(415, OUTDATED_PAGE_MESSAGE);
    throw err;
  });
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!CODE_RE.test(code)) throw new HttpError(400, 'Please enter the 4-digit attendance code.');
  const device = describeDevice(request, body.device);
  // A newly issued device key is sent back on success and on refusal alike, so
  // retries from this browser keep the same device rather than creating new ones.
  const cookie: [string, string][] = device.isNewKey ? [['Set-Cookie', deviceCookie(device.key)]] : [];
  try {
    const { event } = await recordVerifiedEvent(sql, user.id, type, code, device, clientIp(request), level);
    // The student learns only that the code was accepted — not which admin's it was.
    return ok({ message: SUCCESS_MESSAGE, event }, cookie);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message, cookie);
    throw err;
  }
}

// POST /api/attendance/login
export const handleAttendanceLogin = (request: Request, env: Env) => handleMark(request, env, 'LOGIN');
// POST /api/attendance/logout
export const handleAttendanceLogout = (request: Request, env: Env) => handleMark(request, env, 'LOGOUT');

// GET /api/attendance/today
export async function handleToday(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env, 'student');
  const sql = getSql(env);
  const today = dubaiDateOf();
  const [latest, sessionRows, eventRows] = await sql.transaction(
    [
      latestEventQuery(sql, user.id),
      sessionsQuery(sql, user.id, today, today),
      sql`SELECT event_type, event_timestamp FROM attendance_events
          WHERE user_id = ${user.id}::uuid AND event_date = ${today}::date
          ORDER BY seq`,
    ],
    { readOnly: true },
  );
  const sessions = (sessionRows as Row[]).map((r) => toSession(r, today));
  return ok({
    name: user.fullName,
    date: today,
    serverTime: new Date().toISOString(),
    // Whether LOGIN/LOGOUT needs an admin's attendance code (never the code itself).
    verificationRequired: await verificationReady(sql),
    state: currentState((latest as Row[])[0], today),
    today: summariseDay(today, sessions),
    events: (eventRows as Row[]).map((e) => ({ type: e.event_type, timestamp: toIso(e.event_timestamp) })),
  });
}

// GET /api/attendance/history?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function handleHistory(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env, 'student');
  const sql = getSql(env);
  const today = dubaiDateOf();
  const { from, to } = dateRange(url, today);
  const rows = (await sessionsQuery(sql, user.id, from, to)) as Row[];
  return ok({ from, to, days: groupByDay(rows.map((r) => toSession(r, today))) });
}
