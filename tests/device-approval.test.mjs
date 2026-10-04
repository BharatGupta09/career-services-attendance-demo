// Student sign-in locked to admin-approved devices (migration 007). Test fixtures only.
// A "browser" keeps its own device cookie, exactly like a real browser does.
import crypto from 'node:crypto';
import { setupDb, startServer, TEST_PASSWORD } from './server.mjs';

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail: String(detail) });
const NEW_DEVICE = 'New Device detected - contact admin';
const MSG = 'Your attendance has been marked successfully. Thank you.';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const { db, applied } = await setupDb();
const { server, worker, env } = await startServer(8791);
const q = async (text, params) => (await db.query(text, params)).rows;
check('migrations 001-007 applied', applied.length === 7 && applied[6] === '007_device_approval.sql', applied.join());
await q(`INSERT INTO users (full_name, email, role, password_hash) VALUES ('Test Admin 2', 'test.admin2@example.test', 'admin', crypt($1, gen_salt('bf', 10)))`, [TEST_PASSWORD]);
await q(`UPDATE users SET is_active = true WHERE email = 'test.inactive@example.test'`);

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { 'User-Agent': UA, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request('http://localhost:8791' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie() };
}
const cookieOf = (list, name) => list.map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=') && !c.endsWith('='));
/** A browser: remembers its device cookie and its session cookie. */
function browser(label) {
  const b = { label, device: null, session: null };
  b.jar = () => [b.session, b.device].filter(Boolean).join('; ');
  b.signIn = async (email) => {
    const r = await call('/api/auth/login', { method: 'POST', cookie: b.jar() || undefined, body: { email, password: TEST_PASSWORD, device: { screenWidth: 1440, screenHeight: 900, timezone: 'Asia/Dubai' } } });
    b.device = cookieOf(r.setCookie, '__Host-cs_device') || b.device;
    b.session = r.status === 200 ? cookieOf(r.setCookie, '__Host-cs_session') : null;
    return r;
  };
  b.call = (path, opts = {}) => call(path, { ...opts, cookie: b.jar() });
  b.key = () => b.device?.split('=')[1];
  return b;
}
const uid = async (email) => (await q('SELECT id FROM users WHERE email = $1', [email]))[0].id;
const links = (userId) => q(`SELECT ud.*, d.device_key FROM user_devices ud JOIN devices d ON d.id = ud.device_id WHERE ud.user_id = $1 ORDER BY ud.requested_at NULLS FIRST, d.id`, [userId]);
const audits = (action, userId) => q(`SELECT * FROM audit_log WHERE action = $1 AND actor_user_id = $2 ORDER BY id`, [action, userId]);
const sessionsOf = async (userId) => (await q('SELECT count(*)::int n FROM sessions WHERE user_id = $1', [userId]))[0].n;
const decide = (b, body) => b.call('/api/admin/device-requests/decision', { method: 'POST', body });

const idA = await uid('test.a@example.test'), idB = await uid('test.b@example.test'), idC = await uid('test.c@example.test');
const idD = await uid('test.d@example.test'), idE = await uid('test.inactive@example.test'), idAdm = await uid('test.admin@example.test');
const ADM = browser('admin'); await ADM.signIn('test.admin@example.test');
const ADM2 = browser('admin 2'); await ADM2.signIn('test.admin2@example.test');

// ---------------- A. first device ----------------
const A1 = browser('A laptop');
let r = await A1.signIn('test.a@example.test');
let la = await links(idA);
check('A. first sign-in succeeds and issues a device key + session', r.status === 200 && A1.session && /^__Host-cs_device=DEV-[0-9A-F]{12}$/.test(A1.device));
check('A. the first device is approved automatically (no admin) and locked to the student', la.length === 1 && la[0].status === 'approved' && la[0].decided_by === null && la[0].device_key === A1.key());
check('A. the session is bound to that device', (await q('SELECT device_id FROM sessions WHERE user_id = $1', [idA]))[0].device_id === la[0].device_id);
check('A. audit: DEVICE_REGISTERED and SIGN_IN', (await audits('DEVICE_REGISTERED', idA)).length === 1 && (await audits('SIGN_IN', idA)).length === 1);
check('A. dashboard works from the approved device', (await A1.call('/api/attendance/today')).status === 200);

