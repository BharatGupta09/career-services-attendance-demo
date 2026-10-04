// Tests for device identification, admin attendance codes and the audit trail,
// running the real Worker code against in-memory PostgreSQL (migrations 001-006).
import crypto from 'node:crypto';
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });
const MSG = 'Your attendance has been marked successfully. Thank you.';
const INVALID = 'Invalid attendance code. Please obtain the current code from an authorized admin.';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const { db } = await setupDb();
const { server, worker, env } = await startServer(8798);
const q = async (text, params) => (await db.query(text, params)).rows;
await q(`INSERT INTO users (full_name, email, role, password_hash) VALUES ('Test Admin 2', 'test.admin2@example.test', 'admin', crypt($1, gen_salt('bf', 10)))`, [TEST_PASSWORD]);

async function call(path, { method = 'GET', body, cookie, ua = FIREFOX_WIN, headers = {} } = {}) {
  const h = { 'User-Agent': ua, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8798' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie() };
}
const cookieVal = (list, name) => list.map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));
// A "browser": session cookie + device cookie, like a real browser would keep them.
async function browser(email, { device = null, ua = FIREFOX_WIN } = {}) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password: TEST_PASSWORD }, cookie: device || undefined, ua });
  const session = cookieVal(r.setCookie, '__Host-cs_session');
  const dev = device || cookieVal(r.setCookie, '__Host-cs_device');
  return { r, session, device: dev, ua, jar: [session, dev].filter(Boolean).join('; ') };
}
const mark = (b, action, code, extra = {}) =>
  call(`/api/attendance/${action}`, { method: 'POST', cookie: b.jar, ua: b.ua, body: { code, device: { screenWidth: 1280, screenHeight: 800, timezone: 'Asia/Dubai' }, ...extra } });
const codeOf = async (adminBrowser) => (await call('/api/admin/attendance', { cookie: adminBrowser.jar })).json?.attendanceCode;
const uid = async (email) => (await q('SELECT id FROM users WHERE email = $1', [email]))[0].id;
const events = (id) => q('SELECT seq, event_type, device_id, verified_by FROM attendance_events WHERE user_id = $1 ORDER BY seq', [id]);
const audits = (action, id) => q('SELECT * FROM audit_log WHERE action = $1 AND ($2::uuid IS NULL OR actor_user_id = $2::uuid) ORDER BY id', [action, id ?? null]);

const idA = await uid('test.a@example.test'), idB = await uid('test.b@example.test'), idC = await uid('test.c@example.test'), idD = await uid('test.d@example.test');
const idAdm = await uid('test.admin@example.test'), idAdm2 = await uid('test.admin2@example.test');

// ---------------- 1-2. device identity ----------------
const A = await browser('test.a@example.test');
const devCookie = A.r.setCookie.find((c) => c.startsWith('__Host-cs_device='));
check('1. device ID created at sign-in: DEV-xxxxxxxxxxxx, HttpOnly, Secure, SameSite=Strict, long-lived', devCookie && /^__Host-cs_device=DEV-[0-9A-F]{12};/.test(devCookie) && /HttpOnly/.test(devCookie) && /Secure/.test(devCookie) && /SameSite=Strict/.test(devCookie) && /Max-Age=34560000/.test(devCookie), devCookie);
const A2 = await browser('test.a@example.test', { device: A.device });
check('2. returning device is recognised (no new device cookie issued)', !A2.r.setCookie.some((c) => c.startsWith('__Host-cs_device=')) && A2.device === A.device);
const tampered = await browser('test.c@example.test', { device: '__Host-cs_device=DEV-zzz<script>' });
check('device-ID tampering: malformed cookie replaced by a new valid key', /^__Host-cs_device=DEV-[0-9A-F]{12}$/.test(cookieVal(tampered.r.setCookie, '__Host-cs_device') || ''));

// ---------------- admin codes ----------------
const ADM = await browser('test.admin@example.test');
const ADM2 = await browser('test.admin2@example.test');
const code1 = await codeOf(ADM), code2 = await codeOf(ADM2);
check('6-7. each admin session gets its own 4-digit code', /^\d{4}$/.test(code1) && /^\d{4}$/.test(code2) && code1 !== code2, `${code1} ${code2}`);
const sessRow = await q(`SELECT attendance_code FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.role = 'student'`);
check('student sessions carry no attendance code', sessRow.every((r) => r.attendance_code === null));

