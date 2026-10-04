// Synthetic dataset for the public demo.
//
// Every person, device, address and event here is fictional. The ten users come
// from migrations 003/004 (the example.com directory); this module gives them a
// demo password and generates four weeks of history relative to the current
// date, so the dashboards always show recent activity:
//
//   * one to three sessions on most weekdays, each LOGIN/LOGOUT verified with an
//     admin's rotating attendance code; today's sessions stop at the current
//     time, so some coordinators are still logged in;
//   * an overnight session that the dashboards flag as Unresolved;
//   * a shared lab computer used by two coordinators within two hours of each
//     other (a "potential shared device" flag);
//   * device approval history: first devices, two admin-approved devices, one
//     denied device and one request still waiting for an admin;
//   * a few incorrect attendance codes in the audit trail.
//
// Maya Thompson and Omar Haddad have attendance history from before device
// approval was switched on, but no approved device. The first browser that
// signs in as either of them is therefore approved automatically — which is how
// a visitor can try the student view.
//
// The rows mirror exactly what the Worker itself writes (see attendance.ts and
// device-approval.ts). Output is deterministic for a given date (fixed PRNG
// seed). IP addresses are from the documentation range 203.0.113.0/24 (RFC 5737).

export const DEFAULT_DEMO_PASSWORD = 'DemoPassword123!';

/** Every account in a demo database must match this (fictional, non-routable domains). */
export const DEMO_EMAIL_RE = /@example\.(com|invalid|test)$/;

const STUDENTS = ['maya.thompson', 'omar.haddad', 'lena.fischer', 'daniel.okafor', 'sofia.marquez', 'kenji.watanabe'];
const ADMINS = ['priya.raman', 'james.carter', 'nadia.hassan', 'elena.rossi'];
export const DEMO_EMAILS = [...STUDENTS, ...ADMINS].map((h) => `${h}@example.com`);

const DAYS = 28; // today and the 27 days before it
const TZ = 'Asia/Dubai';
const UTC_OFFSET_MIN = 4 * 60; // Asia/Dubai is UTC+4 all year (no daylight saving)

// ---------------------------------------------------------------------------
// Deterministic randomness and date helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dubaiYmd = (instant) => ymdFmt.format(instant);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isWeekday = (ymd) => ![0, 6].includes(new Date(`${ymd}T00:00:00Z`).getUTCDay());
/** The instant at `minutes` past midnight (may exceed 1440) of a Dubai date, plus `seconds`. */
const at = (ymd, minutes, seconds = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + (minutes - UTC_OFFSET_MIN) * 60_000 + seconds * 1000);
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Devices (user agents are what the browsers report; the parsed fields match
// what src/device.ts would derive from them)
// ---------------------------------------------------------------------------
const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:143.0) Gecko/20100101 Firefox/143.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  chromeCros: 'Mozilla/5.0 (X11; CrOS x86_64 16328.65.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsungTablet: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36',
};

const DEVICES = {
  mayaLaptop: { id: 1, ua: UA.chromeWin, browser: 'Chrome', version: '140', os: 'Windows', type: 'desktop', w: 1536, h: 864 },
  omarPhone: { id: 2, ua: UA.safariIos, browser: 'Safari', version: '18', os: 'iOS', type: 'mobile', w: 393, h: 852 },
  lenaLaptop: { id: 3, ua: UA.firefoxMac, browser: 'Firefox', version: '143', os: 'macOS', type: 'desktop', w: 1440, h: 900 },
  lenaPhone: { id: 4, ua: UA.chromeAndroid, browser: 'Chrome', version: '140', os: 'Android', type: 'mobile', w: 412, h: 915 },
  danielLaptop: { id: 5, ua: UA.edgeWin, browser: 'Edge', version: '140', os: 'Windows', type: 'desktop', w: 1920, h: 1080 },
  labDesktop: { id: 6, ua: UA.chromeWin, browser: 'Chrome', version: '140', os: 'Windows', type: 'desktop', w: 1366, h: 768 },
  sofiaChromebook: { id: 7, ua: UA.chromeCros, browser: 'Chrome', version: '140', os: 'ChromeOS', type: 'desktop', w: 1366, h: 768 },
  kenjiLaptop: { id: 8, ua: UA.safariMac, browser: 'Safari', version: '18', os: 'macOS', type: 'desktop', w: 1512, h: 982 },
  kenjiTablet: { id: 9, ua: UA.samsungTablet, browser: 'Samsung Internet', version: '28', os: 'Android', type: 'tablet', w: 1280, h: 800 },
};

