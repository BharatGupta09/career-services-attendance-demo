// Rotating attendance codes (migration 006): a new code every 30 minutes per
// admin session. Time is moved by rewriting the session's code timestamps in the
// in-memory database; the Worker itself always uses the database clock.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { P, setupDb, startServer, TEST_PASSWORD } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });
const MSG = 'Your attendance has been marked successfully. Thank you.';
const INVALID = 'Invalid attendance code. Please obtain the current code from an authorized admin.';
const EXPIRED = 'This attendance code has expired. Please obtain the current code from an authorized admin.';
const WINDOW_MS = 30 * 60 * 1000;

const { db, applied } = await setupDb();
const { server, worker, env } = await startServer(8795);
const q = async (text, params) => (await db.query(text, params)).rows;
check('migration 006 applied on top of 001-005', applied.length === 6 && applied[5] === '006_rotating_attendance_codes.sql', applied.join());
await q(`INSERT INTO users (full_name, email, role, password_hash) VALUES ('Test Admin 2', 'test.admin2@example.test', 'admin', crypt($1, gen_salt('bf', 10)))`, [TEST_PASSWORD]);
await q(`UPDATE users SET is_active = true WHERE email = 'test.inactive@example.test'`);

async function call(p, { method = 'GET', body, cookie } = {}) {
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8795' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
}
const cookieVal = (list, name) => list.map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));
async function browser(email, device = null) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password: TEST_PASSWORD }, cookie: device || undefined });
  const session = cookieVal(r.setCookie, '__Host-cs_session');
  const dev = device || cookieVal(r.setCookie, '__Host-cs_device');
  return { r, session, device: dev, jar: [session, dev].filter(Boolean).join('; ') };
}
const mark = (b, action, code) => call(`/api/attendance/${action}`, { method: 'POST', cookie: b.jar, body: { code, device: { screenWidth: 1280, screenHeight: 800, timezone: 'Asia/Dubai' } } });
const codeInfo = async (b) => (await call('/api/admin/code', { cookie: b.jar })).json;
const uid = async (email) => (await q('SELECT id FROM users WHERE email = $1', [email]))[0].id;
const sessionRow = async (id) => (await q('SELECT * FROM sessions WHERE id = $1', [id]))[0];
// Move a code's 30-minute window into the past: "the code was generated `ago` ago".
const ageCode = (sessionId, ago) => q(`UPDATE sessions SET attendance_code_issued_at = now() - $2::interval WHERE id = $1`, [sessionId, ago]);
const auditCount = async () => (await q('SELECT count(*)::int n FROM audit_log'))[0].n;
const events = (id) => q('SELECT seq, event_type, verified_by FROM attendance_events WHERE user_id = $1 ORDER BY seq', [id]);
const lastAudit = async (action, id) => (await q('SELECT * FROM audit_log WHERE action = $1 AND actor_user_id = $2 ORDER BY id DESC LIMIT 1', [action, id]))[0];

const idA = await uid('test.a@example.test'), idB = await uid('test.b@example.test'), idC = await uid('test.c@example.test');
const idD = await uid('test.d@example.test'), idE = await uid('test.inactive@example.test');
const idAdm = await uid('test.admin@example.test'), idAdm2 = await uid('test.admin2@example.test');