// randomness: many admin sessions, all distinct 4-digit codes from across the range
const extra = [];
for (let i = 0; i < 40; i++) extra.push(await browser('test.admin@example.test'));
const codes = await Promise.all(extra.map(codeOf));
const lows = codes.filter((c) => Number(c) < 5000).length;
check('8. codes are random: 40 sessions, all 4 digits, all distinct, spread across 0000-9999', codes.every((c) => /^\d{4}$/.test(c)) && new Set(codes).size === 40 && lows > 5 && lows < 35, `lows=${lows}`);
for (const b of extra) await call('/api/auth/logout', { method: 'POST', cookie: b.jar });

// ---------------- 9. students never receive codes ----------------
const todayA = await call('/api/attendance/today', { cookie: A.jar });
const histA = await call('/api/attendance/history', { cookie: A.jar });
check('9. student responses never include an attendance code', todayA.status === 200 && !/attendanceCode|"code"/i.test(todayA.text + histA.text) && todayA.json.verificationRequired === true);
check('students cannot open admin overview (which holds the code)', (await call('/api/admin/attendance', { cookie: A.jar })).status === 403);

// ---------------- 10-12. validation ----------------
let r = await call('/api/attendance/login', { method: 'POST', cookie: A.jar, body: {} });
check('10. LOGIN without a code is refused (400) and records nothing', r.status === 400 && (await events(idA)).length === 0);
r = await call('/api/attendance/login', { method: 'POST', cookie: A.jar });
check('LOGIN with no body at all (a page from before codes) -> 415 "reload" message, nothing recorded', r.status === 415 && r.json.error === 'This page is out of date. Please reload the page, then try again.' && (await events(idA)).length === 0);
r = await call('/api/attendance/login', { method: 'POST', cookie: A.jar, body: { code: '12a4' } });
check('10. malformed code refused (400)', r.status === 400);
const wrong = String((Number(code1) + 1) % 10000).padStart(4, '0') === code2 ? String((Number(code1) + 2) % 10000).padStart(4, '0') : String((Number(code1) + 1) % 10000).padStart(4, '0');
r = await mark(A, 'login', wrong);
check('12. invalid code blocks LOGIN with the exact message', r.status === 403 && r.json.error === INVALID && (await events(idA)).length === 0);
const bad = await audits('INVALID_ATTENDANCE_CODE', idA);
check('21. invalid attempt audited: FAILED, device, attempted action, no code stored', bad.length === 1 && bad[0].result === 'FAILED' && bad[0].device_id && bad[0].metadata.attempted_action === 'LOGIN' && !JSON.stringify(bad[0]).includes(`"${wrong}"`));

r = await mark(A, 'login', code1, { user_id: idB });
check('11. valid code allows LOGIN (exact message; user_id in body ignored)', r.status === 200 && r.json.message === MSG && (await events(idB)).length === 0);
check('success response does not reveal which admin issued the code', !/Test Admin/.test(r.text));
let evA = await events(idA);
const devA = (await q('SELECT id FROM devices WHERE device_key = $1', [A.device.split('=')[1]]))[0];
check('5. LOGIN event associated with the device', evA.length === 1 && devA && evA[0].device_id === devA.id);
check('17. LOGIN event records the verifying admin', evA[0].verified_by === idAdm);
const okAudit = (await audits('ATTENDANCE_LOGIN', idA))[0];
const admSession = (await q(`SELECT id FROM sessions WHERE attendance_code = $1`, [code1]))[0];
check('20. successful use audited: admin, admin session, event, device, code verified', okAudit && okAudit.result === 'SUCCESS' && okAudit.verified_by === idAdm && okAudit.admin_session_ref === admSession.id && String(okAudit.attendance_event_id) && okAudit.device_id === devA.id && okAudit.metadata.code_verified === true);
check('audit rows never contain the code', !(await q(`SELECT metadata::text AS m FROM audit_log`)).some((x) => x.m.includes(code1) || x.m.includes(code2)));
const dRow = (await q('SELECT browser, os, device_type, screen_width, screen_height, timezone FROM devices WHERE id = $1', [devA.id]))[0];
check('device metadata recorded: Firefox / Windows / desktop / 1280x800 / Asia/Dubai', dRow.browser === 'Firefox' && dRow.os === 'Windows' && dRow.device_type === 'desktop' && dRow.screen_width === 1280 && dRow.screen_height === 800 && dRow.timezone === 'Asia/Dubai', JSON.stringify(dRow));

