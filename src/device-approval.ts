// Student sign-in locked to admin-approved devices (migration 007).
//
// A device is the existing application-issued device key (device.ts). The
// approval unit is exactly one student + one device (a user_devices row):
//
//   * The first device a student signs in from is approved automatically.
//   * Any other device is refused with "New Device detected - contact admin"
//     and becomes ONE pending request for that student + device (repeat
//     attempts update the same request instead of creating new ones).
//   * Only an admin can approve or deny a pending request. A denied device
//     stays denied; it is never reopened automatically.
//
// Every decision is made inside the database, in one transaction serialised
// per student, and a unique index allows at most one automatically approved
// device per student — so two simultaneous first sign-ins from different
// devices cannot both be approved.
import { requireUser } from './auth';
import { getSql, toIso, type Sql } from './db';
import { clientIp, deviceSummaryText, type DeviceInfo } from './device';
import { assertSameOrigin, HttpError, ok, readJson } from './http';
import type { Env } from './types';
import { schemaLevel } from './verification';

type Row = Record<string, any>;
export type DeviceDecision = 'approved' | 'first' | 'pending' | 'new' | 'denied';

/**
 * Decide whether this student may sign in from this device and, if so, create
 * the session — all in one transaction. Returns the decision; a session exists
 * only for 'approved' (a known approved device) and 'first' (first device).
 */