// ---------------- 1-2. code generated at admin login ----------------
const auditBeforeLogin = await auditCount();
const ADM = await browser('test.admin@example.test');
const atLogin = (await q(`SELECT s.*, now() - s.attendance_code_issued_at AS age FROM sessions s WHERE s.user_id = $1`, [idAdm]))[0];
check('1. admin sign-in generates a code, stored on the session with its generation time', atLogin && /^\d{4}$/.test(atLogin.attendance_code) && atLogin.attendance_code_issued_at && Date.now() - atLogin.attendance_code_issued_at.getTime() < 10_000);
check('1. signing in writes nothing to the audit trail', (await auditCount()) === auditBeforeLogin);
const first = await codeInfo(ADM);
check('2. code is exactly 4 digits and is the one generated at sign-in (dashboard does not replace it)', /^\d{4}$/.test(first.attendanceCode) && first.attendanceCode === atLogin.attendance_code && first.attendanceCodeIssuedAt === atLogin.attendance_code_issued_at.toISOString());
check('2. the database refuses a code that is not 4 digits', await q(`UPDATE sessions SET attendance_code = '123' WHERE id = $1`, [atLogin.id]).then(() => false, (e) => /check/i.test(e.message)));
check('window is exactly 30 minutes from generation, reported separately from the 12-hour session', Date.parse(first.attendanceCodeExpiresAt) - Date.parse(first.attendanceCodeIssuedAt) === WINDOW_MS && first.attendanceCodeRotates === true && first.codeWindowMinutes === 30 && Date.parse(first.sessionExpiresAt) - Date.parse(first.attendanceCodeIssuedAt) > 11 * 3600_000);
const ov = await call('/api/admin/attendance', { cookie: ADM.jar });
check('dashboard overview shows the same code and its own 30-minute expiry (not the session expiry)', ov.json.attendanceCode === first.attendanceCode && ov.json.attendanceCodeExpiresAt === first.attendanceCodeExpiresAt && ov.json.attendanceCodeExpiresAt !== ov.json.sessionExpiresAt);
check('code response is not cacheable', (await call('/api/admin/code', { cookie: ADM.jar })).headers.get('cache-control') === 'no-store');

// ---------------- 3. cryptographically random ----------------
const src = await Promise.all((await readdir(path.join(P, 'src'))).map((f) => readFile(path.join(P, 'src', f), 'utf8')));
const verSrc = await readFile(path.join(P, 'src', 'verification.ts'), 'utf8');
check('3. codes come from crypto.getRandomValues (rejection sampling); Math.random is used nowhere in the Worker', /crypto\.getRandomValues\(buf\)/.test(verSrc) && /v < 60000/.test(verSrc) && !src.some((t) => /Math\.random/.test(t)));
const drawn = [];
let prev = first.attendanceCode, consecutiveSame = 0;
for (let i = 0; i < 300; i++) {
  await ageCode(atLogin.id, '30 minutes');
  const c = (await codeInfo(ADM)).attendanceCode;
  if (c === prev) consecutiveSame++;
  drawn.push(c); prev = c;
}
const leading = Array.from({ length: 10 }, (_, d) => drawn.filter((c) => c[0] === String(d)).length);
check('3. 300 rotations: all 4 digits, never the same code twice in a row, spread over 0000-9999', drawn.every((c) => /^\d{4}$/.test(c)) && consecutiveSame === 0 && new Set(drawn).size >= 270 && leading.every((n) => n >= 10 && n <= 55), `distinct=${new Set(drawn).size} leading=${leading}`);

// ---------------- 4-8. rotation ----------------
const A = await browser('test.a@example.test');
let codeA = (await codeInfo(ADM)).attendanceCode;
await ageCode(atLogin.id, '29 minutes 55 seconds');
let info = await codeInfo(ADM);
check('4. before 30 minutes the code is unchanged (no early rotation)', info.attendanceCode === codeA);
let r = await mark(A, 'login', codeA);
check('4. code still accepted at 29:55', r.status === 200 && r.json.message === MSG);
const okA = await lastAudit('ATTENDANCE_LOGIN', idA);
const issuedA = (await sessionRow(atLogin.id)).attendance_code_issued_at;

await ageCode(atLogin.id, '30 minutes');
const auditBeforeExpired = await auditCount();
r = await mark(A, 'logout', codeA);
check('5. at exactly 30 minutes the code is refused with the "expired" message', r.status === 403 && r.json.error === EXPIRED && (await events(idA)).length === 1);
const expiredAudit = await lastAudit('INVALID_ATTENDANCE_CODE', idA);
check('5. expired attempt audited as INVALID_ATTENDANCE_CODE (reason expired), no code stored', (await auditCount()) === auditBeforeExpired + 1 && expiredAudit.result === 'FAILED' && expiredAudit.metadata.reason === 'expired_code' && expiredAudit.metadata.attempted_action === 'LOGOUT' && expiredAudit.verified_code === null && !JSON.stringify(expiredAudit.metadata).includes(codeA));