// ---------------- B. same device ----------------
r = await A1.signIn('test.a@example.test');
check('B. signing in again from the approved device succeeds', r.status === 200 && (await A1.call('/api/attendance/today')).status === 200);
check('B. still exactly one device, no request created', (await links(idA)).length === 1 && (await audits('NEW_DEVICE', idA)).length === 0);

// ---------------- C. new device ----------------
const A2 = browser('A phone');
const before = await sessionsOf(idA);
r = await A2.signIn('test.a@example.test');
la = await links(idA);
const pend = la.find((l) => l.device_key === A2.key());
check('C. sign-in from a different device is refused with the exact message', r.status === 403 && r.json.error === NEW_DEVICE, r.text);
check('C. no session is created and no session cookie is set', (await sessionsOf(idA)) === before && !cookieOf(r.setCookie, '__Host-cs_session') && A2.session === null);
check('C. the new device keeps its device key (so the request can be approved for it)', /^__Host-cs_device=DEV-/.test(A2.device) && A2.key() !== A1.key());
check('C. a pending request exists for exactly this student + device', pend && pend.status === 'pending' && pend.attempt_count === 1 && pend.decided_by === null);
check('C. audit: NEW_DEVICE and DEVICE_LOGIN_BLOCKED', (await audits('NEW_DEVICE', idA)).length === 1 && (await audits('DEVICE_LOGIN_BLOCKED', idA)).length === 1);
check('C. response reveals nothing about other devices', !r.text.includes(A1.key()) && !/approved|pending|device_id/i.test(r.text));

// ---------------- F. repeated attempts ----------------
for (let i = 0; i < 3; i++) await A2.signIn('test.a@example.test');
la = await links(idA);
check('F. repeated attempts reuse the same pending request (no duplicates)', la.filter((l) => l.status === 'pending').length === 1 && la.find((l) => l.device_key === A2.key()).attempt_count === 4);
check('F. NEW_DEVICE recorded once; every refused attempt audited', (await audits('NEW_DEVICE', idA)).length === 1 && (await audits('DEVICE_LOGIN_BLOCKED', idA)).length === 4);
let list = await ADM.call('/api/admin/device-requests');
const itemA = list.json.pending.filter((p) => p.userId === idA);
check('F. the admin sees one alert for it, with name, email, device details, time and status', itemA.length === 1 && itemA[0].student === 'Test Student A' && itemA[0].email === 'test.a@example.test' && /Chrome 129 · Windows · Desktop · 1440×900 · Asia\/Dubai/.test(itemA[0].device.summary) && itemA[0].requestedAt && itemA[0].status === 'pending' && itemA[0].attempts === 4, JSON.stringify(itemA));
const ov = await ADM.call('/api/admin/attendance');
check('overview reports device approval enabled and the pending count', ov.json.deviceApprovalEnabled === true && ov.json.pendingDeviceRequests === 1);

// ---------------- J. session security ----------------
const stolen = `${A1.session}; ${A2.device}`; // A's valid session used from the unapproved phone
const js = await Promise.all([['GET', '/api/attendance/today'], ['GET', '/api/attendance/history'], ['POST', '/api/attendance/login'], ['POST', '/api/attendance/logout'], ['GET', '/api/auth/me']]
  .map(([m, p]) => call(p, { method: m, cookie: stolen, body: m === 'POST' ? { code: '1234' } : undefined })));