export async function studentDeviceSignIn(
  sql: Sql,
  opts: { userId: string; email: string; tokenHash: string; hours: number; previousHash: string | null; device: DeviceInfo; ip: string | null },
): Promise<DeviceDecision> {
  const { userId, email, tokenHash, hours, previousHash, device: d, ip } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      const [, , , rows] = await sql.transaction(
        [
          // One sign-in / approval at a time per student.
          sql`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`,
          sql`DELETE FROM sessions WHERE expires_at <= now() OR session_token_hash = ${previousHash}::text`,
          sql`DELETE FROM login_failures WHERE email = ${email}`,
          sql`
            WITH
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
            link AS (
              SELECT ud.status, ud.decided_by FROM user_devices ud, dev
              WHERE ud.user_id = ${userId}::uuid AND ud.device_id = dev.id
            ),
            dec AS (
              SELECT CASE
                WHEN (SELECT status FROM link) = 'approved' THEN 'approved'
                WHEN (SELECT status FROM link) = 'denied' THEN 'denied'
                WHEN NOT EXISTS (SELECT 1 FROM user_devices WHERE user_id = ${userId}::uuid AND status = 'approved') THEN 'first'
                WHEN (SELECT status FROM link) = 'pending' THEN 'pending'
                ELSE 'new'
              END AS d
            ),
            -- First device: approved now. New device: one pending request (a
            -- history-only row from before device locking is turned into it).
            ud AS (
              INSERT INTO user_devices (user_id, device_id, status, requested_at, decided_at, attempt_count, last_attempt_at)
              SELECT ${userId}::uuid, dev.id, CASE WHEN dec.d = 'first' THEN 'approved' ELSE 'pending' END, now(),
                     CASE WHEN dec.d = 'first' THEN now() END, 1, now()
              FROM dev, dec
              WHERE dec.d IN ('first', 'new')
              ON CONFLICT (user_id, device_id) DO UPDATE SET
                status = EXCLUDED.status, requested_at = EXCLUDED.requested_at, decided_by = NULL,
                decided_at = EXCLUDED.decided_at, attempt_count = user_devices.attempt_count + 1, last_attempt_at = now()
              RETURNING status
            ),
            -- Repeat attempt from a pending or denied device: same request, one more attempt.
            bump AS (
              UPDATE user_devices SET attempt_count = attempt_count + 1, last_attempt_at = now()
              WHERE user_id = ${userId}::uuid AND device_id = (SELECT id FROM dev)
                AND (SELECT d FROM dec) IN ('pending', 'denied')
              RETURNING 1
            ),
            sess AS (
              INSERT INTO sessions (user_id, session_token_hash, expires_at, device_id)
              SELECT ${userId}::uuid, ${tokenHash}, now() + make_interval(hours => ${hours}::int), dev.id
              FROM dev, dec WHERE dec.d IN ('approved', 'first')
              RETURNING id
            ),
            snap AS (
              SELECT jsonb_strip_nulls(jsonb_build_object(
                'browser', ${d.browser}::text, 'browser_version', ${d.browserVersion}::text, 'os', ${d.os}::text,
                'device_type', ${d.deviceType}::text, 'timezone', ${d.timezone}::text)) AS j
            ),
            a_first AS (
              INSERT INTO audit_log (action, result, actor_user_id, device_id, ip_address, metadata)
              SELECT 'DEVICE_REGISTERED', 'SUCCESS', ${userId}::uuid, dev.id, ${ip}::text, snap.j || '{"first_device": true}'::jsonb
              FROM dev, dec, snap WHERE dec.d = 'first'
              RETURNING 1
            ),
            a_new AS (
              INSERT INTO audit_log (action, result, actor_user_id, device_id, ip_address, metadata)
              SELECT 'NEW_DEVICE', 'FLAGGED', ${userId}::uuid, dev.id, ${ip}::text, snap.j || '{"approval": "pending"}'::jsonb
              FROM dev, dec, snap WHERE dec.d = 'new'
              RETURNING 1
            ),
            a_blocked AS (
              INSERT INTO audit_log (action, result, actor_user_id, device_id, ip_address, metadata)
              SELECT 'DEVICE_LOGIN_BLOCKED', 'FAILED', ${userId}::uuid, dev.id, ${ip}::text,
                     snap.j || jsonb_build_object('device_status', CASE WHEN dec.d = 'denied' THEN 'denied' ELSE 'pending' END)
              FROM dev, dec, snap WHERE dec.d IN ('new', 'pending', 'denied')
              RETURNING 1
            ),
            a_signin AS (
              INSERT INTO audit_log (action, result, actor_user_id, verified_by, device_id, ip_address, metadata)
              SELECT 'SIGN_IN', 'SUCCESS', ${userId}::uuid, (SELECT decided_by FROM link), dev.id, ${ip}::text,
                     snap.j || jsonb_build_object('first_device', dec.d = 'first', 'approved_by_admin', (SELECT decided_by FROM link) IS NOT NULL)
              FROM dev, dec, snap WHERE dec.d IN ('approved', 'first')
              RETURNING 1
            )
            SELECT dec.d, (SELECT count(*) FROM sess)::int AS sessions, (SELECT count(*) FROM ud)::int AS linked,
                   (SELECT count(*) FROM bump)::int AS bumped, (SELECT count(*) FROM a_first)::int + (SELECT count(*) FROM a_new)::int
                     + (SELECT count(*) FROM a_blocked)::int + (SELECT count(*) FROM a_signin)::int AS audited
            FROM dec`,
        ],
        { isolationLevel: 'ReadCommitted' },
      );
      return (rows as Row[])[0]!.d as DeviceDecision;
    } catch (err) {
      // A simultaneous first sign-in from another device won the only automatic
      // approval (unique index). Decide again: this device is now a new device.
      if ((err as { code?: string }).code === '23505' && attempt < 2) continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Admin: GET /api/admin/device-requests — pending requests and recent decisions.
// ---------------------------------------------------------------------------
async function requireDeviceApproval(sql: Sql) {
  if ((await schemaLevel(sql)) < 7) {
    throw new HttpError(409, 'Device approval is available once the latest database update has been applied.');
  }
}

function deviceText(r: Row): string {
  return deviceSummaryText({ browser: r.browser, browserVersion: r.browser_version, os: r.os, deviceType: r.device_type, screenWidth: r.screen_width, screenHeight: r.screen_height, timezone: r.timezone });
}

export async function handleDeviceRequests(request: Request, env: Env): Promise<Response> {
  await requireUser(request, env, 'admin');
  const sql = getSql(env);
  await requireDeviceApproval(sql);
  const rows = (await sql`
    SELECT ud.user_id, u.full_name, u.email, ud.device_id, d.device_key, d.browser, d.browser_version, d.os, d.device_type,
           d.screen_width, d.screen_height, d.timezone, ud.status, ud.requested_at, ud.last_attempt_at, ud.attempt_count,
           ud.decided_at, a.full_name AS decided_by,
           (SELECT array_agg(o.full_name ORDER BY o.full_name) FROM user_devices x JOIN users o ON o.id = x.user_id
             WHERE x.device_id = ud.device_id AND x.user_id <> ud.user_id AND x.status = 'approved') AS also_approved_for
    FROM user_devices ud
    JOIN users u ON u.id = ud.user_id AND u.role = 'student'
    JOIN devices d ON d.id = ud.device_id
    LEFT JOIN users a ON a.id = ud.decided_by
    WHERE ud.status = 'pending' OR ud.decided_at > now() - interval '30 days'
    ORDER BY (ud.status = 'pending') DESC, COALESCE(ud.decided_at, ud.last_attempt_at, ud.requested_at) DESC
    LIMIT 200`) as Row[];
  const item = (r: Row) => ({
    userId: r.user_id as string,
    deviceId: String(r.device_id),
    student: r.full_name as string,
    email: r.email as string,
    device: { key: r.device_key, summary: deviceText(r) },
    status: r.status as 'pending' | 'approved' | 'denied',
    requestedAt: toIso(r.requested_at),
    lastAttemptAt: r.last_attempt_at ? toIso(r.last_attempt_at) : null,
    attempts: r.attempt_count as number,
    decidedAt: r.decided_at ? toIso(r.decided_at) : null,
    decidedBy: r.decided_by ?? null,
    // An approved device with no deciding admin is the student's first device.
    firstDevice: r.status === 'approved' && !r.decided_by,
    alsoApprovedFor: (r.also_approved_for as string[] | null) ?? [],
  });
  return ok({
    pending: rows.filter((r) => r.status === 'pending').map(item),
    recent: rows.filter((r) => r.status !== 'pending').map(item),
  });
}

// ---------------------------------------------------------------------------
// Admin: POST /api/admin/device-requests/decision { userId, deviceId, decision }
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleDeviceDecision(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const admin = await requireUser(request, env, 'admin');
  const sql = getSql(env);
  await requireDeviceApproval(sql);
  const body = await readJson(request);
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const deviceId = typeof body.deviceId === 'string' || typeof body.deviceId === 'number' ? String(body.deviceId) : '';
  const decision = body.decision === 'approve' ? 'approved' : body.decision === 'deny' ? 'denied' : null;
  if (!UUID_RE.test(userId) || !/^[1-9][0-9]{0,17}$/.test(deviceId) || !decision) {
    throw new HttpError(400, 'Invalid device request.');
  }

  // The request is exactly this student + this device, and it must still be
  // pending. The update and its audit entry happen together, serialised with
  // that student's sign-ins.
  const [, rows] = await sql.transaction(
    [
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`,
      sql`
        WITH before AS (
          SELECT ud.status FROM user_devices ud JOIN users u ON u.id = ud.user_id AND u.role = 'student'
          WHERE ud.user_id = ${userId}::uuid AND ud.device_id = ${deviceId}::bigint
        ),
        upd AS (
          UPDATE user_devices ud SET status = ${decision}::text, decided_by = ${admin.id}::uuid, decided_at = now()
          FROM users u
          WHERE ud.user_id = ${userId}::uuid AND ud.device_id = ${deviceId}::bigint AND ud.status = 'pending'
            AND u.id = ud.user_id AND u.role = 'student'
          RETURNING ud.user_id, ud.device_id, ud.requested_at, ud.attempt_count, ud.decided_at
        ),
        aud AS (
          INSERT INTO audit_log (action, result, actor_user_id, verified_by, device_id, admin_session_ref, ip_address, metadata)
          SELECT CASE WHEN ${decision}::text = 'approved' THEN 'DEVICE_APPROVED' ELSE 'DEVICE_DENIED' END, 'SUCCESS',
                 upd.user_id, ${admin.id}::uuid, upd.device_id, ${admin.sessionId}::uuid, ${clientIp(request)}::text,
                 jsonb_build_object('request', jsonb_build_object('user_id', upd.user_id, 'device_id', upd.device_id, 'requested_at', upd.requested_at),
                                    'attempts', upd.attempt_count, 'decision', ${decision}::text)
          FROM upd
          RETURNING id
        )
        SELECT (SELECT status FROM before) AS previous, (SELECT count(*) FROM upd)::int AS updated,
               (SELECT decided_at FROM upd) AS decided_at`,
    ],
    { isolationLevel: 'ReadCommitted' },
  );
  const r = (rows as Row[])[0]!;
  if (!r.updated) {
    if (!r.previous) throw new HttpError(404, 'Device request not found.');
    throw new HttpError(409, 'This device request has already been decided.');
  }
  return ok({ status: decision, decidedAt: toIso(r.decided_at), decidedBy: admin.fullName });
}
