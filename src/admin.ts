// Admin endpoints. Every handler starts with requireUser(..., 'admin'), so a
// student (or anyone without a valid session) is refused before any data is
// read. Admins see Student Coordinators only; admin accounts are not listed.
import {
  currentState,
  dateRange,
  detailedSessionsQuery,
  deviceSummary,
  groupByDay,
  latestEventQuery,
  sessionsQuery,
  toSession,
  type AttendanceSession,
} from './attendance';
import { requireUser } from './auth';
import { getSql, toIso, type Sql } from './db';
import { HttpError, ok } from './http';
import { dubaiDateOf } from './time';
import type { Env } from './types';
import { CODE_WINDOW_MINUTES, currentAdminCode, schemaLevel, verificationReady, type AdminCode } from './verification';

type Row = Record<string, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/admin/attendance — today's overview for all coordinators.
// ---------------------------------------------------------------------------
function overviewQueries(sql: Sql, today: string, detailed: boolean) {
  const students = sql`SELECT id, full_name FROM users WHERE role = 'student' AND is_active ORDER BY full_name`;
  if (!detailed) {
    return [
      students,
      sql`SELECT DISTINCT ON (e.user_id) e.user_id, e.event_type, e.event_timestamp, e.event_date::text AS event_date
          FROM attendance_events e
          JOIN users u ON u.id = e.user_id AND u.role = 'student'
          ORDER BY e.user_id, e.seq DESC`,
      sql`SELECT l.user_id, l.event_date::text AS work_date, l.event_timestamp AS login_at,
                 o.event_timestamp AS logout_at, o.event_date::text AS logout_date
          FROM attendance_events l
          JOIN users u ON u.id = l.user_id AND u.role = 'student'
          LEFT JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
          WHERE l.event_type = 'LOGIN' AND l.event_date = ${today}::date
          ORDER BY l.event_timestamp`,
      sql`SELECT e.user_id, u.full_name, e.event_type, e.event_timestamp
          FROM attendance_events e
          JOIN users u ON u.id = e.user_id AND u.role = 'student'
          WHERE e.event_date = ${today}::date
          ORDER BY e.event_timestamp DESC, e.seq DESC`,
    ];
  }
  return [
    students,
    sql`SELECT DISTINCT ON (e.user_id) e.user_id, e.event_type, e.event_timestamp, e.event_date::text AS event_date,
               d.device_key, d.browser, d.os, d.device_type
        FROM attendance_events e
        JOIN users u ON u.id = e.user_id AND u.role = 'student'
        LEFT JOIN devices d ON d.id = e.device_id
        ORDER BY e.user_id, e.seq DESC`,
    sql`SELECT l.user_id, l.event_date::text AS work_date, l.event_timestamp AS login_at,
               o.event_timestamp AS logout_at, o.event_date::text AS logout_date,
               ld.device_key AS login_device_key, ld.browser AS login_browser, ld.os AS login_os, ld.device_type AS login_device_type,
               od.device_key AS logout_device_key, od.browser AS logout_browser, od.os AS logout_os, od.device_type AS logout_device_type,
               lv.full_name AS login_verified_by, ov.full_name AS logout_verified_by
        FROM attendance_events l
        JOIN users u ON u.id = l.user_id AND u.role = 'student'
        LEFT JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
        LEFT JOIN devices ld ON ld.id = l.device_id
        LEFT JOIN devices od ON od.id = o.device_id
        LEFT JOIN users lv ON lv.id = l.verified_by
        LEFT JOIN users ov ON ov.id = o.verified_by
        WHERE l.event_type = 'LOGIN' AND l.event_date = ${today}::date
        ORDER BY l.event_timestamp`,
    sql`SELECT e.user_id, u.full_name, e.event_type, e.event_timestamp,
               d.device_key, d.browser, d.os, d.device_type, v.full_name AS verified_by
        FROM attendance_events e
        JOIN users u ON u.id = e.user_id AND u.role = 'student'
        LEFT JOIN devices d ON d.id = e.device_id
        LEFT JOIN users v ON v.id = e.verified_by
        WHERE e.event_date = ${today}::date
        ORDER BY e.event_timestamp DESC, e.seq DESC`,
    // Coordinators involved in a shared-device flag since the start of today (Dubai).
    sql`SELECT DISTINCT unnest(ARRAY[actor_user_id, related_user_id]) AS user_id
        FROM audit_log
        WHERE action = 'DEVICE_SHARING_DETECTED'
          AND created_at >= (${today}::date::timestamp AT TIME ZONE 'Asia/Dubai')`,
  ];
}

