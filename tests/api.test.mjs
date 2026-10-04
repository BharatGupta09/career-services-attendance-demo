// End-to-end API tests of the real Worker code against in-memory PostgreSQL.
import crypto from 'node:crypto';
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); };
const MSG = 'Your attendance has been marked successfully. Thank you.';
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dubaiDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(iso));

const { db, applied } = await setupDb();
const { server, worker, env } = await startServer(8799);
check('all migrations apply cleanly (001-007)', applied.length === 7, applied.join(', '));

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] ??= 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8799' + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
}
// Like a real browser, each person keeps their own device cookie between sign-ins
// (students may sign in only from an approved device once migration 007 exists).
const deviceJar = new Map();
async function signIn(email, password = TEST_PASSWORD) {
  const who = email.trim().toLowerCase();
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password }, cookie: deviceJar.get(who) });
  const dev = r.setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-cs_device='));
  if (dev) deviceJar.set(who, dev);
  const session = r.setCookie[0]?.split(';')[0];
  const cookie = session && deviceJar.get(who) ? `${session}; ${deviceJar.get(who)}` : session;
  return { ...r, cookie };
}
// Attendance now needs an admin's code: CODE is set once the test admin has signed in.
let CODE = null;
const mark = (action, cookie, extra = {}) => call(`/api/attendance/${action}`, { method: 'POST', cookie, body: { code: CODE, device: { screenWidth: 1280, screenHeight: 800, timezone: 'Asia/Dubai' }, ...extra } });
const q = async (text, params) => (await db.query(text, params)).rows;
const uid = async (email) => (await q('SELECT id FROM users WHERE email=$1', [email]))[0].id;
const events = async (id) => q(`SELECT seq, event_type, event_timestamp, event_date::text AS d, (event_timestamp AT TIME ZONE 'Asia/Dubai')::date::text AS dd FROM attendance_events WHERE user_id=$1 ORDER BY seq`, [id]);
async function sqlErr(text, params) { try { await db.query(text, params); return 'no error'; } catch (e) { return e.code; } }

// ---------------- database state after migrations ----------------
const directory = await q(`SELECT full_name, email, role, is_active, password_hash IS NULL AS no_hash FROM users WHERE email NOT LIKE '%@example.test' ORDER BY role DESC, full_name`);
check('exactly 10 directory users after migrations', directory.length === 10);
check('6 students / 4 admins, all active', directory.filter((u) => u.role === 'student').length === 6 && directory.filter((u) => u.role === 'admin').length === 4 && directory.every((u) => u.is_active));
check('directory names exactly as specified', JSON.stringify(directory.map((u) => u.full_name).sort()) === JSON.stringify(['Daniel Okafor', 'Elena Rossi', 'James Carter', 'Kenji Watanabe', 'Lena Fischer', 'Maya Thompson', 'Nadia Hassan', 'Omar Haddad', 'Priya Raman', 'Sofia Marquez'].sort()));
check('no placeholder users remain', (await q(`SELECT count(*)::int n FROM users WHERE email LIKE '%@example.invalid'`))[0].n === 0);
check('directory emails are all on example.com', directory.every((u) => u.email.endsWith('@example.com')));
check('migrations create no password hashes', directory.every((u) => u.no_hash));

// ---------------- unauthenticated ----------------
check('GET /api/auth/me without session -> 401', (await call('/api/auth/me')).status === 401);
check('GET /api/attendance/today without session -> 401', (await call('/api/attendance/today')).status === 401);
check('GET /api/admin/attendance without session -> 401', (await call('/api/admin/attendance')).status === 401);
check('POST /api/attendance/login without session -> 401', (await call('/api/attendance/login', { method: 'POST' })).status === 401);
check('unknown API route -> 404', (await call('/api/nope')).status === 404);

