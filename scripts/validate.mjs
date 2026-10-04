#!/usr/bin/env node
// End-to-end validation of a deployed demo: the demo Neon database and the
// DEPLOYED demo Worker.
//
//   DEMO_MODE=true npm run validate -- https://career-services-attendance-demo.<subdomain>.workers.dev
//
// Refuses to run unless DEMO_MODE=true, and refuses a database that holds any
// account outside the demo directory (scripts/lib/demo-guard.mjs).
//
// Asks (hidden) for DATABASE_URL and each user's password. Passwords stay in
// memory only; output is PASS/FAIL lines and never contains a secret.
//
// Side effects, all reverted: the attendance tests record a few LOGIN/LOGOUT
// events for one Student Coordinator (you confirm which), and those events are
// deleted at the end. Database integrity tests run inside a transaction that
// is rolled back. Test app sessions are signed out.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, neon, neonConfig } from '@neondatabase/serverless';
import { assertDemoDatabase } from './lib/demo-guard.mjs';
import { ask, askHidden, closePrompt, databaseUrl } from './lib/prompt.mjs';

neonConfig.webSocketConstructor = globalThis.WebSocket;
const MSG = 'Your attendance has been marked successfully. Thank you.';
const USERS = [
  ['Maya Thompson', 'maya.thompson@example.com', 'student'],
  ['Omar Haddad', 'omar.haddad@example.com', 'student'],
  ['Lena Fischer', 'lena.fischer@example.com', 'student'],
  ['Daniel Okafor', 'daniel.okafor@example.com', 'student'],
  ['Sofia Marquez', 'sofia.marquez@example.com', 'student'],
  ['Kenji Watanabe', 'kenji.watanabe@example.com', 'student'],
  ['Priya Raman', 'priya.raman@example.com', 'admin'],
  ['James Carter', 'james.carter@example.com', 'admin'],
  ['Nadia Hassan', 'nadia.hassan@example.com', 'admin'],
  ['Elena Rossi', 'elena.rossi@example.com', 'admin'],
];
const STUDENT_NAMES = USERS.filter((u) => u[2] === 'student').map((u) => u[0]).sort();
const dubaiDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(iso));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
}
const section = (title) => console.log(`\n== ${title} ==`);