/** The audit "snapshot" of a device, as the Worker records it. */
const snap = (d) => ({ browser: d.browser, browser_version: d.version, os: d.os, device_type: d.type, timezone: TZ });
const ipOf = (d) => `203.0.113.${20 + d.id}`;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build the synthetic rows for the given user ids (email handle -> uuid).
 * Pure: no database access, so it is easy to inspect and test.
 */
export function buildDemoData(ids, now = new Date()) {
  const rng = mulberry32(20260915);
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16)).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(rng() * 4)]}${h.slice(17, 20)}-${h.slice(20)}`;
  };
  for (const d of Object.values(DEVICES)) {
    d.key = 'DEV-' + Array.from({ length: 12 }, () => Math.floor(rng() * 16).toString(16)).join('').toUpperCase();
  }

  const today = dubaiYmd(now);
  const nowMs = now.getTime();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));
  // The demo always treats today as a working day, so the dashboards are never empty.
  const workDays = days.filter((d) => d === today || isWeekday(d));
  const workDayNear = (back) => {
    const target = addDays(today, -back);
    return workDays.filter((d) => d <= target).at(-1) ?? workDays[0];
  };
  const id = (handle) => {
    const v = ids[handle];
    if (!v) throw new Error(`demo user ${handle}@example.com not found — are migrations 003/004 applied?`);
    return v;
  };

  // Key dates of the story.
  const labApprovedDaniel = workDayNear(12);
  const labApprovedSofia = workDayNear(9);
  const sharedDay = workDayNear(4);
  const lenaDenied = workDayNear(6);
  const omarOvernight = workDayNear(8);
  const kenjiRequest = workDays.at(-2);

  // Which device each student uses on a day.
  function deviceFor(handle, day) {
    switch (handle) {
      case 'maya.thompson': return DEVICES.mayaLaptop;
      case 'omar.haddad': return DEVICES.omarPhone;
      case 'lena.fischer': return DEVICES.lenaLaptop;
      case 'kenji.watanabe': return DEVICES.kenjiLaptop;
      case 'daniel.okafor':
        if (day === sharedDay) return DEVICES.labDesktop;
        return day > labApprovedDaniel && day !== sharedDay && rng() < 0.3 ? DEVICES.labDesktop : DEVICES.danielLaptop;
      case 'sofia.marquez':
        if (day === sharedDay) return DEVICES.labDesktop;
        return DEVICES.sofiaChromebook;
      default: throw new Error(handle);
    }
  }
  // Students whose sign-in is device-locked (migration 007 behaviour) throughout the history.
  const locked = new Set(['lena.fischer', 'daniel.okafor', 'sofia.marquez', 'kenji.watanabe']);

  // Admin attendance codes: per admin and day, one admin session whose code
  // rotates every 30 minutes from the admin's sign-in.
  const adminDay = new Map();
  function adminCodeAt(admin, day, instant) {
    const k = `${admin}|${day}`;
    if (!adminDay.has(k)) adminDay.set(k, { sessionRef: uuid(), signIn: at(day, int(8 * 60 + 15, 8 * 60 + 50), int(0, 59)).getTime(), codes: new Map() });
    const s = adminDay.get(k);
    const windowNo = Math.max(0, Math.floor((instant.getTime() - s.signIn) / (30 * MIN)));
    if (!s.codes.has(windowNo)) s.codes.set(windowNo, String(int(0, 9999)).padStart(4, '0'));
    return { sessionRef: s.sessionRef, code: s.codes.get(windowNo), issuedAt: new Date(Math.min(s.signIn + windowNo * 30 * MIN, instant.getTime() - 1000)) };
  }

  const events = []; // { user, type, ts, device, verifiedBy, code, sessionRef, issuedAt }
  const audit = []; // rows without ids yet
  const links = new Map(); // `${user}|${deviceId}` -> user_devices row
  const usage = new Map(); // deviceId -> { first, last }

  const touchDevice = (d, t) => {
    const u = usage.get(d.id) ?? { first: t, last: t };
    if (t < u.first) u.first = t;
    if (t > u.last) u.last = t;
    usage.set(d.id, u);
  };
  const link = (handle, d, fields) => {
    const k = `${handle}|${d.id}`;
    const row = links.get(k) ?? { user_id: id(handle), device_id: d.id, status: null, requested_at: null, decided_by: null, decided_at: null, attempt_count: 0, last_attempt_at: null, first_used_at: null, last_used_at: null };
    Object.assign(row, fields);
    links.set(k, row);
    return row;
  };
  const used = (handle, d, t) => {
    const row = link(handle, d, {});
    if (!row.first_used_at || t < row.first_used_at) row.first_used_at = t;
    if (!row.last_used_at || t > row.last_used_at) row.last_used_at = t;
  };
  const log = (row) => audit.push({ related_user_id: null, verified_by: null, attendance_event_ref: null, admin_session_ref: null, verified_code: null, code_issued_at: null, ...row });

  // ---- device approval story ----------------------------------------------
  // A request that an admin approved, for the shared lab computer.
  function approved(handle, day, admin) {
    const d = DEVICES.labDesktop;
    const req = at(day, 9 * 60 + int(0, 20), int(0, 59));
    const dec = new Date(req.getTime() + int(6, 25) * MIN);
    link(handle, d, { status: 'approved', requested_at: req, decided_by: id(admin), decided_at: dec, attempt_count: 1, last_attempt_at: req });
    log({ created_at: req, action: 'NEW_DEVICE', result: 'FLAGGED', actor_user_id: id(handle), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), approval: 'pending' } });
    log({ created_at: new Date(req.getTime() + 5), action: 'DEVICE_LOGIN_BLOCKED', result: 'FAILED', actor_user_id: id(handle), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), device_status: 'pending' } });
    log({ created_at: dec, action: 'DEVICE_APPROVED', result: 'SUCCESS', actor_user_id: id(handle), verified_by: id(admin), device_id: d.id, admin_session_ref: adminCodeAt(admin, day, dec).sessionRef, ip_address: '203.0.113.5',
      metadata: { request: { user_id: id(handle), device_id: d.id, requested_at: req.toISOString() }, attempts: 1, decision: 'approved' } });
  }
  approved('daniel.okafor', labApprovedDaniel, 'james.carter');
  approved('sofia.marquez', labApprovedSofia, 'nadia.hassan');
  // Lena's phone: requested, denied, tried again the next working day.
  {
    const d = DEVICES.lenaPhone;
    const req = at(lenaDenied, 8 * 60 + 52, 14);
    const dec = at(lenaDenied, 9 * 60 + 31, 40);
    const retry = at(workDays[workDays.indexOf(lenaDenied) + 1], 8 * 60 + 57, 3);
    link('lena.fischer', d, { status: 'denied', requested_at: req, decided_by: id('priya.raman'), decided_at: dec, attempt_count: 2, last_attempt_at: retry, first_used_at: req, last_used_at: req });
    touchDevice(d, req);
    touchDevice(d, retry);
    log({ created_at: req, action: 'NEW_DEVICE', result: 'FLAGGED', actor_user_id: id('lena.fischer'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), approval: 'pending' } });
    log({ created_at: new Date(req.getTime() + 5), action: 'DEVICE_LOGIN_BLOCKED', result: 'FAILED', actor_user_id: id('lena.fischer'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), device_status: 'pending' } });
    log({ created_at: dec, action: 'DEVICE_DENIED', result: 'SUCCESS', actor_user_id: id('lena.fischer'), verified_by: id('priya.raman'), device_id: d.id, admin_session_ref: adminCodeAt('priya.raman', lenaDenied, dec).sessionRef, ip_address: '203.0.113.5',
      metadata: { request: { user_id: id('lena.fischer'), device_id: d.id, requested_at: req.toISOString() }, attempts: 1, decision: 'denied' } });
    log({ created_at: retry, action: 'DEVICE_LOGIN_BLOCKED', result: 'FAILED', actor_user_id: id('lena.fischer'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), device_status: 'denied' } });
  }
  // Kenji's tablet: a request still waiting for an admin (two attempts).
  {
    const d = DEVICES.kenjiTablet;
    const req = at(kenjiRequest, 17 * 60 + 4, 51);
    const again = new Date(req.getTime() + 2 * MIN + 17_000);
    link('kenji.watanabe', d, { status: 'pending', requested_at: req, attempt_count: 2, last_attempt_at: again, first_used_at: req, last_used_at: req });
    touchDevice(d, req);
    touchDevice(d, again);
    log({ created_at: req, action: 'NEW_DEVICE', result: 'FLAGGED', actor_user_id: id('kenji.watanabe'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), approval: 'pending' } });
    log({ created_at: new Date(req.getTime() + 5), action: 'DEVICE_LOGIN_BLOCKED', result: 'FAILED', actor_user_id: id('kenji.watanabe'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), device_status: 'pending' } });
    log({ created_at: again, action: 'DEVICE_LOGIN_BLOCKED', result: 'FAILED', actor_user_id: id('kenji.watanabe'), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), device_status: 'pending' } });
  }

  // ---- attendance ----------------------------------------------------------
  for (const day of workDays) {
    const onDuty = [pick(ADMINS), pick(ADMINS)];
    for (const handle of STUDENTS) {
      const forced = (day === sharedDay && (handle === 'daniel.okafor' || handle === 'sofia.marquez')) || (day === omarOvernight && handle === 'omar.haddad');
      if (!forced && day !== today && rng() > 0.82) continue; // a day off
      const d = deviceFor(handle, day);

      // Session times (minutes past Dubai midnight).
      let sessions = [];
      if (forced && handle !== 'omar.haddad') {
        sessions = handle === 'daniel.okafor' ? [[9 * 60 + 58, 12 * 60 + 10]] : [[12 * 60 + 41, 15 * 60 + 2]];
      } else {
        const count = pick([1, 2, 2, 2, 3]);
        let start = int(8 * 60 + 50, 10 * 60 + 40);
        for (let i = 0; i < count && start < 17 * 60; i++) {
          const end = Math.min(start + int(70, 200), 18 * 60 + 30);
          sessions.push([start, end]);
          start = end + int(25, 95);
        }
      }
      if (handle === 'omar.haddad' && day === omarOvernight) sessions.push([22 * 60 + 41, 24 * 60 + 26]); // ends after midnight

      let signedIn = false;
      for (const [startMin, endMin] of sessions) {
        const login = at(day, startMin, int(0, 59));
        const logout = at(day, endMin, int(0, 59));
        if (login.getTime() >= nowMs - 2 * MIN) break; // not yet happened today
        if (locked.has(handle) && !signedIn) {
          // Device-locked sign-in. The very first one approves the student's first device.
          const t = new Date(login.getTime() - int(1, 4) * MIN - int(0, 59) * 1000);
          let lk = links.get(`${handle}|${d.id}`);
          const first = !lk;
          if (first) {
            lk = link(handle, d, { status: 'approved', requested_at: t, decided_at: t, attempt_count: 1, last_attempt_at: t });
            log({ created_at: t, action: 'DEVICE_REGISTERED', result: 'SUCCESS', actor_user_id: id(handle), device_id: d.id, ip_address: ipOf(d), metadata: { ...snap(d), first_device: true } });
          }
          log({ created_at: new Date(t.getTime() + 5), action: 'SIGN_IN', result: 'SUCCESS', actor_user_id: id(handle), verified_by: lk.decided_by, device_id: d.id, ip_address: ipOf(d),
            metadata: { ...snap(d), first_device: first, approved_by_admin: !!lk.decided_by } });
          signedIn = true;
        }
        events.push({ user: handle, type: 'LOGIN', ts: login, device: d, admin: pick(onDuty) });
        if (logout.getTime() >= nowMs) break; // still logged in right now
        events.push({ user: handle, type: 'LOGOUT', ts: logout, device: d, admin: pick(onDuty) });
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  // seq per user, ids in time order, codes, device links and audit rows.
  const seq = new Map();
  const eventRows = events.map((e, i) => {
    const s = seq.get(e.user) ?? 0;
    seq.set(e.user, s + 1);
    const code = adminCodeAt(e.admin, dubaiYmd(e.ts), e.ts);
    const row = { id: i + 1, user_id: id(e.user), seq: s, event_type: e.type, event_timestamp: e.ts, created_at: e.ts, device_id: e.device.id, verified_by: id(e.admin) };
    touchDevice(e.device, e.ts);
    const isNewLink = !links.get(`${e.user}|${e.device.id}`)?.first_used_at;
    used(e.user, e.device, e.ts);
    log({ created_at: e.ts, action: `ATTENDANCE_${e.type}`, result: 'SUCCESS', actor_user_id: row.user_id, verified_by: row.verified_by, attendance_event_ref: row.id,
      admin_session_ref: code.sessionRef, device_id: e.device.id, ip_address: ipOf(e.device), metadata: { ...snap(e.device), code_verified: true },
      verified_code: code.code, code_issued_at: code.issuedAt });
    // Pre-device-locking students: first use of a device is noted, as the Worker does.
    if (isNewLink && !locked.has(e.user)) {
      log({ created_at: new Date(e.ts.getTime() + 3), action: 'NEW_DEVICE', result: 'INFO', actor_user_id: row.user_id, attendance_event_ref: row.id, device_id: e.device.id, ip_address: ipOf(e.device), metadata: snap(e.device) });
    }
    return row;
  });

  // The shared lab computer: Sofia's LOGIN came less than two hours after Daniel's LOGOUT.
  const sofiaShared = eventRows.find((r) => r.user_id === id('sofia.marquez') && r.device_id === DEVICES.labDesktop.id && r.event_type === 'LOGIN' && dubaiYmd(r.event_timestamp) === sharedDay);
  if (sofiaShared) {
    log({ created_at: new Date(sofiaShared.event_timestamp.getTime() + 4), action: 'DEVICE_SHARING_DETECTED', result: 'FLAGGED', actor_user_id: id('sofia.marquez'), related_user_id: id('daniel.okafor'),
      attendance_event_ref: sofiaShared.id, device_id: DEVICES.labDesktop.id, ip_address: ipOf(DEVICES.labDesktop),
      metadata: { message: 'Multiple student accounts used the same device during overlapping attendance activity.' } });
  }

  // A few incorrect codes, at least two days old (so they never count towards today's limits).
  const cutoff = nowMs - 2 * 86_400_000;
  const older = eventRows.filter((r) => r.event_timestamp.getTime() < cutoff);
  for (let i = 0; i < 7 && older.length; i++) {
    const r = older[int(0, older.length - 1)];
    const d = Object.values(DEVICES).find((x) => x.id === r.device_id);
    log({ created_at: new Date(r.event_timestamp.getTime() - int(15, 90) * 1000), action: 'INVALID_ATTENDANCE_CODE', result: 'FAILED', actor_user_id: r.user_id, device_id: d.id, ip_address: ipOf(d),
      metadata: { ...snap(d), attempted_action: r.event_type, reason: i === 3 ? 'expired_code' : 'invalid_code' } });
  }

  audit.sort((a, b) => a.created_at - b.created_at);
  const auditRows = audit.map((a, i) => ({ ...a, id: i + 1 }));

  const deviceRows = Object.values(DEVICES)
    .filter((d) => usage.has(d.id))
    .map((d) => ({
      id: d.id, device_key: d.key, browser: d.browser, browser_version: d.version, os: d.os, device_type: d.type,
      screen_width: d.w, screen_height: d.h, timezone: TZ, user_agent: d.ua,
      first_seen_at: usage.get(d.id).first, last_seen_at: usage.get(d.id).last, created_at: usage.get(d.id).first, updated_at: usage.get(d.id).last,
    }));
  const linkRows = [...links.values()].filter((l) => l.first_used_at || l.status);
  for (const l of linkRows) {
    // A device approved on the first day but not used yet still needs its timestamps.
    l.first_used_at ??= l.requested_at;
    l.last_used_at ??= l.requested_at;
  }

  return { today, devices: deviceRows, userDevices: linkRows, events: eventRows, audit: auditRows };
}

/**
 * Write the synthetic dataset into a freshly migrated, empty demo database.
 * `query(text, params)` must return `{ rows }` (pg Client, Neon Client or PGlite).
 * The caller is responsible for the safety checks in demo-guard.mjs.
 */
export async function seedDemoData(query, { password = DEFAULT_DEMO_PASSWORD, now = new Date() } = {}) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    throw new Error('The demo password must be 8–72 characters.');
  }
  const users = (await query('SELECT id, email FROM users WHERE email = ANY($1::text[])', [DEMO_EMAILS])).rows;
  const ids = Object.fromEntries(users.map((u) => [u.email.replace(/@example\.com$/, ''), u.id]));
  const data = buildDemoData(ids, now);
  const json = (rows) => JSON.stringify(rows);

  for (const email of DEMO_EMAILS) {
    await query(`UPDATE users SET password_hash = crypt($1::text, gen_salt('bf', 10)) WHERE email = $2`, [password, email]);
  }
  await query(
    `INSERT INTO devices (id, device_key, browser, browser_version, os, device_type, screen_width, screen_height, timezone, user_agent,
                          first_seen_at, last_seen_at, created_at, updated_at)
     OVERRIDING SYSTEM VALUE
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, device_key text, browser text, browser_version text, os text, device_type text,
       screen_width int, screen_height int, timezone text, user_agent text, first_seen_at timestamptz, last_seen_at timestamptz,
       created_at timestamptz, updated_at timestamptz)`,
    [json(data.devices)],
  );
  await query(
    `INSERT INTO user_devices (user_id, device_id, first_used_at, last_used_at, status, requested_at, decided_by, decided_at, attempt_count, last_attempt_at)
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(user_id uuid, device_id bigint, first_used_at timestamptz, last_used_at timestamptz, status text,
       requested_at timestamptz, decided_by uuid, decided_at timestamptz, attempt_count int, last_attempt_at timestamptz)`,
    [json(data.userDevices.map(({ user_id, device_id, first_used_at, last_used_at, status, requested_at, decided_by, decided_at, attempt_count, last_attempt_at }) =>
      ({ user_id, device_id, first_used_at, last_used_at, status, requested_at, decided_by, decided_at, attempt_count, last_attempt_at })))],
  );
  await query(
    `INSERT INTO attendance_events (id, user_id, seq, event_type, event_timestamp, created_at, device_id, verified_by)
     OVERRIDING SYSTEM VALUE
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, user_id uuid, seq int, event_type text, event_timestamp timestamptz,
       created_at timestamptz, device_id bigint, verified_by uuid)`,
    [json(data.events)],
  );
  await query(
    `INSERT INTO audit_log (id, created_at, action, result, actor_user_id, related_user_id, verified_by, attendance_event_id, admin_session_ref,
                           device_id, ip_address, metadata, verified_code, code_issued_at)
     OVERRIDING SYSTEM VALUE
     SELECT id, created_at, action, result, actor_user_id, related_user_id, verified_by, attendance_event_ref, admin_session_ref,
            device_id, ip_address, metadata, verified_code, code_issued_at
     FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, created_at timestamptz, action text, result text, actor_user_id uuid, related_user_id uuid,
       verified_by uuid, attendance_event_ref bigint, admin_session_ref uuid, device_id bigint, ip_address text, metadata jsonb,
       verified_code text, code_issued_at timestamptz)`,
    [json(data.audit)],
  );
  // Explicit ids were used, so move each identity sequence past them.
  for (const t of ['devices', 'attendance_events', 'audit_log']) {
    await query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT COALESCE(max(id), 0) + 1 FROM ${t}), false)`);
  }
  return { users: users.length, devices: data.devices.length, userDevices: data.userDevices.length, events: data.events.length, audit: data.audit.length };
}
