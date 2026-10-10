// Application sign-in / sign-out and session validation.
//
// * Passwords are verified inside PostgreSQL with pgcrypto's bcrypt
//   (crypt(input, stored_hash) = stored_hash). The Worker never hashes
//   passwords, which keeps it far below the Free plan's 10 ms CPU limit, and
//   never reads a hash back.
// * A session is a random 256-bit token in an HttpOnly, Secure,
//   SameSite=Strict cookie. The database stores only its SHA-256 hash.
// * Identity and role always come from the session row — never from the client.
import { getSql, toIso } from './db';
import { clientIp, deviceCookie, deviceKeyFor, describeDevice } from './device';
import { studentDeviceSignIn } from './device-approval';
import { assertSameOrigin, fail, getCookie, HttpError, ok, readJson } from './http';
import type { AuthUser, Env, Role } from './types';
import { CODE_WINDOW_MINUTES, generateAttendanceCode, NEW_DEVICE_MESSAGE, schemaLevel } from './verification';

const COOKIE_NAME = '__Host-cs_session';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// Failed sign-ins allowed per 15 minutes before further attempts are refused.
// Counting per email alone would let anyone lock the published demo accounts,
// so the tight limit is per email from one address (CF-Connecting-IP, set by
// Cloudflare), with a much higher ceiling per email across all addresses.
const MAX_FAILURES_PER_EMAIL_IP = 5;
const MAX_FAILURES_PER_IP = 30;
const MAX_FAILURES_PER_EMAIL = 100;

// A syntactically valid bcrypt hash that matches no password. Comparing against
// it when the email is unknown keeps response time the same for known and
// unknown accounts.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DPLKXt1FYlwYpQW2G3cAwjKoh2WZu';

function sessionHours(env: Env): number {
  const hours = Number(env.SESSION_HOURS);
  return Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 12;
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** The signed-in user for this request, or null. */
export async function authenticate(request: Request, env: Env): Promise<AuthUser | null> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = await sha256Hex(token);
  const sql = getSql(env);
  const level = await schemaLevel(sql);
  // The code columns that exist at this migration level. Whether the code is
  // still inside its 30-minute window is decided by the database clock.
  const codeColumns =
    level >= 6
      ? sql`s.attendance_code, s.attendance_code_issued_at AS code_issued_at,
            s.attendance_code_issued_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES}::int) AS code_live,
            least(s.attendance_code_issued_at + make_interval(mins => ${CODE_WINDOW_MINUTES}::int), s.expires_at) AS code_expires_at`
      : level === 5
        ? sql`s.attendance_code, NULL::timestamptz AS code_issued_at, true AS code_live, s.expires_at AS code_expires_at`
        : sql`NULL::text AS attendance_code, NULL::timestamptz AS code_issued_at, false AS code_live, NULL::timestamptz AS code_expires_at`;
  // Migration 007: a student session is valid only from the device it was
  // signed in on, and only while that device is approved for that student.
  const deviceCheck =
    level >= 7
      ? sql`AND (u.role <> 'student' OR EXISTS (
              SELECT 1 FROM user_devices ud JOIN devices d ON d.id = ud.device_id
              WHERE ud.user_id = u.id AND ud.device_id = s.device_id AND ud.status = 'approved'
                AND d.device_key = ${deviceKeyFor(request).key}))`
      : sql``;
  const rows = await sql`
    SELECT u.id, u.full_name, u.email, u.role, s.id AS session_id, s.expires_at, ${codeColumns}
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_token_hash = ${hash}
      AND s.expires_at > now()
      AND u.is_active
      ${deviceCheck}`;
  const row = rows[0];
  if (!row) return null;
  // Only admin sessions carry a code; it is never included in a student response.
  const code = row.role === 'admin' ? (row.attendance_code ?? null) : null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role as Role,
    sessionId: row.session_id,
    sessionExpiresAt: toIso(row.expires_at),
    attendanceCode: code,
    attendanceCodeIssuedAt: code && row.code_issued_at ? toIso(row.code_issued_at) : null,
    attendanceCodeExpiresAt: code && row.code_expires_at ? toIso(row.code_expires_at) : null,
    attendanceCodeLive: code !== null && row.code_live === true,
  };
}

/**
 * Authentication middleware: returns the signed-in user or throws 401.
 * With `role`, also authorises: any other role gets 403.
 */
export async function requireUser(request: Request, env: Env, role?: Role): Promise<AuthUser> {
  const user = await authenticate(request, env);
  if (!user) throw new HttpError(401, 'Your session has expired. Please log in again.');
  if (role && user.role !== role) throw new HttpError(403, 'You do not have permission to do that.');
  return user;
}

function publicUser(user: Pick<AuthUser, 'fullName' | 'email' | 'role'>) {
  return { name: user.fullName, email: user.email, role: user.role };
}

