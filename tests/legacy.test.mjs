// Before migration 005: the new Worker must behave exactly like V1.
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';
const results = []; const check = (n, c, d = '') => results.push({ n, ok: !!c, d });
const { db, applied } = await setupDb();
const { server, worker, env } = await startServer(8797);
async function call(path, { method = 'GET', body, cookie } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8797' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const signIn = async (email) => { const r = await call('/api/auth/login', { method: 'POST', body: { email, password: TEST_PASSWORD } }); return { r, cookie: r.setCookie[0]?.split(';')[0] }; };
check('database has only migrations 001-004', applied.length === 4 && !applied.some((f) => f.startsWith('005')), applied.join());
const S = await signIn('test.a@example.test'), ADM = await signIn('test.admin@example.test');
check('student and admin sign in (no attendance_code column needed)', S.r.status === 200 && ADM.r.status === 200);
const t = await call('/api/attendance/today', { cookie: S.cookie });
check('today works and reports no code required', t.status === 200 && t.json.verificationRequired === false);
let r = await call('/api/attendance/login', { method: 'POST', cookie: S.cookie });
check('V1 LOGIN without a code still works', r.status === 200 && r.json.message === 'Your attendance has been marked successfully. Thank you.');
r = await call('/api/attendance/logout', { method: 'POST', cookie: S.cookie });
check('V1 LOGOUT without a code still works', r.status === 200);
const ov = await call('/api/admin/attendance', { cookie: ADM.cookie });
check('admin overview works: verification disabled, no code', ov.status === 200 && ov.json.verificationEnabled === false && ov.json.attendanceCode === null && ov.json.coordinators.length >= 6);
const aid = ov.json.coordinators.find((c) => c.name === 'Test Student A').id;
const h = await call(`/api/admin/attendance/${aid}`, { cookie: ADM.cookie });
check('admin coordinator history works', h.status === 200 && h.json.days[0].sessions.length === 1 && !h.json.days[0].sessions[0].detail);
check('audit / devices report "database update needed" (409), not a crash', (await call('/api/admin/audit', { cookie: ADM.cookie })).status === 409 && (await call('/api/admin/devices', { cookie: ADM.cookie })).status === 409);
server.close();
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${!x.ok && x.d ? ' — ' + x.d : ''}`);
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`); process.exit(results.every((x) => x.ok) ? 0 : 1);