r = await mark(A, 'login', code1);
check('duplicate LOGIN with a valid code still refused (409)', r.status === 409 && r.json.error === 'You are already logged in.');

// ---------------- 30. sign-out behaviour unchanged ----------------
await call('/api/auth/logout', { method: 'POST', cookie: A.jar });
check('30. app sign-out while working records no attendance LOGOUT', (await events(idA)).length === 1);
const A3 = await browser('test.a@example.test', { device: A.device });

// ---------------- 13-14, 18. LOGOUT, different admins ----------------
r = await mark(A3, 'logout', wrong);
check('14. invalid code blocks LOGOUT', r.status === 403 && (await events(idA)).length === 1);
r = await mark(A3, 'logout', code2);
check('13. valid code (from a second admin) allows LOGOUT', r.status === 200 && r.json.message === MSG);
evA = await events(idA);
check('18. LOGIN and LOGOUT keep their own verifying admins', evA[0].verified_by === idAdm && evA[1].verified_by === idAdm2);
const histAdmin = await call(`/api/admin/attendance/${idA}`, { cookie: ADM.jar });
const sess = histAdmin.json.days[0].sessions[0];
check('admin history shows "LOGIN by Test Admin", "LOGOUT by Test Admin 2" and devices', sess.detail.loginVerifiedBy === 'Test Admin' && sess.detail.logoutVerifiedBy === 'Test Admin 2' && sess.detail.loginDevice.key === A.device.split('=')[1] && sess.detail.loginDevice.browser === 'Firefox');

// ---------------- 15-16. code invalidation ----------------
await call('/api/auth/logout', { method: 'POST', cookie: ADM2.jar });
r = await mark(A3, 'login', code2);
check('15. admin sign-out invalidates their code immediately', r.status === 403 && r.json.error === INVALID);
check('15. signed-out admin session (and its code) no longer stored', (await q(`SELECT 1 FROM sessions WHERE attendance_code = $1`, [code2])).length === 0);
await q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [admSession.id]);
r = await mark(A3, 'login', code1);
check('16. expired admin session invalidates its code', r.status === 403);
const ADM3 = await browser('test.admin@example.test');
const code3 = await codeOf(ADM3);

