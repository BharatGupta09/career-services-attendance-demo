// JSON responses, request parsing and cookies. Every API response goes
// through json(), so every response carries the same security headers.

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/** Extra headers as [name, value] pairs, so several Set-Cookie headers can be sent. */
export type ExtraHeaders = [string, string][] | Record<string, string>;

export function json(body: unknown, status = 200, extraHeaders: ExtraHeaders = {}): Response {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [name, value] of Array.isArray(extraHeaders) ? extraHeaders : Object.entries(extraHeaders)) headers.append(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function ok(data: Record<string, unknown> = {}, extraHeaders: ExtraHeaders = {}): Response {
  return json({ success: true, ...data }, 200, extraHeaders);
}

export function fail(status: number, error: string, extraHeaders: ExtraHeaders = {}): Response {
  return json({ success: false, error }, status, extraHeaders);
}

/** Thrown by handlers for an expected, user-facing error. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Basic CSRF protection for state-changing requests: the browser must send a
 * same-origin Origin header and a JSON body. Together with SameSite=Strict
 * cookies this blocks cross-site form posts.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== new URL(request.url).origin) || fetchSite === 'cross-site') {
    throw new HttpError(403, 'Cross-origin request rejected.');
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected a JSON request body.');
  }
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (length > 4096) throw new HttpError(413, 'Request body too large.');
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid JSON request body.');
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
