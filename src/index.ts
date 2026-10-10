import { handleAdminAudit, handleAdminCode, handleAdminCoordinator, handleAdminDevices, handleAdminOverview } from './admin';
import { handleAttendanceLogin, handleAttendanceLogout, handleHistory, handleToday } from './attendance';
import { handleMe, handleSignIn, handleSignOut } from './auth';
import { handleDeviceDecision, handleDeviceRequests } from './device-approval';
import { databaseConfigured, getSql } from './db';
import { fail, HttpError, json } from './http';
import type { Env } from './types';

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>;

// GET /api/health (no session): the Worker is up and the database is reachable.
// Reports only a status, never configuration details.
async function handleHealth(_request: Request, env: Env): Promise<Response> {
  if (!databaseConfigured(env)) return json({ status: 'not_ready', database: 'not_configured' }, 503);
  try {
    await getSql(env)`SELECT 1`;
    return json({ status: 'ready', database: 'connected' });
  } catch {
    return json({ status: 'not_ready', database: 'unreachable' }, 503);
  }
}

const routes: Record<string, Handler> = {
  'GET /api/health': handleHealth,
  'POST /api/auth/login': handleSignIn,
  'POST /api/auth/logout': handleSignOut,
  'GET /api/auth/me': handleMe,
  'GET /api/attendance/today': handleToday,
  'GET /api/attendance/history': handleHistory,
  'POST /api/attendance/login': handleAttendanceLogin,
  'POST /api/attendance/logout': handleAttendanceLogout,
  'GET /api/admin/attendance': handleAdminOverview,
  'GET /api/admin/code': handleAdminCode,
  'GET /api/admin/audit': handleAdminAudit,
  'GET /api/admin/devices': handleAdminDevices,
  'GET /api/admin/device-requests': handleDeviceRequests,
  'POST /api/admin/device-requests/decision': handleDeviceDecision,
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const handler = routes[`${request.method} ${url.pathname}`];
  if (handler) return handler(request, env, url);
  const coordinator = /^\/api\/admin\/attendance\/([^/]+)$/.exec(url.pathname);
  if (coordinator && request.method === 'GET') {
    return handleAdminCoordinator(request, env, url, coordinator[1] ?? '');
  }
  return fail(404, 'Not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      // Log only the error message: never request bodies, cookies or query values.
      console.error('Unhandled API error:', err instanceof Error ? err.message : 'unknown');
      return fail(500, 'Something went wrong. Please try again.');
    }
  },
} satisfies ExportedHandler<Env>;
