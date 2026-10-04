// Revoking access for every user with the existing users.is_active flag
// (docs/DEPLOYMENT.md, "Temporarily revoking access"). Test fixtures only.
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });
const REVOKE_SQL = 'UPDATE users SET is_active = false WHERE is_active';

const { db } = await setupDb();
const { server, worker, env } = await startServer(8793);
const q = async (text, params) => (await db.query(text, params)).rows;
async function call(path, { method = 'GET', body, cookie } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8793' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const signIn = async (email) => { const r = await call('/api/auth/login', { method: 'POST', body: { email, password: TEST_PASSWORD } }); return { r, cookie: r.setCookie.map((c) => c.split(';')[0]).join('; ') }; };
const mark = (b, action, code) => call(`/api/attendance/${action}`, { method: 'POST', cookie: b.cookie, body: { code, device: { screenWidth: 1280, screenHeight: 800, timezone: 'Asia/Dubai' } } });

// Some history to protect: a code-verified LOGIN and LOGOUT, an invalid attempt, devices, audit rows.
const S = await signIn('test.a@example.test'), ADM = await signIn('test.admin@example.test');
const code = (await call('/api/admin/code', { cookie: ADM.cookie })).json.attendanceCode;
await mark(S, 'login', String((Number(code) + 1) % 10000).padStart(4, '0'));
await mark(S, 'login', code);
await mark(S, 'logout', code);
await mark(S, 'login', code); // leave one session open
await q(`INSERT INTO attendance_events (user_id, seq, event_type, event_timestamp) SELECT id, 0, 'LOGIN', '2026-09-20T06:00:00Z' FROM users WHERE email = 'test.b@example.test'`);

const snapshot = async () => ({
  users: await q(`SELECT id, full_name, email, role, password_hash, created_at FROM users ORDER BY id`),
  events: await q(`SELECT * FROM attendance_events ORDER BY id`),
  audit: await q(`SELECT * FROM audit_log ORDER BY id`),
  devices: await q(`SELECT * FROM devices ORDER BY id`),
  userDevices: await q(`SELECT * FROM user_devices ORDER BY user_id, device_id`),
});
const before = await snapshot();
check('fixture history exists (events, audit rows, devices, both roles)', before.events.length >= 4 && before.audit.length >= 3 && before.devices.length >= 1 && before.users.some((u) => u.role === 'admin') && before.users.some((u) => u.role === 'student'));
check('sessions are live before revocation', (await call('/api/attendance/today', { cookie: S.cookie })).status === 200 && (await call('/api/admin/attendance', { cookie: ADM.cookie })).status === 200);

// ---- the revocation ----
const activeBefore = (await q(`SELECT count(*)::int n FROM users WHERE is_active`))[0].n;
const res = await db.query(REVOKE_SQL);
check('revocation statement deactivates every active user', res.affectedRows === activeBefore && activeBefore > 0, `${res.affectedRows} of ${activeBefore}`);

// 1. every user inactive
check('1. all users are inactive (students and admins)', (await q(`SELECT count(*)::int n FROM users WHERE is_active`))[0].n === 0);

// 2-3. sign-in refused, no session created
const sessionsBefore = (await q(`SELECT count(*)::int n FROM sessions`))[0].n;
const sLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'test.a@example.test', password: TEST_PASSWORD } });
const aLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'test.admin@example.test', password: TEST_PASSWORD } });
check('2. student sign-in with the correct password is refused (401)', sLogin.status === 401 && sLogin.json.error === 'Invalid email or password.' && !sLogin.setCookie.some((c) => c.startsWith('__Host-cs_session=') && !c.includes('Max-Age=0')));
check('3. admin sign-in with the correct password is refused (401)', aLogin.status === 401 && aLogin.json.error === 'Invalid email or password.');
check('2-3. refused sign-ins create no session', (await q(`SELECT count(*)::int n FROM sessions`))[0].n <= sessionsBefore);

// 4. existing sessions no longer work
const expired = 'Your session has expired. Please log in again.';
const studentCalls = [['GET', '/api/attendance/today'], ['GET', '/api/attendance/history'], ['POST', '/api/attendance/logout']];
const adminCalls = [['GET', '/api/admin/attendance'], ['GET', '/api/admin/code'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/devices']];
const sr = await Promise.all(studentCalls.map(([m, p]) => call(p, { method: m, cookie: S.cookie, body: m === 'POST' ? { code } : undefined })));
const ar = await Promise.all(adminCalls.map(([m, p]) => call(p, { method: m, cookie: ADM.cookie })));
check('4. existing student session: protected endpoints return 401', sr.every((r) => r.status === 401 && r.json.error === expired), sr.map((r) => r.status).join());
check('4. existing admin session: protected endpoints return 401 (no code handed out)', ar.every((r) => r.status === 401 && !r.json.attendanceCode), ar.map((r) => r.status).join());
check('4. /api/auth/me reports not signed in for both', (await call('/api/auth/me', { cookie: S.cookie })).status === 401 && (await call('/api/auth/me', { cookie: ADM.cookie })).status === 401);

// 5-9. nothing else changed
const after = await snapshot();
const same = (k) => JSON.stringify(before[k]) === JSON.stringify(after[k]);
check('5-6. names, emails, roles and password hashes unchanged; no user deleted', same('users'));
check('7. attendance events unchanged (including the open session)', same('events') && (await q(`SELECT count(*)::int n FROM attendance_events`))[0].n === before.events.length);
check('8. audit log unchanged (no rows added by the revocation or by refused requests)', same('audit'));
check('devices and device associations unchanged', same('devices') && same('userDevices'));
check('running the statement again changes nothing', (await db.query(REVOKE_SQL)).affectedRows === 0);

// An inactive admin's code cannot verify attendance even for a student who is active.
await q(`UPDATE users SET is_active = true WHERE email = 'test.c@example.test'`);
const C = await signIn('test.c@example.test');
const r = await mark(C, 'login', code);
check("an inactive admin's attendance code no longer verifies attendance", C.r.status === 200 && r.status === 403 && (await q(`SELECT count(*)::int n FROM attendance_events e JOIN users u ON u.id = e.user_id WHERE u.email = 'test.c@example.test'`))[0].n === 0);

server.close();
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? '  — ' + x.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
