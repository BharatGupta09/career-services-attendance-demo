export interface Env {
  /** Neon PostgreSQL connection string. A Worker secret, never a var. */
  DATABASE_URL: string;
  /** Application sign-in lifetime in hours (wrangler.jsonc vars). */
  SESSION_HOURS?: string;
  /** Static frontend in ./public. */
  ASSETS: Fetcher;
}

export type Role = 'student' | 'admin';

/**
 * The authenticated user, always resolved server-side from the session cookie.
 * sessionId / attendanceCode are internal: they are never sent to a student.
 */
export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  sessionId: string;
  sessionExpiresAt: string;
  /** The 4-digit code stored on an admin session (null for students). */
  attendanceCode: string | null;
  /** When that code was generated (migration 006; null before). */
  attendanceCodeIssuedAt: string | null;
  /** When that code stops working: 30 minutes after issue, or the session end if sooner. */
  attendanceCodeExpiresAt: string | null;
  /** Whether the stored code is still inside its validity window (checked by the database clock). */
  attendanceCodeLive: boolean;
}

export type EventType = 'LOGIN' | 'LOGOUT';
