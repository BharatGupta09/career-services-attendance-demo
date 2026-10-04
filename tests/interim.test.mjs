// Migration 005 applied, 006 not yet: the new Worker must keep today's
// behaviour (one code per admin session) and must not touch the 006 columns.
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';
const results = []; const check = (n, c, d = '') => results.push({ n, ok: !!c, d });
const { db, applied } = await setupDb();
const { server, worker, env } = await startServer(8794);
const q = async (text, params) => (await db.query(text, params)).rows;
async function call(p, { method = 'GET', body, cookie } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8794' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const signIn = async (email) => { const r = await call('/api/auth/login', { method: 'POST', body: { email, password: TEST_PASSWORD } }); return { r, cookie: r.setCookie.map((c) => c.split(';')[0]).join('; ') }; };
const mark = (b, action, code) => call(`/api/attendance/${action}`, { method: 'POST', cookie: b.cookie, body: { code, device: {} } });

check('database has migrations 001-005 only', applied.length === 5 && applied[4].startsWith('005'), applied.join());
const ADM = await signIn('test.admin@example.test'), S = await signIn('test.a@example.test');
check('admin and student sign in', ADM.r.status === 200 && S.r.status === 200);
const ov = await call('/api/admin/attendance', { cookie: ADM.cookie });
check('admin has a code valid for the whole session (no rotation yet)', ov.status === 200 && /^\d{4}$/.test(ov.json.attendanceCode) && ov.json.attendanceCodeRotates === false && ov.json.attendanceCodeExpiresAt === ov.json.sessionExpiresAt);
const code = ov.json.attendanceCode;
const c = await call('/api/admin/code', { cookie: ADM.cookie });
check('GET /api/admin/code returns the same code', c.status === 200 && c.json.attendanceCode === code);
let r = await mark(S, 'login', code);
check('LOGIN with the code works', r.status === 200);
r = await mark(S, 'logout', String((Number(code) + 1) % 10000).padStart(4, '0'));
check('a wrong code is refused', r.status === 403);
const good = (await q(`SELECT * FROM audit_log WHERE action = 'ATTENDANCE_LOGIN'`))[0];
check('successful use audited with admin and admin session (005 columns only)', good && good.verified_by && good.admin_session_ref && !('verified_code' in good));
const aud = await call('/api/admin/audit', { cookie: ADM.cookie });
check('audit trail works and reports no code (column not there yet)', aud.status === 200 && aud.json.entries.every((e) => e.codeUsed === null));
await q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE attendance_code = $1`, [code]);
r = await mark(S, 'logout', code);
check('code of an expired admin session is refused as expired', r.status === 403 && /expired/.test(r.json.error));
server.close();
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${!x.ok && x.d ? ' — ' + x.d : ''}`);
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`); process.exit(results.every((x) => x.ok) ? 0 : 1);