info = await codeInfo(ADM);
const codeB = info.attendanceCode;
check('6. after expiry the dashboard receives a new random code with a fresh 30-minute window', /^\d{4}$/.test(codeB) && codeB !== codeA && Date.now() - Date.parse(info.attendanceCodeIssuedAt) < 10_000 && Date.parse(info.attendanceCodeExpiresAt) - Date.parse(info.attendanceCodeIssuedAt) === WINDOW_MS);
check('6. the old code is overwritten, not kept: the session holds only the new one', (await q('SELECT attendance_code FROM sessions WHERE id = $1', [atLogin.id]))[0].attendance_code === codeB && (await q('SELECT 1 FROM sessions WHERE attendance_code = $1', [codeA])).length === 0);
r = await mark(A, 'logout', codeA);
check('7. old code cannot be used after rotation', r.status === 403 && r.json.error === INVALID && (await events(idA)).length === 1);
r = await mark(A, 'logout', codeB);
check('8. the new code is accepted', r.status === 200 && r.json.message === MSG);

// ---------------- 10-12. what a used code leaves behind ----------------
const okB = await lastAudit('ATTENDANCE_LOGOUT', idA);
const devA = (await q('SELECT id FROM devices WHERE device_key = $1', [A.device.split('=')[1]]))[0].id;
check('10. used code A permanently recorded: student, LOGIN, time, device, admin, admin session, code, window start', okA.actor_user_id === idA && okA.result === 'SUCCESS' && okA.created_at && okA.device_id === devA && okA.verified_by === idAdm && okA.admin_session_ref === atLogin.id && okA.verified_code === codeA && okA.code_issued_at.getTime() === issuedA.getTime());
check('11-12. LOGIN used code A and LOGOUT used code B; both kept independently', okB.verified_code === codeB && okB.verified_code !== okA.verified_code && okB.code_issued_at > okA.code_issued_at && okB.admin_session_ref === atLogin.id && (await events(idA)).map((e) => e.event_type).join() === 'LOGIN,LOGOUT');
const hist = await call(`/api/admin/attendance/${idA}`, { cookie: ADM.jar });
check('admin history still shows who verified each side', hist.json.days[0].sessions[0].detail.loginVerifiedBy === 'Test Admin' && hist.json.days[0].sessions[0].detail.logoutVerifiedBy === 'Test Admin');
const aud = await call('/api/admin/audit', { cookie: ADM.jar });
check('admin audit trail shows the code used on successful entries only', aud.json.entries.some((e) => e.action === 'ATTENDANCE_LOGIN' && e.codeUsed === codeA) && aud.json.entries.filter((e) => e.action === 'INVALID_ATTENDANCE_CODE').every((e) => e.codeUsed === null) && aud.json.entries.some((e) => e.codeExpired === true));
check('the database refuses a code on anything but a successful LOGIN/LOGOUT', await q(`INSERT INTO audit_log (action, result, actor_user_id, verified_code, code_issued_at) VALUES ('INVALID_ATTENDANCE_CODE', 'FAILED', $1, '1234', now())`, [idA]).then(() => false, (e) => /check/i.test(e.message)));

// ---------------- 9. unused codes leave nothing ----------------
const beforeUnused = await auditCount();
const usedCodes = new Set((await q('SELECT verified_code FROM audit_log WHERE verified_code IS NOT NULL')).map((x) => x.verified_code));
const unused = [];
for (let i = 0; i < 5; i++) {
  await ageCode(atLogin.id, '31 minutes');
  unused.push((await codeInfo(ADM)).attendanceCode);
}
const kept = (await q('SELECT count(*)::int n FROM sessions WHERE user_id = $1 AND attendance_code IS NOT NULL', [idAdm]))[0].n;
const recorded = (await q('SELECT verified_code FROM audit_log WHERE verified_code = ANY($1::text[])', [unused.filter((c) => !usedCodes.has(c))])).length;
check('9. five codes generated and expired unused: no audit rows, no code history, one code on the session', (await auditCount()) === beforeUnused && recorded === 0 && kept === 1, `audit ${beforeUnused}->${await auditCount()}, kept=${kept}`);