// ---------------------------------------------------------------------------
let base = (process.argv[2] || (await ask('Deployed Worker URL (https://...workers.dev): '))).replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(base)) {
  console.error('Please pass the Worker origin, e.g. https://career-services-attendance-demo.example.workers.dev');
  process.exit(1);
}
const url = await databaseUrl();
const sql = neon(url);
try {
  await assertDemoDatabase(async (text) => ({ rows: await sql.query(text) }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// ============================ DATABASE ============================
section('Neon database');
let dbOk = false;
try {
  const [row] = await sql`SELECT current_database() AS db, now() AS now`;
  dbOk = true;
  check('connection to Neon succeeds', !!row);
} catch (err) {
  check('connection to Neon succeeds', false, err.message);
}
if (!dbOk) {
  closePrompt();
  process.exit(1);
}

const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const expectedVersions = (await readdir(migDir)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, '')).sort();
const applied = (await sql`SELECT version FROM schema_migrations ORDER BY version`.catch(() => [])).map((r) => r.version);
check(`all migrations applied (${expectedVersions.join(', ')})`, expectedVersions.every((v) => applied.includes(v)), `applied: ${applied.join(', ') || 'none'}`);

const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((r) => r.table_name);
for (const t of ['users', 'attendance_events', 'sessions', 'login_failures', 'schema_migrations', 'devices', 'user_devices', 'audit_log']) check(`table ${t} exists`, tables.includes(t));
check('audit_log is append-only (trigger present)', (await sql`SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_update_delete'`).length === 1);
const cols = (await sql`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`).map((r) => r.c);
for (const c of ['sessions.attendance_code_issued_at', 'audit_log.verified_code', 'audit_log.code_issued_at']) check(`column ${c} (006)`, cols.includes(c));
// Migration 007: student sign-in locked to approved devices.
const deviceLock = cols.includes('sessions.device_id') && cols.includes('user_devices.status');
for (const c of ['user_devices.status', 'user_devices.requested_at', 'user_devices.decided_by', 'user_devices.decided_at', 'user_devices.attempt_count', 'user_devices.last_attempt_at', 'sessions.device_id']) check(`column ${c} (007)`, cols.includes(c));
check('index user_devices_one_self_registered (007: one automatic first device per student)', (await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'user_devices_one_self_registered'`).length === 1);
check('pgcrypto extension installed', (await sql`SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'`).length === 1);

const cons = await sql`
  SELECT c.conname, c.contype, t.relname AS tbl, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'`;
const hasCon = (tbl, type, re) => cons.some((c) => c.tbl === tbl && c.contype === type && re.test(c.def));
check('FK attendance_events.user_id -> users(id)', hasCon('attendance_events', 'f', /FOREIGN KEY \(user_id\) REFERENCES users\(id\)/));
check('FK sessions.user_id -> users(id) ON DELETE CASCADE', hasCon('sessions', 'f', /REFERENCES users\(id\) ON DELETE CASCADE/));
check('UNIQUE users.email', hasCon('users', 'u', /UNIQUE \(email\)/));
check('CHECK users.role in (student, admin)', hasCon('users', 'c', /role.*student.*admin/));
check('CHECK event_type in (LOGIN, LOGOUT)', hasCon('attendance_events', 'c', /event_type.*LOGIN.*LOGOUT/));
check('CHECK LOGIN/LOGOUT alternation', cons.some((c) => c.conname === 'attendance_events_alternation'));
check('UNIQUE sessions.session_token_hash', hasCon('sessions', 'u', /UNIQUE \(session_token_hash\)/));
check('CHECK audit_log: a code is stored only on successful LOGIN/LOGOUT (006)', cons.some((c) => c.conname === 'audit_log_verified_code_check') && cons.some((c) => c.conname === 'audit_log_code_issued_at_check'));

const idx = (await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`).map((r) => r.indexname);
for (const i of ['attendance_events_user_seq_key', 'attendance_events_user_timestamp_idx', 'attendance_events_user_date_idx', 'attendance_events_date_idx', 'sessions_user_id_idx', 'sessions_expires_at_idx', 'login_failures_email_idx', 'login_failures_ip_idx', 'sessions_attendance_code_key', 'devices_device_key_key', 'user_devices_device_idx', 'attendance_events_device_time_idx', 'audit_log_created_idx']) {
  check(`index ${i}`, idx.includes(i));
}

const users = await sql`
  SELECT id, full_name, email, role, is_active, (password_hash LIKE '$2%') AS bcrypt
  FROM users ORDER BY full_name`;
check('exactly 10 users', users.length === 10, `found ${users.length}`);
check('no placeholder users', !users.some((u) => u.email.endsWith('@example.invalid')));
check('no duplicate emails', new Set(users.map((u) => u.email.toLowerCase())).size === users.length);
for (const [name, email, role] of USERS) {
  const u = users.find((x) => x.email === email);
  check(`user ${name}: name, role ${role}, active`, u && u.full_name === name && u.role === role && u.is_active, u ? `${u.full_name}/${u.role}/${u.is_active}` : 'missing');
}
check('every user has a bcrypt password hash (none plaintext)', users.length === 10 && users.every((u) => u.bcrypt === true));

// Integrity tests inside a transaction that is always rolled back.
const client = new Client(url);
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: [tu] } = await client.query(`INSERT INTO users (full_name, email, role) VALUES ('Validation Test', 'validation.test@example.invalid', 'student') RETURNING id`);
  const expectErr = async (label, text, params, code) => {
    await client.query('SAVEPOINT s');
    try {
      await client.query(text, params);
      check(label, false, 'no error raised');
    } catch (err) {
      check(label, err.code === code, `got ${err.code}`);
    }
    await client.query('ROLLBACK TO SAVEPOINT s');
  };
  await expectErr('reject event for non-existent user (FK)', `INSERT INTO attendance_events (user_id, seq, event_type) VALUES (gen_random_uuid(), 0, 'LOGIN')`, [], '23503');
  await expectErr('reject invalid event type', `INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'BREAK')`, [tu.id], '23514');
  await expectErr('reject LOGOUT without LOGIN', `INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGOUT')`, [tu.id], '23514');
  await client.query(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGIN')`, [tu.id]);
  await expectErr('reject second LOGIN in the same slot (duplicate open session)', `INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGIN')`, [tu.id], '23505');
  await expectErr('reject LOGIN immediately after LOGIN', `INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 1, 'LOGIN')`, [tu.id], '23514');
  await expectErr('reject duplicate email', `INSERT INTO users (full_name, email, role) VALUES ('X', 'validation.test@example.invalid', 'student')`, [], '23505');
  await expectErr('reject invalid role', `INSERT INTO users (full_name, email, role) VALUES ('X', 'x.validation@example.invalid', 'owner')`, [], '23514');
  await client.query(`DELETE FROM attendance_events WHERE user_id = $1`, [tu.id]);

  // Controlled timestamps on the deployed schema: 10:00-12:30 + 16:00-17:00 Dubai.
  await client.query(
    `INSERT INTO attendance_events (user_id, seq, event_type, event_timestamp) VALUES
       ($1,0,'LOGIN','2026-09-20T06:00:00Z'), ($1,1,'LOGOUT','2026-09-20T08:30:00Z'),
       ($1,2,'LOGIN','2026-09-20T12:00:00Z'), ($1,3,'LOGOUT','2026-09-20T13:00:00Z'),
       ($1,4,'LOGIN','2026-09-24T20:30:00Z'), ($1,5,'LOGOUT','2026-09-24T21:30:00Z')`,
    [tu.id],
  );
  const { rows: pairs } = await client.query(
    `SELECT l.event_date::text AS d, extract(epoch FROM o.event_timestamp - l.event_timestamp)::int AS s
     FROM attendance_events l JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
     WHERE l.user_id = $1 AND l.event_type = 'LOGIN' ORDER BY l.seq`,
    [tu.id],
  );
  const day20 = pairs.filter((p) => p.d === '2026-09-20').reduce((a, p) => a + p.s, 0);
  check('multiple sessions: 10:00-12:30 + 16:00-17:00 = 3h 30m (break excluded)', day20 === 12600, `${day20}s`);
  check('Dubai day: 00:30 Dubai on 25 Sep is dated 25 Sep (not UTC 24 Sep)', pairs[2]?.d === '2026-09-25');
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
check('integrity test data rolled back', (await sql`SELECT count(*)::int AS n FROM users WHERE email = 'validation.test@example.invalid'`)[0].n === 0);

// ============================ DEPLOYED WORKER ============================
section(`Deployed Worker ${base}`);
async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
}

const home = await call('/');
check('frontend loads (/)', home.status === 200 && home.text.includes('Career Services Attendance'));
check('Content-Security-Policy header on pages', /default-src 'self'/.test(home.headers.get('content-security-policy') || ''));
check('app.js and styles.css load', (await call('/app.js')).status === 200 && (await call('/styles.css')).status === 200);
check('deployed frontend is the current version (sign-out warning dialog present)', home.text.includes('Your attendance session is still open. Signing out of the application will not mark your attendance as logged out.'));
check('frontend contains no password / secret material', !/(postgres(ql)?:\/\/|password_hash|DATABASE_URL)/i.test(home.text + (await call('/app.js')).text));
check('API: /api/auth/me without session -> 401', (await call('/api/auth/me')).status === 401);
check('API: /api/admin/attendance without session -> 401', (await call('/api/admin/attendance')).status === 401);
check('API: unknown route -> 404', (await call('/api/does-not-exist')).status === 404);
check('API: cross-origin POST rejected (403)', (await call('/api/auth/login', { method: 'POST', body: { email: 'x@example.invalid', password: 'x' }, headers: { Origin: 'https://evil.example' } })).status === 403);
const probe = await call('/api/auth/login', { method: 'POST', body: { email: 'validation.probe@example.invalid', password: 'not-a-real-password' } });
check('Worker reaches Neon (unknown user -> 401, not 500)', probe.status === 401 && probe.json?.error === 'Invalid email or password.', `status ${probe.status}`);
await sql`DELETE FROM login_failures WHERE email = 'validation.probe@example.invalid'`;

// ---- credentials ----
section('Credentials (passwords typed hidden, kept in memory only)');
const sessions = {};
const passwords = {};
for (const [name, email, role] of USERS) {
  if (role === 'student' && deviceLock) {
    // Signing a student in from this script would lock their account to the
    // script's throwaway device (their first device). Never do that.
    console.log(`SKIP  ${name}: student sign-in not tested (device locking is on; this script would become their first device)`);
    continue;
  }
  const pw = await askHidden(`Password for ${name} (Enter to skip): `);
  if (!pw) {
    console.log(`SKIP  ${name}`);
    continue;
  }
  passwords[email] = pw;
  const bad = await call('/api/auth/login', { method: 'POST', body: { email, password: pw + '-wrong' } });
  check(`${name}: wrong password rejected`, bad.status === 401 && bad.setCookie.length === 0);
  const good = await call('/api/auth/login', { method: 'POST', body: { email, password: pw } });
  const cookie = good.setCookie[0] || '';
  check(`${name}: correct password signs in as ${role}`, good.status === 200 && good.json?.user?.role === role && good.json?.user?.name === name, `status ${good.status}`);
  if (good.status === 200) {
    check(`${name}: cookie HttpOnly; Secure; SameSite=Strict`, /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie));
    check(`${name}: response contains no password or hash`, !good.text.includes(pw) && !/\$2[aby]\$|password/i.test(good.text));
    sessions[email] = good.setCookie.map((c) => c.split(';')[0]).join('; '); // session + device cookie
  }
}

const adminEmails = USERS.filter((u) => u[2] === 'admin').map((u) => u[1]).filter((e) => sessions[e]);
const studentEmails = USERS.filter((u) => u[2] === 'student').map((u) => u[1]).filter((e) => sessions[e]);

// ---- admin ----
section('Admin access');
let overview = null;
for (const email of adminEmails) {
  const name = USERS.find((u) => u[1] === email)[0];
  const ov = await call('/api/admin/attendance', { cookie: sessions[email] });
  const names = (ov.json?.coordinators || []).map((c) => c.name).sort();
  check(`${name}: admin overview lists exactly the 6 coordinators`, ov.status === 200 && JSON.stringify(names) === JSON.stringify(STUDENT_NAMES), names.join(', '));
  if (ov.status === 200) overview = ov.json;
  check(`${name}: has their own 4-digit attendance code`, ov.status === 200 && ov.json.verificationEnabled === true && /^\d{4}$/.test(ov.json.attendanceCode || ''));
  const left = ov.status === 200 ? Date.parse(ov.json.attendanceCodeExpiresAt) - Date.parse(ov.json.serverTime) : -1;
  check(`${name}: code rotates, valid for at most 30 more minutes`, ov.json?.attendanceCodeRotates === true && left > 0 && left <= 30 * 60_000, `expires in ${Math.round(left / 1000)} s`);
}
if (overview) {
  const s = overview.summary;
  check('summary: total / logged in / logged out consistent', s.totalCoordinators === 6 && s.loggedIn + s.loggedOut === 6);
  check('admin response contains no password hashes', !/\$2[aby]\$|password/i.test(JSON.stringify(overview)));
}

// ---- student ----
const idByName = Object.fromEntries((overview?.coordinators || []).map((c) => [c.name, c.id]));
let testEmail = null;
for (const email of studentEmails) {
  const t = await call('/api/attendance/today', { cookie: sessions[email] });
  if (t.json?.state?.status === 'LOGGED_OUT') { testEmail = email; break; }
}
if (!testEmail || !adminEmails.length) {
  section('Student & attendance tests');
  console.log('SKIP  need at least one signed-in admin and one signed-in student who is currently logged out.');
} else {
  const testName = USERS.find((u) => u[1] === testEmail)[0];
  const answer = (await ask(`\nRun attendance tests on ${testName}? A few test LOGIN/LOGOUT events are recorded and then deleted. [y/N] `)).toLowerCase();
  if (answer !== 'y') {
    console.log('SKIP  attendance tests declined.');
  } else {
    section(`Student authorization & attendance (${testName})`);
    const S = () => sessions[testEmail];
    // LOGIN/LOGOUT need an admin's attendance code: the first signed-in admin's current
    // code, fetched again before every request because codes rotate every 30 minutes.
    const adminCookie = sessions[adminEmails[0]];
    const currentCode = async () => (await call('/api/admin/code', { cookie: adminCookie })).json?.attendanceCode;
    const code = await currentCode();
    const mark = async (action, extra = {}) => call(`/api/attendance/${action}`, { method: 'POST', cookie: S(), body: { code: await currentCode(), ...extra } });
    const other = STUDENT_NAMES.find((n) => n !== testName);
    const otherId = idByName[other];
    const [{ now: testStart }] = await sql`SELECT now() AS now`;
    const myId = idByName[testName];
    const eventsSince = async () => sql`SELECT user_id, seq, event_type, event_timestamp, event_date::text AS d FROM attendance_events WHERE user_id = ${myId}::uuid AND created_at >= ${testStart} ORDER BY seq`;
    const otherBefore = (await call(`/api/admin/attendance/${otherId}`, { cookie: adminCookie })).json?.coordinator?.state;

    try {
      check('student -> admin overview 403', (await call('/api/admin/attendance', { cookie: S() })).status === 403);
      check(`student -> ${other}'s admin history 403`, (await call(`/api/admin/attendance/${otherId}`, { cookie: S() })).status === 403);
      const hist = await call(`/api/attendance/history?user_id=${otherId}&userId=${otherId}`, { cookie: S() });
      const today0 = await call(`/api/attendance/today?user_id=${otherId}`, { cookie: S() });
      check('student history with another user_id returns own data only', hist.status === 200 && !hist.text.includes(otherId));
      check('student today with another user_id returns own name', today0.json?.name === testName);

      let r = await mark('login', { code: String((Number(code) + 1) % 10000).padStart(4, '0') });
      check('LOGIN with a wrong code is refused', r.status === 403 && (await eventsSince()).length === 0);
      r = await mark('login', { user_id: otherId });
      check('LOGIN -> exact success message', r.status === 200 && r.json?.message === MSG, `status ${r.status}`);
      const ev1 = await eventsSince();
      check('LOGIN event stored for the signed-in student (user_id in body ignored)', ev1.length === 1 && ev1[0].event_type === 'LOGIN' && ev1[0].user_id === myId);
      check('event date is the Dubai date of the server timestamp', ev1[0] && ev1[0].d === dubaiDate(ev1[0].event_timestamp) && r.json?.event?.date === ev1[0].d);
      check('timestamp has seconds (HH:MM:SS)', /T\d{2}:\d{2}:\d{2}/.test(r.json?.event?.timestamp || ''));
      const otherAfter = (await call(`/api/admin/attendance/${otherId}`, { cookie: adminCookie })).json?.coordinator?.state;
      check(`${other}'s attendance unchanged`, JSON.stringify(otherBefore) === JSON.stringify(otherAfter));
      const t1 = await call('/api/attendance/today', { cookie: S() });
      check('dashboard shows Currently Logged In with login time', t1.json?.state?.status === 'LOGGED_IN' && t1.json.state.openSince === r.json.event.timestamp);
      r = await mark('login');
      check('duplicate LOGIN rejected: "You are already logged in."', r.status === 409 && r.json?.error === 'You are already logged in.');
      check('still exactly one open session', (await eventsSince()).length === 1);

      // Application sign-out must not record an attendance LOGOUT.
      r = await call('/api/auth/logout', { method: 'POST', cookie: S() });
      check('app Sign Out ends the app session', r.status === 200 && (await call('/api/auth/me', { cookie: S() })).status === 401);
      check('app Sign Out did not create an attendance LOGOUT', (await eventsSince()).length === 1);
      const again = await call('/api/auth/login', { method: 'POST', body: { email: testEmail, password: passwords[testEmail] } });
      sessions[testEmail] = [...S().split('; ').filter((c) => c.startsWith('__Host-cs_device=')), ...again.setCookie.map((c) => c.split(';')[0])].filter((c, i, a) => a.findIndex((x) => x.split('=')[0] === c.split('=')[0]) === i).join('; ');
      check('after signing back in, attendance is still open', (await call('/api/attendance/today', { cookie: S() })).json?.state?.status === 'LOGGED_IN');
      const adminView = await call('/api/admin/attendance', { cookie: adminCookie });
      check('admin sees the student as Logged In', adminView.json?.coordinators?.find((c) => c.id === myId)?.state?.status === 'LOGGED_IN');

      r = await mark('logout');
      check('LOGOUT -> exact success message', r.status === 200 && r.json?.message === MSG);
      r = await mark('logout');
      check('duplicate LOGOUT rejected: "You are not currently logged in."', r.status === 409 && r.json?.error === 'You are not currently logged in.');
      const ev2 = await eventsSince();
      check('exactly LOGIN, LOGOUT stored', ev2.map((e) => e.event_type).join() === 'LOGIN,LOGOUT');

      let rs = await Promise.all(Array.from({ length: 5 }, () => mark('login')));
      check('5 simultaneous LOGINs: exactly one succeeds', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 4, rs.map((x) => x.status).join(','));
      rs = await Promise.all(Array.from({ length: 5 }, () => mark('logout')));
      check('5 simultaneous LOGOUTs: exactly one succeeds', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 4, rs.map((x) => x.status).join(','));
      const ev3 = await eventsSince();
      check('no duplicate events: LOGIN, LOGOUT, LOGIN, LOGOUT', ev3.map((e) => e.event_type).join() === 'LOGIN,LOGOUT,LOGIN,LOGOUT');

      const t2 = await call('/api/attendance/today', { cookie: S() });
      const sum = (t2.json?.today?.sessions || []).reduce((a, s) => a + s.seconds, 0);
      check("today's total = sum of the day's sessions", t2.json?.today?.totalSeconds === sum && t2.json.today.sessionCount >= 2);
      const h2 = await call('/api/attendance/history', { cookie: S() });
      check('history includes today', h2.json?.days?.[0]?.date === t2.json?.date);
      const det = await call(`/api/admin/attendance/${myId}`, { cookie: adminCookie });
      check('admin coordinator history shows the same daily total', det.json?.days?.find((d) => d.date === t2.json.date)?.totalSeconds === t2.json.today.totalSeconds);
    } finally {
      const removed = await sql`DELETE FROM attendance_events WHERE user_id = ${myId}::uuid AND created_at >= ${testStart} RETURNING id`;
      const after = await call('/api/attendance/today', { cookie: S() });
      check(`cleanup: ${removed.length} test event(s) removed, ${testName} back to Logged Out`, after.json?.state?.status === 'LOGGED_OUT');
    }
  }
}

// ---- sign out all test sessions ----
for (const cookie of Object.values(sessions)) await call('/api/auth/logout', { method: 'POST', cookie });

closePrompt();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
