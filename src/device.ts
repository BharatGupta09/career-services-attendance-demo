// Device identification for this attendance application only.
//
// A device is a random application-issued key ("DEV-" + 12 hex digits) kept in
// an HttpOnly, Secure, SameSite=Strict cookie scoped to this site. It is not a
// fingerprint: nothing is derived from hardware, and it cannot follow anyone
// to other websites. Alongside it we record what the browser itself reports
// (user agent / client hints, screen size, timezone) so admins can recognise
// the device. Clearing site data simply produces a new device key.
import { getCookie } from './http';

export const DEVICE_COOKIE = '__Host-cs_device';
const DEVICE_KEY_RE = /^DEV-[0-9A-F]{12}$/;
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days

export interface DeviceInfo {
  key: string;
  isNewKey: boolean; // true when this request is being issued a new key
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  screenWidth: number | null;
  screenHeight: number | null;
  timezone: string | null;
  userAgent: string | null;
}

function newDeviceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'DEV-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The device key from the cookie, or a newly issued one when missing or malformed. */
export function deviceKeyFor(request: Request): { key: string; isNewKey: boolean } {
  const existing = getCookie(request, DEVICE_COOKIE);
  if (existing && DEVICE_KEY_RE.test(existing)) return { key: existing, isNewKey: false };
  return { key: newDeviceKey(), isNewKey: true };
}

export function deviceCookie(key: string): string {
  return `${DEVICE_COOKIE}=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

const clip = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);

/** Browser, version and OS from client hints (when sent) and the user agent. */
export function parseUserAgent(ua: string, hints: { platform?: string | null; mobile?: string | null } = {}) {
  // Order matters: Edge, Opera and Samsung also contain "Chrome"; Chrome contains "Safari".
  const BROWSERS: [string, RegExp][] = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /(?:OPR|Opera)\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  let browser: string | null = null;
  let version: string | null = null;
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) { browser = name; version = m[1] ?? null; break; }
  }

  const platformHint = (hints.platform ?? '').replace(/"/g, '').trim();
  let os: string | null = null;
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (!os && platformHint) os = platformHint;

  let deviceType: DeviceInfo['deviceType'] = 'unknown';
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) deviceType = 'tablet';
  else if (hints.mobile === '?1' || /Mobi|iPhone|iPod/.test(ua)) deviceType = 'mobile';
  else if (ua) deviceType = 'desktop';

  return { browser, browserVersion: version, os, deviceType };
}

const TZ_RE = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+){0,3}$/;
const screenDim = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20000 ? (v as number) : null);

/**
 * Everything we record about the device for this request. `client` is the
 * optional { screenWidth, screenHeight, timezone } object sent by the page;
 * anything missing or invalid is simply left out.
 */
export function describeDevice(request: Request, client: unknown): DeviceInfo {
  const { key, isNewKey } = deviceKeyFor(request);
  const ua = request.headers.get('User-Agent') ?? '';
  const parsed = parseUserAgent(ua, {
    platform: request.headers.get('Sec-CH-UA-Platform'),
    mobile: request.headers.get('Sec-CH-UA-Mobile'),
  });
  const c = client && typeof client === 'object' ? (client as Record<string, unknown>) : {};
  const tz = typeof c.timezone === 'string' && c.timezone.length <= 64 && TZ_RE.test(c.timezone) ? c.timezone : null;
  return {
    key,
    isNewKey,
    browser: clip(parsed.browser, 40),
    browserVersion: clip(parsed.browserVersion, 20),
    os: clip(parsed.os, 40),
    deviceType: parsed.deviceType,
    screenWidth: screenDim(c.screenWidth),
    screenHeight: screenDim(c.screenHeight),
    timezone: tz,
    userAgent: clip(ua, 400),
  };
}

/** "Chrome 129 · Windows · Desktop · 1280×800 · Asia/Dubai" from what was recorded (for admins). */
export function deviceSummaryText(d: Partial<Pick<DeviceInfo, 'browser' | 'browserVersion' | 'os' | 'deviceType' | 'screenWidth' | 'screenHeight' | 'timezone'>>): string {
  const type = d.deviceType && d.deviceType !== 'unknown' ? d.deviceType.charAt(0).toUpperCase() + d.deviceType.slice(1) : null;
  return [
    d.browser ? `${d.browser}${d.browserVersion ? ` ${d.browserVersion}` : ''}` : 'Unknown browser',
    d.os ?? 'Unknown system',
    type,
    d.screenWidth && d.screenHeight ? `${d.screenWidth}×${d.screenHeight}` : null,
    d.timezone ?? null,
  ].filter(Boolean).join(' · ');
}

/**
 * The client IP as seen by Cloudflare. Cloudflare sets CF-Connecting-IP at its
 * edge and overwrites any value a client sends, so it can be trusted there.
 * Absent in local tests, in which case nothing is recorded.
 */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP');
  return ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
}
