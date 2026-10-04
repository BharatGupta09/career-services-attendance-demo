// Admin attendance codes, and which migrations the database has.
//
// Attendance verification (codes, devices, audit trail) needs migration 005;
// codes that rotate every 30 minutes need migration 006; locking student
// sign-in to admin-approved devices needs migration 007. A new Worker may be
// deployed before a migration has been applied, so it checks what exists and
// keeps working at the level the database supports:
//
//   level 0 (001-004)  V1: no code required
//   level 5 (005)      one code per admin session, valid for the whole session
//   level 6 (006)      a new code every 30 minutes
//   level 7 (007)      students sign in only from approved devices
//
// The result is cached per Worker instance; once the newest level is present
// the check never runs again.
import type { Sql } from './db';
import type { AuthUser } from './types';

export type SchemaLevel = 0 | 5 | 6 | 7;

let level: SchemaLevel = 0;
let checkedAt = 0;
const RECHECK_MS = 30_000;

export async function schemaLevel(sql: Sql): Promise<SchemaLevel> {
  if (level === 7) return 7;
  if (checkedAt && Date.now() - checkedAt < RECHECK_MS) return level;
  const [row] = await sql`
    WITH cols AS (
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('sessions', 'audit_log', 'user_devices')
    )
    SELECT to_regclass('public.audit_log') IS NOT NULL
             AND to_regclass('public.devices') IS NOT NULL
             AND EXISTS (SELECT 1 FROM cols WHERE table_name = 'sessions' AND column_name = 'attendance_code') AS v5,
           EXISTS (SELECT 1 FROM cols WHERE table_name = 'sessions' AND column_name = 'attendance_code_issued_at')
             AND EXISTS (SELECT 1 FROM cols WHERE table_name = 'audit_log' AND column_name = 'verified_code')
             AND EXISTS (SELECT 1 FROM cols WHERE table_name = 'audit_log' AND column_name = 'code_issued_at') AS v6,
           EXISTS (SELECT 1 FROM cols WHERE table_name = 'user_devices' AND column_name = 'status')
             AND EXISTS (SELECT 1 FROM cols WHERE table_name = 'sessions' AND column_name = 'device_id') AS v7`;
  level = row?.v5 ? (row.v6 ? (row.v7 ? 7 : 6) : 5) : 0;
  checkedAt = Date.now();
  return level;
}

/** Whether LOGIN/LOGOUT need an admin's attendance code (migration 005 or later). */
export async function verificationReady(sql: Sql): Promise<boolean> {
  return (await schemaLevel(sql)) >= 5;
}

/**
 * A uniformly random 4-digit code (0000–9999) from the Workers CSPRNG.
 * Rejection sampling avoids the bias of taking a 16-bit value modulo 10000.
 */
export function generateAttendanceCode(): string {
  const buf = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < 60000) return String(v % 10000).padStart(4, '0');
  }
}

/** How long one code is valid, counted from the moment it was generated (migration 006). */
export const CODE_WINDOW_MINUTES = 30;

export interface AdminCode {
  code: string | null;
  issuedAt: string | null;
  /** When this code stops working: the end of its 30-minute window, or the end of the admin session if sooner. */
  expiresAt: string | null;
  /** True once codes rotate (migration 006); false while one code lasts the whole session (005). */
  rotates: boolean;
}

/**
 * The signed-in admin's current code. With migration 006, if the 30-minute
 * window of the code on this session has ended (or the session has none yet),
 * a new random code is generated and replaces the old one in the same session
 * row — no code history is kept. Rotation happens here, when the admin's
 * dashboard asks for its code, instead of in a scheduled job.
 *
 * The UPDATE's conditions are on the row itself, so if two requests from the
 * same admin race at the boundary, only the first rotates; the second sees the
 * fresh code on its next pass. A code already held by another session is
 * refused by the unique index and simply retried with a new one.
 */
export async function currentAdminCode(sql: Sql, admin: AuthUser, lvl: SchemaLevel): Promise<AdminCode> {
  if (lvl < 5) return { code: null, issuedAt: null, expiresAt: null, rotates: false };
  if (lvl === 5) {
    return { code: admin.attendanceCode, issuedAt: null, expiresAt: admin.attendanceCode ? admin.sessionExpiresAt : null, rotates: false };
  }
  if (admin.attendanceCode && admin.attendanceCodeLive) {
    return { code: admin.attendanceCode, issuedAt: admin.attendanceCodeIssuedAt, expiresAt: admin.attendanceCodeExpiresAt, rotates: true };
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = generateAttendanceCode();
    let rows: Record<string, any>[];
    try {
      rows = await sql`
        WITH rot AS (
          UPDATE sessions s
          SET attendance_code = ${candidate}::text, attendance_code_issued_at = now()
          WHERE s.id = ${admin.sessionId}::uuid
            AND s.expires_at > now()
            AND (s.attendance_code IS NULL
                 OR s.attendance_code_issued_at IS NULL
                 OR s.attendance_code_issued_at <= now() - make_interval(mins => ${CODE_WINDOW_MINUTES}::int))
            -- never hand out the code that just expired again
            AND s.attendance_code IS DISTINCT FROM ${candidate}::text
          RETURNING s.attendance_code, s.attendance_code_issued_at, s.expires_at
        ),
        cur AS (
          SELECT attendance_code, attendance_code_issued_at, expires_at
          FROM sessions
          WHERE id = ${admin.sessionId}::uuid
            AND expires_at > now()
            AND attendance_code_issued_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES}::int)
        )
        SELECT attendance_code AS code, attendance_code_issued_at AS issued_at,
               least(attendance_code_issued_at + make_interval(mins => ${CODE_WINDOW_MINUTES}::int), expires_at) AS code_expires_at
        FROM (SELECT * FROM rot UNION ALL SELECT * FROM cur WHERE NOT EXISTS (SELECT 1 FROM rot)) AS x
        LIMIT 1`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') continue; // another session holds this code
      throw err;
    }
    const row = rows[0];
    if (row) {
      return { code: row.code, issuedAt: new Date(row.issued_at).toISOString(), expiresAt: new Date(row.code_expires_at).toISOString(), rotates: true };
    }
    // No row: the candidate equalled the expired code, or another request is rotating right now. Try again.
  }
  throw new Error('could not issue an attendance code');
}

export const CODE_RE = /^[0-9]{4}$/;
/** Shown to a student signing in from a device that is not approved (pending or denied). */
export const NEW_DEVICE_MESSAGE = 'New Device detected - contact admin';
export const INVALID_CODE_MESSAGE = 'Invalid attendance code. Please obtain the current code from an authorized admin.';
export const EXPIRED_CODE_MESSAGE = 'This attendance code has expired. Please obtain the current code from an authorized admin.';
export const CODE_THROTTLE_MESSAGE = 'Too many incorrect attendance codes. Please wait 15 minutes, then ask an admin for the current code.';
export const CODE_DAILY_LIMIT_MESSAGE = 'Too many incorrect attendance codes today. Please contact a Career Services admin.';
export const SHARED_DEVICE_MESSAGE = 'Multiple student accounts used the same device during overlapping attendance activity.';
// Incorrect codes allowed per 15 minutes before code entry is paused.
export const MAX_BAD_CODES_PER_USER = 5;
export const MAX_BAD_CODES_PER_IP = 30;
// And per 24 hours, so a 4-digit code cannot be worn down by guessing all day.
export const MAX_BAD_CODES_PER_USER_DAY = 12;
