// The synthetic demo dataset and the safety barrier around it.
// Runs the real Worker against an in-memory database seeded exactly as `npm run demo` does.
import { DEFAULT_DEMO_PASSWORD, DEMO_EMAILS, seedDemoData } from '../scripts/lib/demo-data.mjs';
import { assertDemoDatabase, assertEmptyActivity, DemoGuardError, requireDemoMode } from '../scripts/lib/demo-guard.mjs';
import { setupDb, startServer } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });
const MSG = 'Your attendance has been marked successfully. Thank you.';

const { db } = await setupDb({ testAccounts: false });
const { server, worker, env } = await startServer(8803);
const q = async (text, params) => (await db.query(text, params)).rows;
const query = (text, params) => db.query(text, params);
const throwsGuard = async (fn) => { try { await fn(); return false; } catch (err) { return err instanceof DemoGuardError; } };

// ---------------- safety barrier ----------------
check('guard: refuses without DEMO_MODE', await throwsGuard(() => requireDemoMode({})));
check('guard: refuses DEMO_MODE other than "true"', await throwsGuard(() => requireDemoMode({ DEMO_MODE: '1' })));
check('guard: accepts DEMO_MODE=true', !(await throwsGuard(() => requireDemoMode({ DEMO_MODE: 'true' }))));
check('guard: a freshly migrated database holds only the demo directory', (await assertDemoDatabase(query)) === 10);
check('guard: an empty database may be seeded', !(await throwsGuard(() => assertEmptyActivity(query))));

const started = Date.now();
const counts = await seedDemoData(query);
check('seed completes', counts.users === 10 && counts.events > 100 && counts.audit > counts.events, JSON.stringify(counts));
check('guard: a seeded database cannot be seeded again', await throwsGuard(() => assertEmptyActivity(query)));

// A database holding anyone outside the demo directory is refused (address built at
// runtime so this file contains no address outside the reserved example domains).
const outsider = 'someone@' + ['university', 'edu'].join('.');
await q('BEGIN');
await q(`INSERT INTO users (full_name, email, role) VALUES ('Outside User', $1, 'student')`, [outsider]);
check('guard: refuses a database with a non-demo account', await throwsGuard(() => assertDemoDatabase(query)));
await q('ROLLBACK');

// ---------------- the data itself ----------------
const users = await q(`SELECT email, password_hash LIKE '$2%' AS bcrypt FROM users ORDER BY email`);
check('exactly the ten demo users, all on example.com', users.length === 10 && users.every((u) => DEMO_EMAILS.includes(u.email)));
check('every demo user has a bcrypt password hash', users.every((u) => u.bcrypt));
const [future] = await q(`SELECT (SELECT count(*) FROM attendance_events WHERE event_timestamp > now())::int AS e,
                                 (SELECT count(*) FROM audit_log WHERE created_at > now())::int AS a,
                                 (SELECT count(*) FROM audit_log WHERE code_issued_at > created_at)::int AS c`);
check('no event, audit entry or code lies in the future', future.e === 0 && future.a === 0 && future.c === 0, JSON.stringify(future));
const [orphans] = await q(`SELECT count(*)::int AS n FROM attendance_events e
                           WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.attendance_event_id = e.id AND a.action = 'ATTENDANCE_' || e.event_type)`);