/** The fields describing this admin's own code, shared by the overview and GET /api/admin/code. */
function codeFields(code: AdminCode, sessionExpiresAt: string) {
  return {
    attendanceCode: code.code,
    attendanceCodeIssuedAt: code.issuedAt,
    attendanceCodeExpiresAt: code.expiresAt,
    // With rotation, a code lasts CODE_WINDOW_MINUTES; before migration 006 it lasts the session.
    attendanceCodeRotates: code.rotates,
    codeWindowMinutes: code.rotates ? CODE_WINDOW_MINUTES : null,
    sessionExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/code — this admin's current attendance code only. The
// dashboard calls it once when the displayed code's window ends (no polling);
// if the window has ended, the server issues the next code here.
// ---------------------------------------------------------------------------
export async function handleAdminCode(request: Request, env: Env): Promise<Response> {
  const admin = await requireUser(request, env, 'admin');
  const sql = getSql(env);
  const level = await schemaLevel(sql);
  const code = await currentAdminCode(sql, admin, level);
  return ok({ serverTime: new Date().toISOString(), verificationEnabled: level >= 5, ...codeFields(code, admin.sessionExpiresAt) });
}

export async function handleAdminOverview(request: Request, env: Env): Promise<Response> {
  const admin = await requireUser(request, env, 'admin');
  const sql = getSql(env);
  const today = dubaiDateOf();
  const level = await schemaLevel(sql);
  const detailed = level >= 5;
  // This admin's own code only — every admin session has its own. Rotated first if its window has ended.
  const code = await currentAdminCode(sql, admin, level);

  const queries = overviewQueries(sql, today, detailed);
  // Migration 007: number of student device requests waiting for an admin (same round trip).
  if (level >= 7) queries.push(sql`SELECT count(*)::int AS n FROM user_devices ud JOIN users u ON u.id = ud.user_id AND u.role = 'student' WHERE ud.status = 'pending'`);
  const [students, latest, sessionRows, eventRows, flagRows = [], pendingRows = []] = await sql.transaction(queries, { readOnly: true });
  const pendingDeviceRequests = ((pendingRows as Row[])[0]?.n as number | undefined) ?? 0;

  const latestByUser = new Map((latest as Row[]).map((r) => [r.user_id, r]));
  const flagged = new Set((flagRows as Row[]).map((r) => r.user_id));
  const sessionsByUser = new Map<string, AttendanceSession[]>();
  for (const r of sessionRows as Row[]) {
    const list = sessionsByUser.get(r.user_id) ?? [];
    list.push(toSession(r, today));
    sessionsByUser.set(r.user_id, list);
  }
  const lastLogoutByUser = new Map<string, string>();
  for (const e of eventRows as Row[]) {
    // Rows are newest first, so the first LOGOUT seen is the last one today.
    if (e.event_type === 'LOGOUT' && !lastLogoutByUser.has(e.user_id)) lastLogoutByUser.set(e.user_id, toIso(e.event_timestamp));
  }

  const coordinators = (students as Row[]).map((s) => {
    const sessions = sessionsByUser.get(s.id) ?? [];
    const last = latestByUser.get(s.id);
    return {
      id: s.id as string,
      name: s.full_name as string,
      state: currentState(last, today),
      firstLogin: sessions[0]?.loginAt ?? null,
      lastLogout: lastLogoutByUser.get(s.id) ?? null,
      sessionCount: sessions.length,
      todayTotalSeconds: sessions.reduce((sum, x) => sum + x.seconds, 0),
      hasUnresolved: sessions.some((x) => x.status === 'unresolved'),
      ...(detailed
        ? { lastDevice: last ? deviceSummary(last, '') : null, sharedDeviceFlag: flagged.has(s.id), sessions }
        : {}),
    };
  });

  const loggedIn = coordinators.filter((c) => c.state.status === 'LOGGED_IN').length;
  return ok({
    date: today,
    serverTime: new Date().toISOString(),
    verificationEnabled: detailed,
    deviceApprovalEnabled: level >= 7,
    pendingDeviceRequests,
    ...codeFields(code, admin.sessionExpiresAt),
    summary: {
      totalCoordinators: coordinators.length,
      loggedIn,
      loggedOut: coordinators.length - loggedIn,
      todayTotalSeconds: coordinators.reduce((sum, c) => sum + c.todayTotalSeconds, 0),
      todayEvents: (eventRows as Row[]).length,
      sharedDeviceFlags: flagged.size,
    },
    coordinators,
    activity: (eventRows as Row[]).map((e) => ({
      name: e.full_name,
      type: e.event_type,
      timestamp: toIso(e.event_timestamp),
      ...(detailed ? { device: deviceSummary(e, ''), verifiedBy: e.verified_by ?? null } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/attendance/:userId?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------------
export async function handleAdminCoordinator(request: Request, env: Env, url: URL, userId: string): Promise<Response> {
  await requireUser(request, env, 'admin');
  if (!UUID_RE.test(userId)) throw new HttpError(404, 'Coordinator not found.');
  const sql = getSql(env);
  const today = dubaiDateOf();
  const { from, to } = dateRange(url, today);
  const detailed = await verificationReady(sql);

  const [users, latest, sessionRows] = await sql.transaction(
    [
      sql`SELECT id, full_name, is_active FROM users WHERE id = ${userId}::uuid AND role = 'student'`,
      latestEventQuery(sql, userId),
      detailed ? detailedSessionsQuery(sql, userId, from, to) : sessionsQuery(sql, userId, from, to),
    ],
    { readOnly: true },
  );
  const user = (users as Row[])[0];
  if (!user) throw new HttpError(404, 'Coordinator not found.');

  return ok({
    coordinator: {
      id: user.id,
      name: user.full_name,
      isActive: user.is_active,
      state: currentState((latest as Row[])[0], today),
    },
    from,
    to,
    verificationEnabled: detailed,
    days: groupByDay((sessionRows as Row[]).map((r) => toSession(r, today))),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit?action=&from=&to=&limit= — the audit trail (read-only).
// ---------------------------------------------------------------------------
const AUDIT_ACTIONS = new Set([
  'ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT', 'INVALID_ATTENDANCE_CODE', 'DEVICE_SHARING_DETECTED', 'NEW_DEVICE',
  // migration 007
  'DEVICE_REGISTERED', 'DEVICE_LOGIN_BLOCKED', 'DEVICE_APPROVED', 'DEVICE_DENIED', 'SIGN_IN',
]);

async function requireVerification(sql: Sql) {
  if (!(await verificationReady(sql))) {
    throw new HttpError(409, 'The audit trail is available once the latest database update has been applied.');
  }
}

export async function handleAdminAudit(request: Request, env: Env, url: URL): Promise<Response> {
  await requireUser(request, env, 'admin');
  const sql = getSql(env);
  await requireVerification(sql);
  const today = dubaiDateOf();
  const { from, to } = dateRange(url, today, 7);
  const actionParam = url.searchParams.get('action');
  const action = actionParam && actionParam !== 'all' ? actionParam : null;
  if (action && !AUDIT_ACTIONS.has(action)) throw new HttpError(400, 'Unknown audit action.');
  const limitParam = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 500 ? limitParam : 200;

  // The code that verified a successful LOGIN/LOGOUT (migration 006; never stored for anything else).
  const codeColumns = (await schemaLevel(sql)) >= 6
    ? sql`a.verified_code, a.code_issued_at`
    : sql`NULL::text AS verified_code, NULL::timestamptz AS code_issued_at`;
  const rows = (await sql`
    SELECT a.id, a.created_at, a.action, a.result, a.ip_address, a.metadata, ${codeColumns},
           s.full_name AS student, r.full_name AS related_student, v.full_name AS verified_by,
           d.device_key, d.browser, d.os, d.device_type
    FROM audit_log a
    LEFT JOIN users s ON s.id = a.actor_user_id
    LEFT JOIN users r ON r.id = a.related_user_id
    LEFT JOIN users v ON v.id = a.verified_by
    LEFT JOIN devices d ON d.id = a.device_id
    WHERE a.created_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Dubai')
      AND a.created_at <  ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
      AND (${action}::text IS NULL OR a.action = ${action}::text)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}::int`) as Row[];

  return ok({
    from,
    to,
    entries: rows.map((r) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
      return {
        id: String(r.id),
        at: toIso(r.created_at),
        action: r.action,
        result: r.result,
        student: r.student ?? null,
        relatedStudent: r.related_student ?? null,
        verifiedBy: r.verified_by ?? null,
        codeUsed: r.verified_code ?? null,
        codeIssuedAt: r.code_issued_at ? toIso(r.code_issued_at) : null,
        device: deviceSummary(r, ''),
        ip: r.ip_address ?? null,
        // Only fields this application writes; no tokens or passwords exist here, and
        // no incorrect or unused codes.
        attemptedAction: meta.attempted_action ?? null,
        deviceStatus: meta.device_status ?? null,
        firstDevice: meta.first_device === true,
        codeExpired: meta.reason === 'expired_code',
        message: meta.message ?? null,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/devices — devices, who used them, and recent activity.
// ---------------------------------------------------------------------------
export async function handleAdminDevices(request: Request, env: Env): Promise<Response> {
  await requireUser(request, env, 'admin');
  const sql = getSql(env);
  await requireVerification(sql);
  // With migration 007, a student is listed for a device they have used or are approved on,
  // not for one whose sign-in was only requested (pending) or refused (denied).
  const usedFilter = (await schemaLevel(sql)) >= 7 ? sql`WHERE ud.status IS NULL OR ud.status = 'approved'` : sql``;

  const [devices, users, recent, flags] = await sql.transaction(
    [
      sql`SELECT id, device_key, browser, browser_version, os, device_type, screen_width, screen_height, timezone,
                 first_seen_at, last_seen_at
          FROM devices ORDER BY last_seen_at DESC LIMIT 100`,
      sql`SELECT ud.device_id, u.full_name, ud.first_used_at, ud.last_used_at
          FROM user_devices ud JOIN users u ON u.id = ud.user_id AND u.role = 'student'
          ${usedFilter}
          ORDER BY ud.last_used_at DESC`,
      sql`SELECT device_id, full_name, event_type, event_timestamp FROM (
            SELECT e.device_id, u.full_name, e.event_type, e.event_timestamp,
                   row_number() OVER (PARTITION BY e.device_id ORDER BY e.event_timestamp DESC) AS rn
            FROM attendance_events e JOIN users u ON u.id = e.user_id
            WHERE e.device_id IS NOT NULL AND e.event_timestamp > now() - interval '30 days'
          ) x WHERE rn <= 6 ORDER BY event_timestamp DESC`,
      sql`SELECT device_id, count(*)::int AS n, max(created_at) AS last_flag
          FROM audit_log WHERE action = 'DEVICE_SHARING_DETECTED' AND device_id IS NOT NULL
          GROUP BY device_id`,
    ],
    { readOnly: true },
  );

  const group = <T>(rows: Row[], map: (r: Row) => T) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = String(r.device_id); const l = m.get(k) ?? []; l.push(map(r)); m.set(k, l); }
    return m;
  };
  const usersBy = group(users as Row[], (r) => ({ name: r.full_name, firstUsed: toIso(r.first_used_at), lastUsed: toIso(r.last_used_at) }));
  const recentBy = group(recent as Row[], (r) => ({ name: r.full_name, type: r.event_type, timestamp: toIso(r.event_timestamp) }));
  const flagsBy = new Map((flags as Row[]).map((r) => [String(r.device_id), r]));

  return ok({
    devices: (devices as Row[]).map((d) => {
      const id = String(d.id);
      const usedBy = usersBy.get(id) ?? [];
      const f = flagsBy.get(id);
      return {
        key: d.device_key,
        browser: d.browser,
        browserVersion: d.browser_version,
        os: d.os,
        type: d.device_type,
        screen: d.screen_width && d.screen_height ? `${d.screen_width}×${d.screen_height}` : null,
        timezone: d.timezone,
        firstSeen: toIso(d.first_seen_at),
        lastSeen: toIso(d.last_seen_at),
        usedBy,
        recent: recentBy.get(id) ?? [],
        sharedDeviceFlags: f ? f.n : 0,
        lastFlagAt: f ? toIso(f.last_flag) : null,
        potentiallyShared: usedBy.length > 1,
      };
    }),
  });
}