// POST /api/auth/login  { email, password }
export async function handleSignIn(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return fail(400, 'Please enter your email and password.');
  if (email.length > 254 || password.length > 200) return fail(401, 'Invalid email or password.');

  const ip = request.headers.get('CF-Connecting-IP');
  const sql = getSql(env);

  // One round trip: recent failures for this email / IP, plus the bcrypt check.
  const [row] = await sql`
    WITH recent AS (
      SELECT count(*) FILTER (WHERE email = ${email} AND ip_address IS NOT DISTINCT FROM ${ip}::text)::int
                                                                         AS by_email_ip,
             count(*) FILTER (WHERE email = ${email})::int             AS by_email,
             count(*) FILTER (WHERE ip_address = ${ip}::text)::int     AS by_ip
      FROM login_failures
      WHERE attempted_at > now() - interval '15 minutes'
        AND (email = ${email} OR ip_address = ${ip}::text)
    ),
    candidate AS (
      SELECT u.id, u.full_name, u.email, u.role, u.password_hash
      FROM (SELECT 1) AS one
      LEFT JOIN users u ON u.email = ${email} AND u.is_active
    )
    SELECT r.by_email_ip, r.by_email, r.by_ip, c.id, c.full_name, c.email, c.role,
           COALESCE(crypt(${password}::text, COALESCE(c.password_hash, ${DUMMY_HASH}::text)) = c.password_hash, false)
             AS password_ok
    FROM recent r CROSS JOIN candidate c`;

  if (!row) throw new Error('sign-in query returned no row');
  if (row.by_email_ip >= MAX_FAILURES_PER_EMAIL_IP || row.by_ip >= MAX_FAILURES_PER_IP || row.by_email >= MAX_FAILURES_PER_EMAIL) {
    return fail(429, 'Too many failed login attempts. Please wait 15 minutes and try again.');
  }

  if (!row.password_ok) {
    await sql.transaction([
      sql`INSERT INTO login_failures (email, ip_address) VALUES (${email}, ${ip}::text)`,
      sql`DELETE FROM login_failures WHERE attempted_at < now() - interval '1 day'`,
    ]);
    return fail(401, 'Invalid email or password.');
  }

  const hours = sessionHours(env);
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  // A fresh token on every sign-in; any session this browser already had is ended.
  const previous = getCookie(request, COOKIE_NAME);
  const previousHash = previous && TOKEN_RE.test(previous) ? await sha256Hex(previous) : null;
  const level = await schemaLevel(sql);
  const withCodes = level >= 5;
  const user = { user: publicUser({ fullName: row.full_name, email: row.email, role: row.role }) };

  // Migration 007: a student may sign in only from an approved device. The
  // first device is approved automatically; any other device waits for an admin.
  // The decision and the session are created in one transaction (device-approval.ts).
  if (level >= 7 && row.role === 'student') {
    const device = describeDevice(request, body.device);
    const deviceHeader: [string, string][] = device.isNewKey ? [['Set-Cookie', deviceCookie(device.key)]] : [];
    const decision = await studentDeviceSignIn(sql, { userId: row.id, email, tokenHash, hours, previousHash, device, ip: clientIp(request) });
    if (decision === 'approved' || decision === 'first') {
      return ok(user, [['Set-Cookie', sessionCookie(token, hours * 3600)], ...deviceHeader]);
    }
    // Pending or denied: no session. The device key is kept so the admin approves this exact device.
    return fail(403, NEW_DEVICE_MESSAGE, [...deviceHeader, ['Set-Cookie', sessionCookie('', 0)]]);
  }

  // An admin session gets its own attendance code. It is stored only on the
  // session row (deleted at sign-out, purged after expiry); nothing permanent
  // is written just because a code was issued. With migration 006 its 30-minute
  // window starts now and later codes replace it (verification.ts). The partial
  // unique index keeps codes distinct, so a rare collision is simply retried.
  for (let attempt = 0; ; attempt++) {
    const code = withCodes && row.role === 'admin' ? generateAttendanceCode() : null;
    try {
      await sql.transaction([
        // Housekeeping happens here, on demand, instead of in a scheduled job.
        sql`DELETE FROM sessions WHERE expires_at <= now() OR session_token_hash = ${previousHash}::text`,
        sql`DELETE FROM login_failures WHERE email = ${email}`,
        level >= 6
          ? sql`INSERT INTO sessions (user_id, session_token_hash, expires_at, attendance_code, attendance_code_issued_at)
                VALUES (${row.id}::uuid, ${tokenHash}, now() + make_interval(hours => ${hours}::int), ${code}::text,
                        CASE WHEN ${code}::text IS NULL THEN NULL ELSE now() END)`
          : withCodes
            ? sql`INSERT INTO sessions (user_id, session_token_hash, expires_at, attendance_code)
                  VALUES (${row.id}::uuid, ${tokenHash}, now() + make_interval(hours => ${hours}::int), ${code}::text)`
            : sql`INSERT INTO sessions (user_id, session_token_hash, expires_at)
                  VALUES (${row.id}::uuid, ${tokenHash}, now() + make_interval(hours => ${hours}::int))`,
      ]);
      break;
    } catch (err) {
      const duplicateCode = code && (err as { code?: string }).code === '23505';
      if (!duplicateCode || attempt >= 9) throw err;
    }
  }

  const headers: [string, string][] = [['Set-Cookie', sessionCookie(token, hours * 3600)]];
  // Give this browser its attendance device key now, so it stays the same device from the start.
  const device = deviceKeyFor(request);
  if (device.isNewKey) headers.push(['Set-Cookie', deviceCookie(device.key)]);

  return ok(user, headers);
}

// POST /api/auth/logout — ends the application session (not attendance).
export async function handleSignOut(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const token = getCookie(request, COOKIE_NAME);
  if (token && TOKEN_RE.test(token)) {
    const sql = getSql(env);
    await sql`DELETE FROM sessions WHERE session_token_hash = ${await sha256Hex(token)}`;
  }
  return ok({ message: 'You have been signed out.' }, { 'Set-Cookie': sessionCookie('', 0) });
}

// GET /api/auth/me
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) return fail(401, 'Not signed in.');
  return ok({ user: publicUser(user) });
}