check('J. a valid session presented from an unapproved device is refused everywhere (401)', js.every((x) => x.status === 401), js.map((x) => x.status).join());
const js2 = await Promise.all(['/api/attendance/today', '/api/attendance/history'].map((p) => A2.call(p)));
check('J. the unapproved device itself has no session (401)', js2.every((x) => x.status === 401));
// A session row as it existed before migration 007 (no device), for a real token.
const legacyToken = crypto.randomBytes(32).toString('base64url');
await q(`INSERT INTO sessions (user_id, session_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [idA, crypto.createHash('sha256').update(legacyToken).digest('hex')]);
const legacyRes = await call('/api/attendance/today', { cookie: `__Host-cs_session=${legacyToken}; ${A1.device}` });
await q(`UPDATE sessions SET device_id = (SELECT device_id FROM sessions WHERE user_id = $1 AND device_id IS NOT NULL LIMIT 1) WHERE session_token_hash = $2`, [idA, crypto.createHash('sha256').update(legacyToken).digest('hex')]);
const boundRes = await call('/api/attendance/today', { cookie: `__Host-cs_session=${legacyToken}; ${A1.device}` });
check('J. a session created before device locking (no device) is refused; the same token bound to the approved device works', legacyRes.status === 401 && boundRes.status === 200, `${legacyRes.status} ${boundRes.status}`);

// ---------------- H/I. who may decide ----------------
const reqA = { userId: idA, deviceId: pend.device_id, decision: 'approve' };
check('H. a student cannot approve their own device (403)', (await decide(A1, reqA)).status === 403);
const B1 = browser('B laptop'); await B1.signIn('test.b@example.test');
check("H. a student cannot approve another student's device (403)", (await decide(B1, reqA)).status === 403);
check('I. without a session: 401', (await call('/api/admin/device-requests/decision', { method: 'POST', body: reqA })).status === 401 && (await call('/api/admin/device-requests')).status === 401);
check('H. students cannot list device requests (403)', (await A1.call('/api/admin/device-requests')).status === 403);
check('I. cross-origin approval is refused (403)', (await ADM.call('/api/admin/device-requests/decision', { method: 'POST', body: reqA, headers: { Origin: 'https://evil.example' } })).status === 403);
const bad = await Promise.all([
  decide(ADM, { ...reqA, userId: 'not-a-uuid' }), decide(ADM, { ...reqA, deviceId: 'x' }), decide(ADM, { ...reqA, decision: 'maybe' }),
  decide(ADM, { ...reqA, deviceId: 999999 }), decide(ADM, { ...reqA, userId: idB }), decide(ADM, { ...reqA, userId: idAdm }),
  decide(ADM, { userId: idA, deviceId: la.find((l) => l.status === 'approved').device_id, decision: 'deny' }),
]);
check('I. malformed requests are rejected (400)', bad.slice(0, 3).every((x) => x.status === 400), bad.map((x) => x.status).join());
check('H/I. tampered ids cannot approve anything: unknown device, other student, admin account (404)', bad.slice(3, 6).every((x) => x.status === 404), bad.map((x) => x.status).join());
check('I. only pending requests can be decided: an already approved device -> 409', bad[6].status === 409);
check('H/I. none of this changed any request', (await links(idA)).map((l) => l.status).join() === 'approved,pending');

// ---------------- D. approval ----------------
r = await decide(ADM, reqA);
la = await links(idA);
const approvedA2 = la.find((l) => l.device_key === A2.key());
check('D. the admin approves: exactly this student + device becomes approved, with the admin and time', r.status === 200 && r.json.status === 'approved' && approvedA2.status === 'approved' && approvedA2.decided_by === idAdm && approvedA2.decided_at);
const apA = (await audits('DEVICE_APPROVED', idA))[0];
check('D. audit: DEVICE_APPROVED with student, device, admin, admin session and request reference', apA && apA.verified_by === idAdm && apA.device_id === approvedA2.device_id && apA.admin_session_ref && apA.metadata.request.device_id === Number(approvedA2.device_id) && apA.metadata.request.user_id === idA);
r = await A2.signIn('test.a@example.test');
check('D. the student can now sign in from that device', r.status === 200 && (await A2.call('/api/attendance/today')).status === 200);
check('D. the sign-in after approval is audited with the approving admin', (await audits('SIGN_IN', idA)).some((a) => a.verified_by === idAdm && a.metadata.approved_by_admin === true));
check('D. deciding the same request again -> 409', (await decide(ADM2, { ...reqA, decision: 'deny' })).status === 409);
const A3 = browser('A second laptop');
r = await A3.signIn('test.a@example.test');
check('D. approval is for that device only: a third device is still refused', r.status === 403 && r.json.error === NEW_DEVICE);

// ---------------- E. denial ----------------
const pend3 = (await links(idA)).find((l) => l.device_key === A3.key());
r = await decide(ADM2, { userId: idA, deviceId: pend3.device_id, decision: 'deny' });
const denied = (await links(idA)).find((l) => l.device_key === A3.key());
check('E. the admin denies: device stays unapproved, with the admin and time recorded', r.status === 200 && r.json.status === 'denied' && denied.status === 'denied' && denied.decided_by !== null && denied.decided_at);
check('E. audit: DEVICE_DENIED with the denying admin', (await audits('DEVICE_DENIED', idA)).length === 1 && (await audits('DEVICE_DENIED', idA))[0].verified_by === (await uid('test.admin2@example.test')));
r = await A3.signIn('test.a@example.test');
const stillDenied = (await links(idA)).find((l) => l.device_key === A3.key());
check('E. the student remains unable to sign in from the denied device', r.status === 403 && r.json.error === NEW_DEVICE && !A3.session);
check('E. a later attempt does NOT reopen the request (stays denied, no new alert)', stillDenied.status === 'denied' && stillDenied.attempt_count === 2 && (await ADM.call('/api/admin/device-requests')).json.pending.every((p) => p.deviceId !== String(pend3.device_id)));
check('E. a denied request cannot then be approved through the API (409)', (await decide(ADM, { userId: idA, deviceId: pend3.device_id, decision: 'approve' })).status === 409);
la = await links(idA);
check('multiple devices: A has laptop + phone approved, second laptop denied', la.map((l) => `${l.device_key === A1.key() ? 'laptop' : l.device_key === A2.key() ? 'phone' : 'laptop2'}:${l.status}`).join() === 'laptop:approved,phone:approved,laptop2:denied', JSON.stringify(la.map((l) => l.status)));
list = await ADM.call('/api/admin/device-requests');
check('decided requests move to history as Approved / Denied / first device', list.json.recent.some((x) => x.userId === idA && x.status === 'approved' && x.decidedBy === 'Test Admin') && list.json.recent.some((x) => x.userId === idA && x.status === 'denied' && x.decidedBy === 'Test Admin 2') && list.json.recent.some((x) => x.userId === idA && x.firstDevice));

// ---------------- G. concurrent first sign-ins ----------------
const C1 = browser('C one'), C2 = browser('C two'), C3 = browser('C three');
const rs = await Promise.all([C1.signIn('test.c@example.test'), C2.signIn('test.c@example.test'), C3.signIn('test.c@example.test')]);
const lc = await links(idC);
check('G. three simultaneous first sign-ins from different devices: exactly one succeeds', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 403 && x.json.error === NEW_DEVICE).length === 2, rs.map((x) => x.status).join());
check('G. exactly one device approved automatically; the others wait for an admin', lc.filter((l) => l.status === 'approved').length === 1 && lc.filter((l) => l.status === 'pending').length === 2 && (await sessionsOf(idC)) === 1);
const second = lc.find((l) => l.status === 'pending');
check('G. the database itself refuses a second automatically approved device (unique index)', await q(`UPDATE user_devices SET status = 'approved', decided_at = now() WHERE user_id = $1 AND device_id = $2`, [idC, second.device_id]).then(() => false, (e) => /unique|duplicate/i.test(e.message)));

// ---------------- history-only device rows from before device locking ----------------
const legacyDev = (await q(`INSERT INTO devices (device_key) VALUES ('DEV-00000000AAAA') RETURNING id`))[0].id;
await q(`INSERT INTO user_devices (user_id, device_id) VALUES ($1, $2)`, [idE, legacyDev]);
const E1 = browser('E new'); r = await E1.signIn('test.inactive@example.test');
const E0 = browser('E old'); E0.device = '__Host-cs_device=DEV-00000000AAAA';
const r0 = await E0.signIn('test.inactive@example.test');
const le = await links(idE);
check('devices used before locking are not approved: first sign-in device is locked, the old one needs approval', r.status === 200 && r0.status === 403 && le.find((l) => l.device_id === legacyDev).status === 'pending' && le.filter((l) => l.status === 'approved').length === 1);

// ---------------- admins are not device-locked ----------------
const admIns = await Promise.all([browser('x').signIn('test.admin@example.test'), browser('y').signIn('test.admin@example.test')]);
check('admins can sign in from any device (device locking is for students)', admIns.every((x) => x.status === 200));

// ---------------- K. attendance still works, codes independent ----------------
const code = (await ADM.call('/api/admin/code')).json.attendanceCode;
const stale = await Promise.all(['login', 'logout'].map((a) => A1.call(`/api/attendance/${a}`, { method: 'POST' })));
check('K. LOGIN/LOGOUT with no JSON body (an out-of-date page) is refused with the reload message; nothing recorded', stale.every((x) => x.status === 415 && x.json.error === 'This page is out of date. Please reload the page, then try again.') && (await q(`SELECT count(*)::int n FROM attendance_events WHERE user_id = $1`, [idA]))[0].n === 0);
r = await A1.call('/api/attendance/login', { method: 'POST', body: { code, device: {} } });
check('K. LOGIN from an approved device with a valid code works', r.status === 200 && r.json.message === MSG);
r = await A2.call('/api/attendance/logout', { method: 'POST', body: { code: String((Number(code) + 1) % 10000).padStart(4, '0'), device: {} } });
check('K. an approved device still needs a valid code (wrong code -> 403, nothing recorded)', r.status === 403 && (await q(`SELECT count(*)::int n FROM attendance_events WHERE user_id = $1`, [idA]))[0].n === 1);
const admSess = (await q(`SELECT id FROM sessions WHERE attendance_code = $1`, [code]))[0].id;
await q(`UPDATE sessions SET attendance_code_issued_at = now() - interval '30 minutes' WHERE id = $1`, [admSess]);
r = await A2.call('/api/attendance/logout', { method: 'POST', body: { code, device: {} } });
check('K. the 30-minute rotation still applies (expired code refused)', r.status === 403 && /expired/.test(r.json.error));
const code2 = (await ADM.call('/api/admin/code')).json.attendanceCode;
r = await A2.call('/api/attendance/logout', { method: 'POST', body: { code: code2, device: {} } });
const ev = await q(`SELECT event_type, verified_by, device_id FROM attendance_events WHERE user_id = $1 ORDER BY seq`, [idA]);
check('K. LOGOUT from the other approved device with the new code works; verifier and devices recorded', r.status === 200 && ev.map((e) => e.event_type).join() === 'LOGIN,LOGOUT' && ev.every((e) => e.verified_by === idAdm) && ev[0].device_id !== ev[1].device_id);
const D1 = browser('D on A laptop'); D1.device = A1.device;
r = await D1.signIn('test.d@example.test');
const rD = await D1.call('/api/attendance/login', { method: 'POST', body: { code: code2, device: {} } });
check('K. device sharing detection still works (another student on the same device is flagged, not blocked)', r.status === 200 && rD.status === 200 && (await audits('DEVICE_SHARING_DETECTED', idD)).length === 1);
const aud = await ADM.call('/api/admin/audit?action=DEVICE_APPROVED');
check('K. admin audit trail lists the new device actions', aud.status === 200 && aud.json.entries.length === 1 && aud.json.entries[0].verifiedBy === 'Test Admin');
check('no passwords or hashes in any admin device response', !/\$2[aby]\$|password/i.test(JSON.stringify(list.json) + aud.text));

server.close();
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? '  — ' + x.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