// ---------------- 13, 16. two admins ----------------
const ADM2 = await browser('test.admin2@example.test');
const s2 = await codeInfo(ADM2);
const s1 = await codeInfo(ADM);
check('16. two signed-in admins have different codes with their own windows', s1.attendanceCode !== s2.attendanceCode && s1.attendanceCodeIssuedAt !== s2.attendanceCodeIssuedAt);
const adm2Session = (await q('SELECT id FROM sessions WHERE user_id = $1', [idAdm2]))[0].id;
await ageCode(atLogin.id, '30 minutes');
const s1b = await codeInfo(ADM);
const s2b = await codeInfo(ADM2);
check("16. rotating one admin's code does not touch the other's", s1b.attendanceCode !== s1.attendanceCode && s2b.attendanceCode === s2.attendanceCode && s2b.attendanceCodeIssuedAt === s2.attendanceCodeIssuedAt);
const B = await browser('test.b@example.test');
r = await mark(B, 'login', s1b.attendanceCode);
const r2 = await mark(B, 'logout', s2b.attendanceCode);
const evB = await events(idB);
check('13. LOGIN verified by admin 1, LOGOUT by admin 2', r.status === 200 && r2.status === 200 && evB[0].verified_by === idAdm && evB[1].verified_by === idAdm2 && (await lastAudit('ATTENDANCE_LOGOUT', idB)).admin_session_ref === adm2Session && (await lastAudit('ATTENDANCE_LOGOUT', idB)).verified_code === s2b.attendanceCode);

// ---------------- 17. no collisions ----------------
const occupied = new Set();
while (occupied.size < 2000) {
  const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); // test data only
  if (c !== s1b.attendanceCode && c !== s2b.attendanceCode) occupied.add(c);
}
await q(`INSERT INTO sessions (user_id, session_token_hash, expires_at, attendance_code, attendance_code_issued_at)
         SELECT $1, md5(c) || md5(c || 'x'), now() + interval '1 hour', c, now() FROM unnest($2::text[]) AS c`, [idAdm2, [...occupied]]);
let clashes = 0;
for (let i = 0; i < 60; i++) {
  await ageCode(atLogin.id, '30 minutes');
  if (occupied.has((await codeInfo(ADM)).attendanceCode)) clashes++;
}
const dupes = (await q('SELECT attendance_code FROM sessions WHERE attendance_code IS NOT NULL GROUP BY 1 HAVING count(*) > 1')).length;
check('17. with 2,000 codes already in use, 60 rotations never reuse a live code', clashes === 0 && dupes === 0, `clashes=${clashes} dupes=${dupes}`);
const liveCode1 = (await codeInfo(ADM)).attendanceCode;
check('17. the database itself refuses two sessions with the same code', await q('UPDATE sessions SET attendance_code = $1 WHERE id = $2', [liveCode1, adm2Session]).then(() => false, (e) => /unique|duplicate/i.test(e.message)));
await q(`DELETE FROM sessions WHERE attendance_code = ANY($1::text[]) AND id <> $2 AND id <> $3`, [[...occupied], atLogin.id, adm2Session]);

// concurrent dashboard requests at the boundary agree on one new code
await ageCode(atLogin.id, '30 minutes');
const together = await Promise.all(Array.from({ length: 5 }, () => codeInfo(ADM)));
check('five simultaneous requests at the boundary all get the same new code', new Set(together.map((x) => x.attendanceCode)).size === 1);

// ---------------- 18. access to codes ----------------
check('18. a student cannot read any admin code (403); without a session, 401', (await call('/api/admin/code', { cookie: A.jar })).status === 403 && (await call('/api/admin/attendance', { cookie: A.jar })).status === 403 && (await call('/api/admin/code')).status === 401);
const t = await call('/api/attendance/today', { cookie: A.jar });
check('18. student responses contain no code', t.status === 200 && !/attendanceCode|"code"/.test(t.text));
const own1 = await codeInfo(ADM), own2 = await codeInfo(ADM2);
check("18. each admin receives only their own code, never another admin's", own1.attendanceCode !== own2.attendanceCode && !JSON.stringify(own1).includes(`"${own2.attendanceCode}"`));