// ---------------- authentication ----------------
let r = await call('/api/auth/login', { method: 'POST', body: { email: 'test.a@example.test', password: 'wrong-password' } });
check('wrong password -> 401 "Invalid email or password."', r.status === 401 && r.json?.error === 'Invalid email or password.' && r.setCookie.length === 0);
r = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'whatever1' } });
check('unknown email -> same 401 message', r.status === 401 && r.json?.error === 'Invalid email or password.');
r = await call('/api/auth/login', { method: 'POST', body: { email: 'maya.thompson@example.com', password: 'anything12' } });
check('user with no password set cannot sign in', r.status === 401);
await q(`DELETE FROM login_failures`);
r = await signIn('test.inactive@example.test');
check('inactive user cannot sign in', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email: 'test.a@example.test', password: TEST_PASSWORD }, headers: { Origin: 'https://evil.example' } });
check('cross-origin sign-in rejected (403)', r.status === 403);
r = await call('/api/auth/login', { method: 'POST', body: 'email=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
check('non-JSON sign-in body rejected (415)', r.status === 415);

const A = await signIn('TEST.A@example.test ');
check('correct credentials -> 200 (email case/space-insensitive)', A.status === 200 && A.json?.user?.role === 'student' && A.json?.user?.name === 'Test Student A');
const ck = A.setCookie[0] || '';
check('cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=43200', /^__Host-cs_session=[A-Za-z0-9_-]{43};/.test(ck) && /HttpOnly/.test(ck) && /Secure/.test(ck) && /SameSite=Strict/.test(ck) && /Max-Age=43200/.test(ck) && /Path=\//.test(ck));
const token = A.cookie.split(';')[0].split('=')[1];
const hashes = await q('SELECT session_token_hash FROM sessions');
check('session token stored only as SHA-256 hash', hashes.some((h) => h.session_token_hash === crypto.createHash('sha256').update(token).digest('hex')) && !hashes.some((h) => h.session_token_hash === token));
check('sign-in response has no password/hash/token', !/password|\$2[aby]\$|session_token/i.test(A.text) && !A.text.includes(token));
const me = await call('/api/auth/me', { cookie: A.cookie });
check('/api/auth/me returns only name, email, role', me.status === 200 && JSON.stringify(Object.keys(me.json.user).sort()) === '["email","name","role"]');

for (let i = 0; i < 5; i++) await call('/api/auth/login', { method: 'POST', body: { email: 'test.c@example.test', password: 'wrong' + i } });
r = await signIn('test.c@example.test');
check('throttle: after 5 failures even the correct password -> 429', r.status === 429);
await q(`DELETE FROM login_failures WHERE email='test.c@example.test'`);

const B = await signIn('test.b@example.test');
const D = await signIn('test.d@example.test');
const ADM = await signIn('test.admin@example.test');
check('admin signs in with role admin', ADM.json?.user?.role === 'admin');
CODE = (await call('/api/admin/attendance', { cookie: ADM.cookie })).json.attendanceCode;
const idA = await uid('test.a@example.test'), idB = await uid('test.b@example.test'), idC = await uid('test.c@example.test');
const idD = await uid('test.d@example.test'), idAdm = await uid('test.admin@example.test');

// ---------------- student authorization ----------------
check('student -> /api/admin/attendance 403', (await call('/api/admin/attendance', { cookie: A.cookie })).status === 403);
check('student -> /api/admin/attendance/:otherId 403', (await call('/api/admin/attendance/' + idB, { cookie: A.cookie })).status === 403);
check('admin -> POST /api/attendance/login 403 (admins do not mark attendance)', (await mark('login', ADM.cookie)).status === 403);
check('B LOGIN ok', (await mark('login', B.cookie)).status === 200);

// ---------------- attendance flow (A) ----------------
r = await mark('login', A.cookie, { user_id: idB });
check('A LOGIN -> 200 with exact success message', r.status === 200 && r.json?.message === MSG);
let evA = await events(idA);
check('LOGIN stored for A (user_id in body ignored)', evA.length === 1 && evA[0].event_type === 'LOGIN' && (await events(idB)).length === 1);
check('event_date equals Asia/Dubai date of timestamp', evA[0].d === evA[0].dd && evA[0].d === dubaiDate(evA[0].event_timestamp));
check('API returns ISO timestamp with seconds + Dubai date', /T\d{2}:\d{2}:\d{2}/.test(r.json.event.timestamp) && r.json.event.date === dubaiDate(r.json.event.timestamp));
const tA = await call('/api/attendance/today', { cookie: A.cookie });
check('today: Currently logged in with login time', tA.json.state.status === 'LOGGED_IN' && tA.json.state.openSince === r.json.event.timestamp && tA.json.today.sessions[0].status === 'open' && tA.json.today.totalSeconds === 0);
r = await mark('login', A.cookie);
check('duplicate LOGIN -> 409 "You are already logged in."', r.status === 409 && r.json.error === 'You are already logged in.');
check('still exactly one event (one open session)', (await events(idA)).length === 1);

const hA = await call('/api/attendance/history?user_id=' + idB, { cookie: A.cookie });
const tA2 = await call('/api/attendance/today?user_id=' + idB + '&userId=' + idB, { cookie: A.cookie });
check('history?user_id=other returns only own data', hA.status === 200 && hA.json.days.length === 1 && hA.json.days[0].sessions.length === 1 && hA.json.days[0].sessions[0].loginAt === tA.json.state.openSince);
check('today?user_id=other returns own name/data', tA2.json.name === 'Test Student A');
check('student responses never contain other user ids', !hA.text.includes(idB) && !tA2.text.includes(idB));

r = await call('/api/auth/logout', { method: 'POST', cookie: A.cookie });
check('app sign-out -> 200 and cookie cleared', r.status === 200 && /Max-Age=0/.test(r.setCookie[0] || ''));
check('old session no longer valid after sign-out', (await call('/api/auth/me', { cookie: A.cookie })).status === 401);
check('app sign-out did NOT create an attendance LOGOUT', (await events(idA)).length === 1);
const A2 = await signIn('test.a@example.test');
check('after signing back in, attendance still open', (await call('/api/attendance/today', { cookie: A2.cookie })).json.state.status === 'LOGGED_IN');

r = await mark('logout', A2.cookie);
check('LOGOUT -> 200 with exact success message', r.status === 200 && r.json.message === MSG);
r = await mark('logout', A2.cookie);
check('duplicate LOGOUT -> 409 "You are not currently logged in."', r.status === 409 && r.json.error === 'You are not currently logged in.');
evA = await events(idA);
check('no duplicate LOGOUT stored', evA.length === 2 && evA[1].event_type === 'LOGOUT');

let rs = await Promise.all(Array.from({ length: 5 }, () => mark('login', A2.cookie)));
check('5 concurrent LOGINs -> exactly 1 success, 4 rejected', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 4);
rs = await Promise.all(Array.from({ length: 5 }, () => mark('logout', A2.cookie)));
check('5 concurrent LOGOUTs -> exactly 1 success, 4 rejected', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 4);
evA = await events(idA);
check('sequence remains LOGIN,LOGOUT,LOGIN,LOGOUT', evA.map((e) => e.event_type).join() === 'LOGIN,LOGOUT,LOGIN,LOGOUT');
const tA3 = await call('/api/attendance/today', { cookie: A2.cookie });
const sum = tA3.json.today.sessions.reduce((s, x) => s + x.seconds, 0);
check('today total = sum of session durations (2 sessions)', tA3.json.today.sessionCount === 2 && tA3.json.today.totalSeconds === sum);

r = await q(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 4, 'LOGIN') ON CONFLICT (user_id, seq) DO NOTHING RETURNING id`, [idA]);
const r2 = await q(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 4, 'LOGIN') ON CONFLICT (user_id, seq) DO NOTHING RETURNING id`, [idA]);
check('same-seq race: second insert is a no-op (unique index)', r.length === 1 && r2.length === 0);
await q(`DELETE FROM attendance_events WHERE user_id=$1 AND seq=4`, [idA]);

const C = await signIn('test.c@example.test');
r = await mark('logout', C.cookie);
check('LOGOUT without LOGIN -> 409', r.status === 409 && r.json.error === 'You are not currently logged in.');

// ---------------- controlled timestamps (D) ----------------
const ins = (seq, type, iso) => q(`INSERT INTO attendance_events (user_id, seq, event_type, event_timestamp) VALUES ($1,$2,$3,$4)`, [idD, seq, type, iso]);
await ins(0, 'LOGIN', '2026-09-20T06:00:00Z'); await ins(1, 'LOGOUT', '2026-09-20T08:30:00Z');
await ins(2, 'LOGIN', '2026-09-20T12:00:00Z'); await ins(3, 'LOGOUT', '2026-09-20T13:00:00Z');
await ins(4, 'LOGIN', '2026-09-21T06:00:05Z'); await ins(5, 'LOGOUT', '2026-09-21T06:00:22Z');
await ins(6, 'LOGIN', '2026-09-21T19:30:00Z'); await ins(7, 'LOGOUT', '2026-09-21T20:15:00Z');
await ins(8, 'LOGIN', '2026-09-24T20:30:00Z'); await ins(9, 'LOGOUT', '2026-09-24T21:30:00Z');
await ins(10, 'LOGIN', '2026-09-26T14:30:00Z');
// sub-second precision: 10:00:00.900 -> 12:30:00.100 on 19 Sep must be exactly 2h 30m, as displayed
const idF = await uid('test.inactive@example.test');
await q(`INSERT INTO attendance_events (user_id, seq, event_type, event_timestamp) VALUES ($1,0,'LOGIN','2026-09-19T06:00:00.900Z'),($1,1,'LOGOUT','2026-09-19T08:30:00.100Z')`, [idF]);
const detF = await call(`/api/admin/attendance/${idF}?from=2026-09-19&to=2026-09-19`, { cookie: (await signIn('test.admin@example.test')).cookie });
check('duration matches displayed HH:MM:SS (sub-second timestamps)', detF.json?.days?.[0]?.totalSeconds === 9000, JSON.stringify(detF.json?.days?.[0]?.totalSeconds));

const hD = await call('/api/attendance/history?from=2026-09-20&to=2026-09-26', { cookie: D.cookie });
const day = (d) => hD.json.days.find((x) => x.date === d);
const d20 = day('2026-09-20');
check('multi-session day: 10:00-12:30 + 16:00-17:00 = 12600 s (3h 30m)', d20 && d20.totalSeconds === 12600 && d20.sessionCount === 2);
check('break not counted (not last logout - first login = 25200 s)', d20 && d20.totalSeconds !== 25200);
check('session times display as HH:MM:SS Dubai', d20 && d20.sessions.map((s) => fmtTime.format(new Date(s.loginAt)) + '-' + fmtTime.format(new Date(s.logoutAt))).join() === '10:00:00-12:30:00,16:00:00-17:00:00');
const d21 = day('2026-09-21');
check('seconds preserved: 10:00:05 -> 10:00:22 = 17 s', d21 && d21.sessions[0].seconds === 17 && d21.sessions[0].status === 'complete');
check('overnight 23:30 -> 00:15 flagged unresolved and excluded', d21 && d21.sessions[1].status === 'unresolved' && d21.sessions[1].seconds === 0 && d21.totalSeconds === 17 && d21.hasUnresolved);
check('overnight logout not attributed to next day', !day('2026-09-22'));
check('00:30 Dubai belongs to Dubai date (25 Sep), not UTC (24 Sep)', day('2026-09-25')?.totalSeconds === 3600 && !day('2026-09-24'));
check('history ordered most recent first', hD.json.days.map((x) => x.date).join() === '2026-09-26,2026-09-25,2026-09-21,2026-09-20');
const tD = await call('/api/attendance/today', { cookie: D.cookie });
check('open session from previous day: LOGGED_IN + openOvernight, not counted', tD.json.state.status === 'LOGGED_IN' && tD.json.state.openOvernight === true && day('2026-09-26').sessions[0].status === 'unresolved' && day('2026-09-26').totalSeconds === 0);
r = await mark('logout', D.cookie);
check('overnight open session can be closed with LOGOUT (no invented time)', r.status === 200);

check('from > to -> 400', (await call('/api/attendance/history?from=2026-09-26&to=2026-09-20', { cookie: D.cookie })).status === 400);
check('bad date format -> 400', (await call('/api/attendance/history?from=2026-9-1&to=2026-09-20', { cookie: D.cookie })).status === 400);
check('range > 1 year -> 400', (await call('/api/attendance/history?from=2024-01-01&to=2026-09-20', { cookie: D.cookie })).status === 400);
check('SQL-ish input rejected as invalid date', (await call("/api/attendance/history?from=2026-09-01'%20OR%201=1--&to=2026-09-20", { cookie: D.cookie })).status === 400);

// ---------------- admin ----------------
const ov = await call('/api/admin/attendance', { cookie: ADM.cookie });
const names = ov.json.coordinators.map((c) => c.name);
check('admin overview 200 lists all active students, no admins/inactive', ov.status === 200 && ['Maya Thompson', 'Omar Haddad', 'Lena Fischer', 'Daniel Okafor', 'Sofia Marquez', 'Kenji Watanabe', 'Test Student A'].every((n) => names.includes(n)) && !names.includes('Priya Raman') && !names.includes('Test Admin') && !names.includes('Test Inactive'));
const cB = ov.json.coordinators.find((c) => c.name === 'Test Student B');
const cA = ov.json.coordinators.find((c) => c.name === 'Test Student A');
check('admin sees B logged in, A logged out with 2 sessions + first/last', cB.state.status === 'LOGGED_IN' && cA.state.status === 'LOGGED_OUT' && cA.sessionCount === 2 && cA.firstLogin && cA.lastLogout);
check('summary counts consistent', ov.json.summary.totalCoordinators === ov.json.coordinators.length && ov.json.summary.loggedIn + ov.json.summary.loggedOut === ov.json.summary.totalCoordinators && ov.json.summary.loggedIn === ov.json.coordinators.filter((c) => c.state.status === 'LOGGED_IN').length);
check('summary today total = sum of coordinators', ov.json.summary.todayTotalSeconds === ov.json.coordinators.reduce((s, c) => s + c.todayTotalSeconds, 0));
check('activity feed lists today events (count matches)', ov.json.activity.length === ov.json.summary.todayEvents && ov.json.activity.length >= 5);
const det = await call(`/api/admin/attendance/${idD}?from=2026-09-20&to=2026-09-21`, { cookie: ADM.cookie });
check('admin coordinator history: dates, sessions, daily totals', det.status === 200 && det.json.coordinator.name === 'Test Student D' && det.json.days.find((x) => x.date === '2026-09-20')?.totalSeconds === 12600);
check('admin history: invalid id -> 404', (await call('/api/admin/attendance/not-a-uuid', { cookie: ADM.cookie })).status === 404);
check('admin history: unknown uuid -> 404', (await call('/api/admin/attendance/' + crypto.randomUUID(), { cookie: ADM.cookie })).status === 404);
check('admin history: an admin id is not a coordinator -> 404', (await call('/api/admin/attendance/' + idAdm, { cookie: ADM.cookie })).status === 404);
check('admin responses contain no password hashes', !/\$2[aby]\$|password/i.test(ov.text + det.text));

// ---------------- session expiry / deactivation ----------------
await q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [idB]);
r = await call('/api/attendance/today', { cookie: B.cookie });
check('expired session -> 401 "Your session has expired. Please log in again."', r.status === 401 && r.json.error === 'Your session has expired. Please log in again.');
await q(`UPDATE users SET is_active=false WHERE id=$1`, [idD]);
check('deactivated user loses access immediately', (await call('/api/auth/me', { cookie: D.cookie })).status === 401);
await q(`UPDATE users SET is_active=true WHERE id=$1`, [idD]);
const E = await signIn('test.b@example.test');
check('expired sessions purged on next sign-in', E.status === 200 && (await q(`SELECT count(*)::int n FROM sessions WHERE expires_at <= now()`))[0].n === 0);

// ---------------- data integrity (constraints) ----------------
check('invalid user_id -> FK violation (23503)', (await sqlErr(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGIN')`, [crypto.randomUUID()])) === '23503');
check('invalid event_type -> check violation (23514)', (await sqlErr(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 50, 'BREAK')`, [idC])) === '23514');
check('LOGOUT at LOGIN position -> check violation (23514)', (await sqlErr(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGOUT')`, [idC])) === '23514');
check('duplicate (user, seq) -> unique violation (23505)', (await sqlErr(`INSERT INTO attendance_events (user_id, seq, event_type) VALUES ($1, 0, 'LOGIN')`, [idA])) === '23505');
check('event_date cannot be written directly (generated)', (await sqlErr(`INSERT INTO attendance_events (user_id, seq, event_type, event_date) VALUES ($1, 0, 'LOGIN', '2000-01-01')`, [idC])) !== 'no error');
check('duplicate email rejected (23505)', (await sqlErr(`INSERT INTO users (full_name, email, role) VALUES ('X', 'test.a@example.test', 'student')`)) === '23505');
check('invalid role rejected (23514)', (await sqlErr(`INSERT INTO users (full_name, email, role) VALUES ('X', 'x1@example.test', 'owner')`)) === '23514');
check('non-lowercase email rejected (23514)', (await sqlErr(`INSERT INTO users (full_name, email, role) VALUES ('X', 'X2@Example.test', 'student')`)) === '23514');
check('user with attendance cannot be deleted (RESTRICT, 23001)', (await sqlErr(`DELETE FROM users WHERE id=$1`, [idA])) === '23001');

// ---------------- efficiency ----------------
async function countQueries(fn) { const before = globalThis.__QUERY_COUNT__; await fn(); return globalThis.__QUERY_COUNT__ - before; }
const nToday = await countQueries(() => call('/api/attendance/today', { cookie: E.cookie }));
const nMark = await countQueries(() => mark('login', E.cookie));
const nAdmin = await countQueries(() => call('/api/admin/attendance', { cookie: ADM.cookie }));
const nSignIn = await countQueries(() => signIn('test.c@example.test'));
check(`DB round trips per request: today=${nToday}, mark=${nMark}, admin=${nAdmin}, sign-in=${nSignIn}`, nToday <= 2 && nMark <= 2 && nAdmin <= 2 && nSignIn <= 2);

// ---------------- headers / frontend ----------------
check('API responses: no-store, nosniff, DENY', ov.headers.get('cache-control') === 'no-store' && ov.headers.get('x-content-type-options') === 'nosniff' && ov.headers.get('x-frame-options') === 'DENY');
const idx = await worker.fetch(new Request('http://localhost:8799/'), env);
check('frontend served for /', idx.status === 200 && (await idx.text()).includes('Career Services Attendance'));

server.close();
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail && !x.ok ? '  — ' + x.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