check('every LOGIN/LOGOUT has its verified audit entry', orphans.n === 0, orphans.n);
const [codes] = await q(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'ATTENDANCE_%' AND (verified_code !~ '^[0-9]{4}$' OR verified_by IS NULL)`);
check('every verified entry names an admin and a 4-digit code', codes.n === 0);
const ips = await q(`SELECT DISTINCT ip_address FROM audit_log WHERE ip_address IS NOT NULL`);
check('all IP addresses are in the documentation range 203.0.113.0/24', ips.length > 0 && ips.every((r) => r.ip_address.startsWith('203.0.113.')));
const actions = new Set((await q(`SELECT DISTINCT action FROM audit_log`)).map((r) => r.action));
for (const a of ['ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT', 'INVALID_ATTENDANCE_CODE', 'DEVICE_SHARING_DETECTED', 'NEW_DEVICE', 'DEVICE_REGISTERED', 'DEVICE_LOGIN_BLOCKED', 'DEVICE_APPROVED', 'DEVICE_DENIED', 'SIGN_IN']) {
  check(`audit trail includes ${a}`, actions.has(a));
}
const statuses = await q(`SELECT u.email, ud.status FROM user_devices ud JOIN users u ON u.id = ud.user_id ORDER BY 1, 2`);
const has = (email, status) => statuses.some((r) => r.email === email && r.status === status);
check('a pending request (Kenji) and a denied device (Lena)', has('kenji.watanabe@example.com', 'pending') && has('lena.fischer@example.com', 'denied'));
check('Maya and Omar have history but no approved device', !has('maya.thompson@example.com', 'approved') && !has('omar.haddad@example.com', 'approved'));
const [unresolved] = await q(`SELECT count(*)::int AS n FROM attendance_events l JOIN attendance_events o ON o.user_id = l.user_id AND o.seq = l.seq + 1
                              WHERE l.event_type = 'LOGIN' AND o.event_date <> l.event_date`);
check('an overnight (unresolved) session exists', unresolved.n >= 1);
const [{ n: newDevice }] = await q(`INSERT INTO devices (device_key) VALUES ('DEV-000000000001') RETURNING id AS n`);
check('identity sequences continue after the seeded ids', Number(newDevice) > counts.devices);
await q(`DELETE FROM devices WHERE device_key = 'DEV-000000000001'`);

// ---------------- the running app on the seeded data ----------------
async function call(path, { method = 'GET', body, cookie } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8803' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const jar = (r) => r.setCookie.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const signIn = (email, cookie) => call('/api/auth/login', { method: 'POST', cookie, body: { email, password: DEFAULT_DEMO_PASSWORD, device: { screenWidth: 1440, screenHeight: 900, timezone: 'Asia/Dubai' } } });

const admin = await signIn('priya.raman@example.com');
check('demo admin signs in with the documented password', admin.status === 200 && admin.json?.user?.role === 'admin');
const A = jar(admin);
const ov = await call('/api/admin/attendance', { cookie: A });
check('admin overview lists the six demo coordinators', ov.status === 200 && ov.json.coordinators.length === 6 && ov.json.deviceApprovalEnabled === true, ov.status);
check('admin overview shows today\'s activity or the start of the day', ov.status === 200 && Array.isArray(ov.json.activity));
check('admin overview counts the pending device request', ov.json?.pendingDeviceRequests === 1, ov.json?.pendingDeviceRequests);
const lena = ov.json.coordinators.find((c) => c.name === 'Lena Fischer');
const hist = await call(`/api/admin/attendance/${lena.id}?from=${new Date(started - 27 * 86_400_000).toISOString().slice(0, 10)}`, { cookie: A });
check('coordinator history spans several weeks with verifying admins', hist.status === 200 && hist.json.days.length >= 8 && hist.json.days.some((d) => d.sessions.some((s) => s.detail?.loginVerifiedBy)), hist.json?.days?.length);
const audit = await call('/api/admin/audit?from=' + new Date(started - 27 * 86_400_000).toISOString().slice(0, 10), { cookie: A });
check('audit API returns the seeded trail', audit.status === 200 && audit.json.entries.length > 50);
check('device API flags the shared lab computer', (await call('/api/admin/devices', { cookie: A })).json?.devices?.some((d) => d.sharedDeviceFlags > 0 && d.potentiallyShared));
const reqs = await call('/api/admin/device-requests', { cookie: A });
check('device requests: one pending, recent decisions listed', reqs.json?.pending?.length === 1 && reqs.json.recent.some((r) => r.status === 'denied'));

const maya = await signIn('maya.thompson@example.com');
check("Maya's first sign-in approves this browser", maya.status === 200);
const M = jar(maya);
const code = (await call('/api/admin/code', { cookie: A })).json?.attendanceCode;
const t0 = await call('/api/attendance/today', { cookie: M });
const first = t0.json?.state?.status === 'LOGGED_IN' ? 'logout' : 'login';
let r = await call(`/api/attendance/${first}`, { method: 'POST', cookie: M, body: { code } });
check(`Maya can ${first.toUpperCase()} with the admin's code`, r.status === 200 && r.json?.message === MSG, r.status);
const kenji = await signIn('kenji.watanabe@example.com');
check('Kenji is device-locked: a new browser gets "New Device detected"', kenji.status === 403 && kenji.json?.error === 'New Device detected - contact admin');

server.close();
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? ' — ' + x.detail : ''}`);
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
process.exit(results.every((x) => x.ok) ? 0 : 1);