// ---------------- 14. admin sign-out ----------------
const C = await browser('test.c@example.test');
const beforeOut = await auditCount();
await call('/api/auth/logout', { method: 'POST', cookie: ADM2.jar });
check('14. admin sign-out writes no audit record and removes the code', (await auditCount()) === beforeOut && (await q('SELECT 1 FROM sessions WHERE id = $1', [adm2Session])).length === 0);
r = await mark(C, 'login', own2.attendanceCode);
check('14. the signed-out admin\'s code stops working immediately (inside its window)', r.status === 403 && r.json.error === INVALID && (await events(idC)).length === 0);

// ---------------- 15. admin session expiry ----------------
const ADM3 = await browser('test.admin2@example.test');
const c3 = await codeInfo(ADM3);
const adm3Session = (await q('SELECT id FROM sessions WHERE attendance_code = $1', [c3.attendanceCode]))[0].id;
await q(`UPDATE sessions SET expires_at = now() + interval '10 minutes' WHERE id = $1`, [adm3Session]);
const c3b = await codeInfo(ADM3);
check('a code never outlives its session: expiry shown is the session end when that comes first', c3b.attendanceCode === c3.attendanceCode && c3b.attendanceCodeExpiresAt === c3b.sessionExpiresAt && Date.parse(c3b.attendanceCodeExpiresAt) - Date.now() < 11 * 60_000);
await q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [adm3Session]);
r = await mark(C, 'login', c3.attendanceCode);
check('15. admin session expiry invalidates its code even inside the 30-minute window', r.status === 403 && r.json.error === EXPIRED && (await events(idC)).length === 0);
check('15. the expired admin session cannot fetch or rotate a code (401)', (await call('/api/admin/code', { cookie: ADM3.jar })).status === 401 && (await sessionRow(adm3Session)).attendance_code === c3.attendanceCode);

// sessions created before migration 006 (code without a generation time) are rotated, not trusted
await q(`UPDATE sessions SET attendance_code_issued_at = NULL WHERE id = $1`, [atLogin.id]);
const legacyCode = (await sessionRow(atLogin.id)).attendance_code;
r = await mark(C, 'login', legacyCode);
check('a pre-006 code (no generation time) is refused as expired', r.status === 403 && r.json.error === EXPIRED);
const fresh = await codeInfo(ADM);
r = await mark(C, 'login', fresh.attendanceCode);
check('...and the admin dashboard issues a fresh 30-minute code that works', fresh.attendanceCode !== legacyCode && fresh.attendanceCodeIssuedAt && r.status === 200);

// ---------------- 19. shared devices ----------------
const D = await browser('test.d@example.test', C.device);
r = await mark(D, 'login', fresh.attendanceCode);
const share = await lastAudit('DEVICE_SHARING_DETECTED', idD);
check('19. device sharing still detected and flagged neutrally (not blocked)', r.status === 200 && share && share.related_user_id === idC && share.result === 'FLAGGED');

// ---------------- 20. attendance behaviour ----------------
r = await mark(D, 'login', fresh.attendanceCode);
check('20. duplicate LOGIN still refused (409)', r.status === 409 && r.json.error === 'You are already logged in.');
const E = await browser('test.inactive@example.test');
r = await mark(E, 'logout', fresh.attendanceCode);
check('20. LOGOUT without LOGIN still refused (409)', r.status === 409 && r.json.error === 'You are not currently logged in.');
r = await mark(D, 'logout', fresh.attendanceCode);
const tD = await call('/api/attendance/today', { cookie: D.jar });
check('20. LOGIN -> LOGOUT gives one completed session in today\'s totals', r.status === 200 && tD.json.today.sessionCount === 1 && tD.json.today.sessions[0].status === 'complete' && tD.json.state.status === 'LOGGED_OUT');
check('20. no event anywhere lacks its verifying admin', (await q('SELECT count(*)::int n FROM attendance_events WHERE verified_by IS NULL'))[0].n === 0);

server.close();
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? '  — ' + x.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