// ---------------- 19. unused codes leave nothing behind ----------------
const auditBefore = (await q('SELECT count(*)::int n FROM audit_log'))[0].n;
const tmp = await browser('test.admin2@example.test');
const tmpCode = await codeOf(tmp);
await call('/api/auth/logout', { method: 'POST', cookie: tmp.jar });
const auditAfter = (await q('SELECT count(*)::int n FROM audit_log'))[0].n;
const codeCols = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ILIKE '%code%'`);
check('19. generating and discarding a code creates no permanent record', /^\d{4}$/.test(tmpCode) && auditAfter === auditBefore && (await q(`SELECT 1 FROM sessions WHERE attendance_code = $1`, [tmpCode])).length === 0);
const colNames = codeCols.map((c) => `${c.table_name}.${c.column_name}`).sort().join();
const codesOnOtherRows = (await q(`SELECT count(*)::int n FROM audit_log WHERE verified_code IS NOT NULL AND (result <> 'SUCCESS' OR action NOT IN ('ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT'))`))[0].n;
check('19. codes are kept only on the live session row, and in audit_log only for successful LOGIN/LOGOUT', colNames === 'audit_log.code_issued_at,audit_log.verified_code,sessions.attendance_code,sessions.attendance_code_issued_at' && codesOnOtherRows === 0, colNames);

// ---------------- 3-4, 24. shared device ----------------
// Coordinator B signs in on Coordinator A's browser (same device cookie) shortly after A.
const B = await browser('test.b@example.test', { device: A.device });
r = await mark(B, 'login', code3);
check('3. a second student can use the same device (not blocked)', r.status === 200);
const shareRows = await audits('DEVICE_SHARING_DETECTED', idB);
check('4. shared device flagged neutrally (B with A, same device)', shareRows.length === 1 && shareRows[0].related_user_id === idA && shareRows[0].result === 'FLAGGED' && shareRows[0].metadata.message === 'Multiple student accounts used the same device during overlapping attendance activity.');
check('3. user_devices lists both students for the device', (await q('SELECT user_id FROM user_devices WHERE device_id = $1', [devA.id])).length === 2);
r = await mark(B, 'logout', code3);
check('flag is not duplicated for the same pair and device', (await audits('DEVICE_SHARING_DETECTED')).length === 1);
const devs = await call('/api/admin/devices', { cookie: ADM3.jar });
const shared = devs.json?.devices?.find((d) => d.key === A.device.split('=')[1]);
check('24. admin device view: used by A and B, potential shared device, recent activity', shared && shared.potentiallyShared && shared.usedBy.map((u) => u.name).sort().join() === 'Test Student A,Test Student B' && shared.sharedDeviceFlags === 1 && shared.recent.length >= 3);
const ov = await call('/api/admin/attendance', { cookie: ADM3.jar });
const cA = ov.json.coordinators.find((c) => c.id === idA), cB = ov.json.coordinators.find((c) => c.id === idB);
check('overview flags both coordinators and shows device + verifier in activity', cA.sharedDeviceFlag && cB.sharedDeviceFlag && ov.json.summary.sharedDeviceFlags === 2 && ov.json.activity.every((a) => a.device && a.verifiedBy));
check('new devices audited once per student', (await audits('NEW_DEVICE', idA)).length === 1 && (await audits('NEW_DEVICE', idB)).length === 1);

// ---------------- 22-23. access control ----------------
for (const p of ['/api/admin/audit', '/api/admin/devices']) {
  check(`22-23. student -> ${p} 403`, (await call(p, { cookie: A3.jar })).status === 403);
  check(`unauthenticated -> ${p} 401`, (await call(p)).status === 401);
}
const aud = await call('/api/admin/audit', { cookie: ADM3.jar });
const acts = new Set(aud.json.entries.map((e) => e.action));
check('admin audit trail lists logins, logouts, invalid codes, sharing, new devices', ['ATTENDANCE_LOGIN', 'ATTENDANCE_LOGOUT', 'INVALID_ATTENDANCE_CODE', 'DEVICE_SHARING_DETECTED', 'NEW_DEVICE'].every((a) => acts.has(a)));
const onlyBad = await call('/api/admin/audit?action=INVALID_ATTENDANCE_CODE', { cookie: ADM3.jar });
check('audit filter by action', onlyBad.json.entries.length >= 1 && onlyBad.json.entries.every((e) => e.action === 'INVALID_ATTENDANCE_CODE' && e.result === 'FAILED'));
check('audit filter rejects unknown action (400)', (await call('/api/admin/audit?action=DROP', { cookie: ADM3.jar })).status === 400);
check('audit entries expose no tokens or hashes; a code appears only on the successful LOGIN/LOGOUT it verified', !/\$2[aby]\$|session_token|attendance_code/.test(aud.text) && aud.json.entries.every((e) => e.codeUsed === null || (e.result === 'SUCCESS' && e.action.startsWith('ATTENDANCE_') && /^\d{4}$/.test(e.codeUsed))) && aud.json.entries.some((e) => e.codeUsed === code3));

// ---------------- 25-26. history ----------------
// C logs in on a phone and out on a Mac: each side keeps its own device.
const Cphone = await browser('test.c@example.test', { ua: CHROME_ANDROID });
r = await mark(Cphone, 'login', code3);
const Cmac = await browser('test.c@example.test', { ua: SAFARI_MAC });
r = await mark(Cmac, 'logout', code3);
const hC = await call(`/api/admin/attendance/${idC}`, { cookie: ADM3.jar });
const sC = hC.json.days[0].sessions[0].detail;
check('25. historical session keeps LOGIN device and LOGOUT device separately', sC.loginDevice.os === 'Android' && sC.loginDevice.type === 'mobile' && sC.logoutDevice.os === 'macOS' && sC.logoutDevice.browser === 'Safari' && sC.loginDevice.key !== sC.logoutDevice.key, JSON.stringify(sC));
await mark(Cphone, 'login', code3);
const hC2 = await call(`/api/admin/attendance/${idC}`, { cookie: ADM3.jar });
check('25. later activity does not rewrite earlier device associations', JSON.stringify(hC2.json.days[0].sessions[0].detail) === JSON.stringify(sC));
await q(`INSERT INTO attendance_events (user_id, seq, event_type, event_timestamp) VALUES ($1,0,'LOGIN','2026-09-20T06:00:00Z'),($1,1,'LOGOUT','2026-09-20T08:30:00Z')`, [idD]);
const hD = await call(`/api/admin/attendance/${idD}?from=2026-09-20&to=2026-09-20`, { cookie: ADM3.jar });
const sD = hD.json.days[0].sessions[0];
check('26. pre-005 records render with device/verifier "not recorded" (null), totals intact', sD.seconds === 9000 && sD.detail.loginDevice === null && sD.detail.logoutDevice === null && sD.detail.loginVerifiedBy === null);

// ---------------- 27-29. concurrency & throttling ----------------
const Dbr = await browser('test.d@example.test');
let rs = await Promise.all(Array.from({ length: 6 }, () => mark(Dbr, 'login', code3)));
check('28. six simultaneous LOGINs with a valid code: exactly one recorded', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409).length === 5);
rs = await Promise.all(Array.from({ length: 6 }, () => mark(Dbr, 'logout', code3)));
check('29. six simultaneous LOGOUTs: exactly one recorded', rs.filter((x) => x.status === 200).length === 1);
check('sequence intact after concurrency', (await events(idD)).map((e) => e.event_type).join() === 'LOGIN,LOGOUT,LOGIN,LOGOUT');

const Inactive = await q(`UPDATE users SET is_active = true WHERE email = 'test.inactive@example.test' RETURNING id`);
const E = await browser('test.inactive@example.test');
const guesses = Array.from({ length: 12 }, (_, i) => String((Number(code3) + 1 + i) % 10000).padStart(4, '0'));
rs = await Promise.all(guesses.map((g) => mark(E, 'login', g)));
const eBad = await audits('INVALID_ATTENDANCE_CODE', Inactive[0].id);
check('27. 12 simultaneous wrong guesses: none recorded, exactly 5 counted, rest throttled (429)', (await events(Inactive[0].id)).length === 0 && eBad.length === 5 && rs.filter((x) => x.status === 429).length === 7 && rs.filter((x) => x.status === 403).length === 5);
r = await mark(E, 'login', code3);
check('27. after the limit even the right code is paused for 15 minutes', r.status === 429 && (await events(Inactive[0].id)).length === 0);

const Fbr = await browser('test.c@example.test', { device: Cphone.device, ua: CHROME_ANDROID });
await q(`INSERT INTO audit_log (action, result, actor_user_id, created_at) SELECT 'INVALID_ATTENDANCE_CODE', 'FAILED', $1, now() - interval '3 hours' FROM generate_series(1, 12)`, [idC]);
r = await mark(Fbr, 'logout', code3);
check('daily cap: 12 incorrect codes in 24 hours pause code entry (even the right code)', r.status === 429 && r.json.error === 'Too many incorrect attendance codes today. Please contact a Career Services admin.');

// ---------------- audit immutability ----------------
async function err(sqlText) { try { await db.query(sqlText); return 'no error'; } catch (e) { return e.message; } }
check('audit log cannot be updated', /append-only/.test(await err(`UPDATE audit_log SET result = 'SUCCESS'`)));
check('audit log cannot be deleted', /append-only/.test(await err(`DELETE FROM audit_log`)));
check('audit log cannot be truncated', /append-only/.test(await err(`TRUNCATE audit_log`)));

server.close();
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? '  — ' + x.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
