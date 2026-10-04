// Career Services Attendance — frontend.
//
// Plain JavaScript, no build step. All data comes from the Worker API; the
// session lives in an HttpOnly cookie the page cannot read, and nothing is
// kept in localStorage. Every time and date is shown in Asia/Dubai.
// Values are always inserted with textContent, never as HTML.
'use strict';

// ===========================================================================
// Formatting (Asia/Dubai)
// ===========================================================================
const TZ = 'Asia/Dubai';
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDubaiYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
// Date-only values (YYYY-MM-DD) are already Dubai dates: format them in UTC so they never shift.
const fmtLongDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const fmtDayDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

const ymdToDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
/** HH:MM:SS in Dubai time. */
const time = (iso) => fmtTime.format(new Date(iso));
const longDate = (ymd) => fmtLongDate.format(ymdToDate(ymd));
const shortDate = (ymd) => fmtShortDate.format(ymdToDate(ymd));
const dayDate = (ymd) => fmtDayDate.format(ymdToDate(ymd));
const dubaiYmd = (iso) => fmtDubaiYmd.format(new Date(iso));
const pad2 = (n) => String(n).padStart(2, '0');

/** 3h 30m · 7h 05m · 45m · 17s · 0h 00m */
function duration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s === 0) return '0h 00m';
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${pad2(m)}m`;
}

/** Live clock for an open session: 1h 12m 05s */
function elapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad2(m)}m ${pad2(s % 60)}s`;
}

function addDays(ymd, days) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ===========================================================================
// DOM helpers
// ===========================================================================
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function showAlert(node, message, kind) {
  node.textContent = message;
  node.className = `alert alert-${kind}`;
  node.hidden = !message;
}

/** "Maria Del Carmen Ruiz" -> "MR" */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** Copy each column header onto its cells, so tables can stack into cards on phones. */
function labelCells(table) {
  const headers = [...table.tHead.rows[0].cells].map((th) => th.textContent);
  for (const row of table.tBodies[0].rows) {
    [...row.cells].forEach((cell, i) => {
      if (headers[i]) cell.dataset.label = headers[i];
    });
  }
}

/** Show a spinner in a button while a request runs; the label is kept for screen readers. */
function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ===========================================================================
// API
// ===========================================================================
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server. Please check your connection and try again.', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // non-JSON response
  }
  if (!response.ok || !data || !data.success) {
    throw new ApiError((data && data.error) || 'Something went wrong. Please try again.', response.status);
  }
  return data;
}

/** Any 401 after sign-in means the session has ended: go back to the sign-in form. */
function handleError(err, target) {
  if (err instanceof ApiError && err.status === 401) {
    showLogin('Your session has expired. Please log in again.');
    return;
  }
  showAlert(target || $('page-error'), err.message, 'error');
}

// ===========================================================================
// Views
// ===========================================================================
let currentUser = null;
let tickTimer = null;
const tickers = new Set(); // functions re-run every second while a session is open

function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => tickers.forEach((fn) => fn()), 1000);
}
function clearTickers() {
  tickers.clear();
  clearInterval(tickTimer);
  tickTimer = null;
}

function showView(name) {
  for (const id of ['view-login', 'view-student', 'view-admin']) {
    const node = $(id);
    if (node) node.hidden = id !== `view-${name}`;
  }
  document.body.dataset.view = name;
  $('loading').hidden = true;
  $('page-error').hidden = true;
}

function setAccount(user) {
  currentUser = user;
  $('account').hidden = !user;
  if (user) {
    $('account-name').textContent = user.name;
    $('account-role').textContent = user.role === 'admin' ? 'Admin' : 'Student Coordinator';
    $('account-avatar').textContent = initials(user.name);
  }
}

function showLogin(message) {
  clearTickers();
  stopCodeTimer();
  setAccount(null);
  showView('login');
  showAlert($('login-error'), message || '', 'error');
  $('login-password').value = '';
  $('login-email').focus();
}

// Set once a dashboard has been drawn. A later sign-in in the same tab (for
// example another person on a shared computer) reloads the page instead, so
// nothing from the previous user's dashboard can remain on screen.
let dashboardRendered = false;

async function enterApp(user) {
  dashboardRendered = true;
  setAccount(user);
  if (user.role === 'admin') {
    showView('admin');
    await loadAdmin();
  } else {
    showView('student');
    await loadStudent();
  }
}

// ---------------------------------------------------------------------------
// Sign in / sign out (the application session — not attendance)
// ---------------------------------------------------------------------------
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) {
    showAlert($('login-error'), 'Please enter your email and password.', 'error');
    return;
  }
  const button = $('login-submit');
  setBusy(button, true);
  button.textContent = 'Signing in…';
  $('login-error').hidden = true;
  try {
    // The server checks this browser's device key; students may sign in only from an approved device.
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password, device: deviceInfo() } });
    $('login-password').value = '';
    $('login-error').hidden = true;
    if (dashboardRendered) {
      location.reload();
      return;
    }
    await enterApp(data.user);
  } catch (err) {
    showAlert($('login-error'), err.message, 'error');
  } finally {
    setBusy(button, false);
    button.textContent = 'Sign in';
  }
});

$('login-toggle').addEventListener('click', () => {
  const input = $('login-password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('login-toggle').textContent = show ? 'Hide' : 'Show';
  $('login-toggle').setAttribute('aria-pressed', String(show));
  input.focus();
});

// Application sign-out ends the app session only. It never records an
// attendance LOGOUT; a student whose attendance is open is warned first.
async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // The server clears the cookie; show the form regardless.
  }
  showLogin('');
}

$('sign-out').addEventListener('click', async () => {
  if (currentUser && currentUser.role === 'student') {
    let open = student.today && student.today.state.status === 'LOGGED_IN';
    try {
      // Re-check: attendance may have changed on another device.
      const today = await api('/api/attendance/today');
      renderToday(today);
      open = today.state.status === 'LOGGED_IN';
    } catch {
      // Fall back to the last known state.
    }
    if (open) {
      $('signout-dialog').showModal();
      return;
    }
  }
  await signOut();
});

$('signout-back').addEventListener('click', () => {
  $('signout-dialog').close();
  $('attendance-btn').focus();
});

$('signout-anyway').addEventListener('click', async () => {
  $('signout-dialog').close();
  await signOut();
});

// ===========================================================================
// Student Coordinator dashboard
// ===========================================================================
const student = { today: null, clockOffset: 0, historyRange: null };

async function loadStudent() {
  try {
    const today = await api('/api/attendance/today');
    renderToday(today);
    if (!student.historyRange) {
      student.historyRange = { from: addDays(today.date, -29), to: today.date };
      const form = $('history-filter');
      form.from.value = student.historyRange.from;
      form.to.value = student.historyRange.to;
      form.from.max = form.to.max = today.date;
    }
    await loadStudentHistory();
  } catch (err) {
    handleError(err);
  }
}

async function loadStudentHistory() {
  const { from, to } = student.historyRange;
  try {
    const data = await api(`/api/attendance/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    renderStudentHistory(data.days);
  } catch (err) {
    handleError(err);
  }
}

function sessionDurationCell(s) {
  if (s.status === 'complete') return el('td', { class: 'num', text: duration(s.seconds) });
  if (s.status === 'open') return el('td', {}, el('span', { class: 'badge badge-in', text: 'In progress' }));
  return el('td', {}, el('span', { class: 'badge badge-warn', text: 'Unresolved' }));
}

function sessionLogoutText(s) {
  if (!s.logoutAt) return s.status === 'open' ? 'Open' : 'Not logged out';
  const sameDay = dubaiYmd(s.logoutAt) === s.date;
  return sameDay ? time(s.logoutAt) : `${time(s.logoutAt)} (${shortDate(dubaiYmd(s.logoutAt))})`;
}

function renderToday(data) {
  student.today = data;
  // The live timer uses the server's clock, corrected for this device's clock.
  student.clockOffset = Date.parse(data.serverTime) - Date.now();
  const { state, today } = data;
  const loggedIn = state.status === 'LOGGED_IN';

  $('welcome').textContent = `Welcome, ${data.name}`;
  $('student-date').textContent = longDate(data.date);

  $('status').textContent = loggedIn ? 'Currently Logged In' : 'Logged Out';
  $('status-block').classList.toggle('is-in', loggedIn);
  const badge = $('status-badge');
  badge.textContent = loggedIn ? (state.openOvernight ? 'Unresolved' : 'Working') : 'Not working';
  badge.className = loggedIn ? (state.openOvernight ? 'badge badge-warn' : 'badge badge-in') : 'badge';
  $('status-detail').textContent = loggedIn
    ? `Logged in at ${time(state.openSince)}${state.openOvernight ? ` on ${longDate(state.openSinceDate)}` : ''}`
    : 'Press LOGIN when you start working.';

  const warning = $('overnight-warning');
  warning.hidden = !state.openOvernight;
  if (state.openOvernight) {
    warning.textContent =
      `Open session from ${time(state.openSince)} on ${longDate(state.openSinceDate)} was never logged out. ` +
      'It is flagged as unresolved and not counted in your worked hours. Press LOGOUT to close it, then LOGIN to start today.';
  }

  const button = $('attendance-btn');
  $('attendance-label').textContent = loggedIn ? 'LOGOUT' : 'LOGIN';
  button.classList.toggle('is-logout', loggedIn);
  setBusy(button, false);

  $('today-total').textContent = duration(today.totalSeconds);
  $('today-total-note').textContent = today.hasUnresolved ? 'Completed sessions (unresolved sessions not counted)' : 'Completed sessions';
  $('today-count').textContent = String(today.sessionCount);

  // Today's sessions
  const tbody = $('today-sessions').tBodies[0];
  tbody.replaceChildren(
    ...today.sessions.map((s) =>
      el('tr', {}, el('td', { class: 'num', text: time(s.loginAt) }), el('td', { class: 'num', text: sessionLogoutText(s) }), sessionDurationCell(s)),
    ),
  );
  labelCells($('today-sessions'));
  $('today-sessions-empty').hidden = today.sessions.length > 0;

  // Today's activity (individual events)
  const events = $('today-events').tBodies[0];
  events.replaceChildren(
    ...data.events.map((e) =>
      el('tr', {}, el('td', { text: shortDate(dubaiYmd(e.timestamp)) }), el('td', { class: 'num', text: time(e.timestamp) }), el('td', { text: e.type })),
    ),
  );
  labelCells($('today-events'));
  $('today-events-empty').hidden = data.events.length > 0;

  // Live current session (browser-side only; nothing is polled)
  clearTickers();
  const live = $('current-session');
  const liveNote = $('current-session-note');
  $('current-session-card').classList.toggle('is-live', loggedIn && !state.openOvernight);
  if (loggedIn && !state.openOvernight) {
    const tick = () => {
      const seconds = (Date.now() + student.clockOffset - Date.parse(state.openSince)) / 1000;
      live.textContent = elapsed(seconds);
    };
    tick();
    live.classList.remove('is-idle');
    liveNote.textContent = `Since ${time(state.openSince)} · counted at LOGOUT`;
    tickers.add(tick);
    startTicker();
  } else {
    live.textContent = '—';
    live.classList.add('is-idle');
    liveNote.textContent = state.openOvernight ? 'Unresolved session from a previous day' : 'No open session';
  }
}

function renderStudentHistory(days) {
  const list = $('history-list');
  list.replaceChildren(
    ...days.map((day) => {
      const flags = [];
      if (day.hasOpen) flags.push(el('span', { class: 'badge badge-in', text: 'Open' }));
      if (day.hasUnresolved) flags.push(el('span', { class: 'badge badge-warn', text: 'Unresolved' }));
      return el(
        'details',
        { class: 'day' },
        el(
          'summary',
          {},
          el('span', { text: dayDate(day.date) }),
          el('span', { text: String(day.sessionCount) }),
          el('span', {}, duration(day.totalSeconds), ...flags.map((f) => [' ', f]).flat()),
        ),
        el(
          'table',
          { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Login' }), el('th', { text: 'Logout' }), el('th', { text: 'Duration' }))),
          el(
            'tbody',
            {},
            ...day.sessions.map((s) =>
              el('tr', {}, el('td', { class: 'num', text: time(s.loginAt) }), el('td', { class: 'num', text: sessionLogoutText(s) }), sessionDurationCell(s)),
            ),
          ),
        ),
      );
    }),
  );
  $('history-empty').hidden = days.length > 0;
}

/** What the browser reports about the screen and timezone; the server works out the rest. */
function deviceInfo() {
  let timezone = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* not available */ }
  return { screenWidth: window.screen?.width || null, screenHeight: window.screen?.height || null, timezone };
}

$('attendance-btn').addEventListener('click', async () => {
  const button = $('attendance-btn');
  if (button.disabled || !student.today) return;
  const action = student.today.state.status === 'LOGGED_IN' ? 'logout' : 'login';
  $('attendance-msg').hidden = true;
  if (student.today.verificationRequired) {
    openCodeDialog(action);
    return;
  }
  // Before the verification update is live: record directly, as in V1.
  setBusy(button, true); // prevents double clicks; the server also rejects duplicates
  try {
    const data = await api(`/api/attendance/${action}`, { method: 'POST' });
    showAlert($('attendance-msg'), data.message, 'success');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return handleError(err);
    showAlert($('attendance-msg'), err.message, 'error');
  }
  // Re-read the authoritative state (it may also have changed on another device).
  await loadStudent();
});

// ---------------------------------------------------------------------------
// Attendance verification dialog. The code is checked only by the server; the
// page never knows which codes are valid or which admin a code belongs to.
// ---------------------------------------------------------------------------
let codeAction = 'login';

function openCodeDialog(action) {
  codeAction = action;
  $('code-submit').textContent = action === 'login' ? 'Verify & Login' : 'Verify & Logout';
  $('code-input').value = '';
  $('code-error').hidden = true;
  $('code-dialog').showModal();
  $('code-input').focus();
}

$('code-input').addEventListener('input', (event) => {
  const input = event.currentTarget;
  const digits = input.value.replace(/\D/g, '').slice(0, 4);
  if (digits !== input.value) input.value = digits;
  $('code-error').hidden = true;
});

$('code-cancel').addEventListener('click', () => $('code-dialog').close());

$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('code-input').value.trim();
  if (!/^\d{4}$/.test(code)) {
    showAlert($('code-error'), 'Please enter the 4-digit attendance code.', 'error');
    $('code-input').focus();
    return;
  }
  const submit = $('code-submit');
  setBusy(submit, true); // one request at a time; the server also serialises and rejects duplicates
  try {
    const data = await api(`/api/attendance/${codeAction}`, { method: 'POST', body: { code, device: deviceInfo() } });
    $('code-dialog').close();
    showAlert($('attendance-msg'), data.message, 'success');
    await loadStudent();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      $('code-dialog').close();
      return handleError(err);
    }
    if (err instanceof ApiError && err.status === 409) {
      // Already logged in / not logged in (e.g. changed on another device): show the real state.
      $('code-dialog').close();
      showAlert($('attendance-msg'), err.message, 'error');
      await loadStudent();
      return;
    }
    showAlert($('code-error'), err.message, 'error');
    $('code-input').value = '';
    $('code-input').focus();
  } finally {
    setBusy(submit, false);
    submit.textContent = codeAction === 'login' ? 'Verify & Login' : 'Verify & Logout';
  }
});

$('history-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.from.value || !form.to.value) return;
  if (form.from.value > form.to.value) {
    showAlert($('page-error'), 'The start date must be on or before the end date.', 'error');
    return;
  }
  $('page-error').hidden = true;
  student.historyRange = { from: form.from.value, to: form.to.value };
  await loadStudentHistory();
});

// ===========================================================================
// Admin dashboard
// ===========================================================================
// Data is loaded when the page opens and when Refresh is pressed — never polled.
const admin = { overview: null, clockOffset: 0, historyInitialised: false, auditInitialised: false };

async function loadAdmin() {
  const button = $('admin-refresh');
  setBusy(button, true);
  try {
    const data = await api('/api/admin/attendance');
    renderAdminOverview(data);
    if (!admin.historyInitialised) initAdminHistory(data);
    $('device-alerts-card').hidden = !data.deviceApprovalEnabled;
    if (data.verificationEnabled) {
      if (!admin.auditInitialised) initAudit(data);
      await Promise.all([loadDevices(), loadAudit(), data.deviceApprovalEnabled ? loadDeviceRequests() : null]);
    }
  } catch (err) {
    handleError(err);
  } finally {
    setBusy(button, false);
  }
}

const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');

/** Device key with a short "Firefox · Windows · Desktop" line; "Not recorded" for older records. */
function deviceCell(device, verificationEnabled = true) {
  if (!device) return el('td', { class: 'muted-cell', text: verificationEnabled ? 'Not recorded' : '—' });
  return el(
    'td',
    {},
    el('span', { class: 'device-key', text: device.key }),
    el('span', { class: 'subtle', text: [device.browser || 'Unknown browser', device.os || 'Unknown system', cap(device.type)].join(' · ') }),
  );
}

// The admin's attendance code. The server decides whether a code is valid and
// issues the next one; this page only counts down locally (no network) and asks
// for the new code once, when the current 30-minute window ends.
const codeCard = { timer: null, expiresAt: 0, refreshing: false, lastRefresh: 0 };

function stopCodeTimer() {
  clearInterval(codeCard.timer);
  codeCard.timer = null;
}

function setCodeMeta(countdown, until) {
  $('admin-code-countdown').textContent = countdown;
  $('admin-code-until').textContent = until;
}

function renderCodeCard(data) {
  stopCodeTimer();
  $('verification-pending').hidden = data.verificationEnabled;
  $('code-card').hidden = !data.verificationEnabled;
  if (!data.verificationEnabled) return;
  if (!data.attendanceCode) {
    // Before the 30-minute update, an admin session that started earlier has no code yet.
    $('admin-code').textContent = '––––';
    $('admin-code-note').textContent = 'Sign out and sign in again to receive your attendance code.';
    setCodeMeta('', '');
    return;
  }
  $('admin-code').textContent = data.attendanceCode;
  if (!data.attendanceCodeRotates) {
    $('admin-code-note').textContent = 'Share this code with students during attendance verification.';
    setCodeMeta('', `Valid while you are signed in · until ${time(data.attendanceCodeExpiresAt)}`);
    return;
  }
  $('admin-code-note').textContent = 'Attendance code refreshes every 30 minutes. Share it only with students who are present.';
  // The server's expiry, converted to this device's clock.
  codeCard.expiresAt = Date.parse(data.attendanceCodeExpiresAt) - (Date.parse(data.serverTime) - Date.now());
  const until = data.attendanceCodeExpiresAt === data.sessionExpiresAt
    ? `until ${time(data.attendanceCodeExpiresAt)}, when your admin session ends`
    : `until ${time(data.attendanceCodeExpiresAt)}`;
  const tick = () => {
    const left = Math.max(0, Math.ceil((codeCard.expiresAt - Date.now()) / 1000));
    if (left > 0) {
      setCodeMeta(`Valid for ${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`, until);
      return;
    }
    // This code no longer works: hide it and fetch the next one.
    stopCodeTimer();
    $('admin-code').textContent = '––––';
    setCodeMeta('Refreshing…', '');
    refreshCode();
  };
  tick();
  if (!codeCard.timer && codeCard.expiresAt > Date.now()) codeCard.timer = setInterval(tick, 1000);
}

async function refreshCode() {
  if (codeCard.refreshing) return;
  // At most one request every 5 seconds, even if this device's clock runs ahead of the server's.
  const wait = codeCard.lastRefresh + 5000 - Date.now();
  if (wait > 0) {
    setTimeout(refreshCode, wait);
    return;
  }
  codeCard.refreshing = true;
  codeCard.lastRefresh = Date.now();
  try {
    renderCodeCard(await api('/api/admin/code'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return handleError(err);
    setCodeMeta('', 'Could not load the new code. Press Refresh.');
  } finally {
    codeCard.refreshing = false;
  }
}

// A hidden tab's timers can run late; catch up as soon as the dashboard is visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || document.body.dataset.view !== 'admin') return;
  if (codeCard.expiresAt && Date.now() >= codeCard.expiresAt && $('code-card').hidden === false) refreshCode();
});

function statusCell(state) {
  if (state.status !== 'LOGGED_IN') return el('td', {}, el('span', { class: 'badge', text: 'Logged Out' }));
  if (state.openOvernight) {
    return el(
      'td',
      {},
      el('span', { class: 'badge badge-warn', text: 'Unresolved' }),
      el('span', { class: 'subtle', text: `Open session from ${time(state.openSince)} (${shortDate(state.openSinceDate)})` }),
    );
  }
  return el('td', {}, el('span', { class: 'badge badge-in', text: 'Logged In' }), el('span', { class: 'subtle', text: `since ${time(state.openSince)}` }));
}

function withFlag(cell, flagged) {
  if (flagged) cell.append(el('span', { class: 'badge badge-warn badge-block', text: 'Potential shared device', title: 'Multiple student accounts used the same device during overlapping attendance activity.' }));
  return cell;
}

function renderAdminOverview(data) {
  admin.overview = data;
  renderCodeCard(data);
  admin.clockOffset = Date.parse(data.serverTime) - Date.now();
  $('admin-date').textContent = longDate(data.date);
  $('admin-updated').textContent = `Updated ${time(data.serverTime)}`;

  const s = data.summary;
  $('sum-total').textContent = String(s.totalCoordinators);
  $('sum-in').textContent = String(s.loggedIn);
  $('sum-out').textContent = String(s.loggedOut);
  $('sum-hours').textContent = duration(s.todayTotalSeconds);
  $('sum-events').textContent = String(s.todayEvents);

  clearTickers();
  const rows = data.coordinators.map((c) => {
    const totalCell = el('td', { class: 'num' }, duration(c.todayTotalSeconds));
    if (c.hasUnresolved) totalCell.append(el('span', { class: 'subtle', text: 'excludes unresolved session' }));
    if (c.state.status === 'LOGGED_IN' && !c.state.openOvernight) {
      const live = el('span', { class: 'live-inline' });
      const tick = () => {
        const seconds = (Date.now() + admin.clockOffset - Date.parse(c.state.openSince)) / 1000;
        live.textContent = `+ current ${elapsed(seconds)}`;
      };
      tick();
      tickers.add(tick);
      totalCell.append(live);
    }
    return el(
      'tr',
      {},
      el(
        'td',
        { class: 'cell-title' },
        el(
          'span',
          { class: 'person' },
          el('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true', text: initials(c.name) }),
          el('button', { type: 'button', class: 'link-btn', text: c.name, title: 'View attendance history', onclick: () => showCoordinatorHistory(c.id) }),
        ),
      ),
      withFlag(statusCell(c.state), c.sharedDeviceFlag),
      el('td', { class: 'num', text: c.firstLogin ? time(c.firstLogin) : '—' }),
      el('td', { class: 'num', text: c.lastLogout ? time(c.lastLogout) : '—' }),
      el('td', { class: 'num', text: String(c.sessionCount) }),
      totalCell,
      deviceCell(c.lastDevice ?? null, data.verificationEnabled),
    );
  });
  $('coordinator-table').tBodies[0].replaceChildren(...rows);
  labelCells($('coordinator-table'));
  $('coordinator-empty').hidden = rows.length > 0;
  if (tickers.size) startTicker();

  $('activity-table').tBodies[0].replaceChildren(
    ...data.activity.map((a) =>
      el(
        'tr',
        {},
        el('td', { text: shortDate(dubaiYmd(a.timestamp)) }),
        el('td', { class: 'num', text: time(a.timestamp) }),
        el('td', { text: a.name }),
        el('td', { text: a.type }),
        deviceCell(a.device ?? null, data.verificationEnabled),
        el('td', { class: a.verifiedBy ? null : 'muted-cell', text: a.verifiedBy || (data.verificationEnabled ? 'Not recorded' : '—') }),
      ),
    ),
  );
  labelCells($('activity-table'));
  $('activity-empty').hidden = data.activity.length > 0;
}

function initAdminHistory(data) {
  const form = $('admin-history-filter');
  form.coordinator.replaceChildren(...data.coordinators.map((c) => el('option', { value: c.id, text: c.name })));
  form.from.value = addDays(data.date, -29);
  form.to.value = data.date;
  form.from.max = form.to.max = data.date;
  $('admin-history-title').textContent = 'Choose a coordinator and a date range, then press Show — or click a name above.';
  admin.historyInitialised = true;
}

function showCoordinatorHistory(id) {
  const form = $('admin-history-filter');
  form.coordinator.value = id;
  form.requestSubmit();
  $('admin-history-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** A LOGIN or LOGOUT time with "Verified by …" and the device underneath (admin view). */
function historyTimeCell(text, detail, side) {
  const cell = el('td', { class: 'num' }, el('span', { text }));
  if (!detail || !side) return cell;
  const by = side === 'login' ? detail.loginVerifiedBy : detail.logoutVerifiedBy;
  const device = side === 'login' ? detail.loginDevice : detail.logoutDevice;
  cell.append(
    el('span', { class: by ? 'verified' : 'subtle', text: by ? `Verified by ${by}` : 'Verification not recorded' }),
    el('span', { class: 'subtle', text: device ? `${device.key} · ${device.browser || 'Unknown browser'} · ${device.os || 'Unknown system'}` : 'Device not recorded' }),
  );
  return cell;
}

async function loadCoordinatorHistory(id, from, to) {
  const params = new URLSearchParams({ from, to });
  const data = await api(`/api/admin/attendance/${encodeURIComponent(id)}?${params}`);
  $('admin-history-title').textContent = `${data.coordinator.name} · ${longDate(data.from)} – ${longDate(data.to)}`;

  // One row per session; Date and Daily Total span all of that day's sessions.
  const rows = [];
  for (const day of data.days) {
    const flags = day.hasUnresolved ? ' (excludes unresolved)' : '';
    day.sessions.forEach((s, i) => {
      const row = el('tr', { class: i === 0 ? 'day-start' : null });
      if (i === 0) row.append(el('td', { rowspan: day.sessions.length, text: dayDate(day.date) }));
      row.append(
        historyTimeCell(time(s.loginAt), s.detail, 'login'),
        historyTimeCell(sessionLogoutText(s), s.detail, s.logoutAt ? 'logout' : null),
        sessionDurationCell(s),
      );
      if (i === 0) row.append(el('td', { class: 'num', rowspan: day.sessions.length, text: duration(day.totalSeconds) + flags }));
      rows.push(row);
    });
  }
  $('admin-history-table').tBodies[0].replaceChildren(...rows);
  $('admin-history-empty').hidden = rows.length > 0;
}

async function loadDevices() {
  $('devices-card').hidden = false;
  const data = await api('/api/admin/devices');
  const rows = data.devices.map((d) =>
    el(
      'tr',
      {},
      el('td', { class: 'cell-title' }, el('span', { class: 'device-key', text: d.key })),
      el(
        'td',
        {},
        el('span', { text: [d.browser || 'Unknown browser', d.os || 'Unknown system'].join(' · ') }),
        el('span', { class: 'subtle', text: [cap(d.type), d.screen, d.timezone].filter(Boolean).join(' · ') }),
      ),
      el('td', {}, el('span', { text: d.usedBy.map((u) => u.name).join(', ') || '—' }), el('span', { class: 'subtle', text: `Last seen ${shortDate(dubaiYmd(d.lastSeen))} ${time(d.lastSeen)}` })),
      el('td', {}, ...(d.recent.length
        ? d.recent.slice(0, 4).map((a) => el('span', { class: 'activity-line', text: `${a.name} — ${a.type} ${time(a.timestamp)}` }))
        : [el('span', { class: 'subtle', text: 'No recent activity' })])),
      el('td', {}, d.potentiallyShared
        ? el('span', { class: 'badge badge-warn', text: 'Potential shared device' })
        : el('span', { class: 'badge', text: 'Single user' })),
    ),
  );
  $('devices-table').tBodies[0].replaceChildren(...rows);
  labelCells($('devices-table'));
  $('devices-empty').hidden = rows.length > 0;
}

const AUDIT_LABELS = {
  ATTENDANCE_LOGIN: 'LOGIN',
  ATTENDANCE_LOGOUT: 'LOGOUT',
  INVALID_ATTENDANCE_CODE: 'Invalid attendance code',
  DEVICE_SHARING_DETECTED: 'Potential shared device',
  NEW_DEVICE: 'New device',
  DEVICE_LOGIN_BLOCKED: 'Sign-in blocked',
  DEVICE_APPROVED: 'Device approved',
  DEVICE_DENIED: 'Device denied',
  DEVICE_REGISTERED: 'First device registered',
  SIGN_IN: 'Sign-in',
};
const RESULT_BADGE = { SUCCESS: 'badge badge-in', FAILED: 'badge badge-danger', FLAGGED: 'badge badge-warn', INFO: 'badge' };
const RESULT_TEXT = { SUCCESS: 'Verified', FAILED: 'Failed', FLAGGED: 'Flagged', INFO: 'Recorded' };

function initAudit(data) {
  const form = $('audit-filter');
  form.from.value = addDays(data.date, -6);
  form.to.value = data.date;
  form.from.max = form.to.max = data.date;
  $('audit-card').hidden = false;
  admin.auditInitialised = true;
}

async function loadAudit() {
  const form = $('audit-filter');
  const params = new URLSearchParams({ from: form.from.value, to: form.to.value, action: form.action.value });
  const data = await api(`/api/admin/audit?${params}`);
  const rows = data.entries.map((e) => {
    const activity = el('td', {}, el('span', { text: AUDIT_LABELS[e.action] || e.action }));
    if (e.action === 'INVALID_ATTENDANCE_CODE' && e.attemptedAction) activity.append(el('span', { class: 'subtle', text: `${e.codeExpired ? 'Expired code' : 'Wrong code'} while trying to ${e.attemptedAction}` }));
    if (e.action === 'DEVICE_LOGIN_BLOCKED') activity.append(el('span', { class: 'subtle', text: e.deviceStatus === 'denied' ? 'Device was denied by an admin' : 'Device waiting for admin approval' }));
    if (e.action === 'DEVICE_SHARING_DETECTED') activity.append(el('span', { class: 'subtle', text: `${e.relatedStudent ? `Also used by ${e.relatedStudent}. ` : ''}${e.message || ''}` }));
    return el(
      'tr',
      {},
      el('td', { class: 'num' }, el('span', { text: shortDate(dubaiYmd(e.at)) }), el('span', { class: 'subtle', text: time(e.at) })),
      el('td', { text: e.student || '—' }),
      activity,
      deviceCell(e.device),
      el('td', { class: e.verifiedBy ? null : 'muted-cell' }, el('span', { text: e.verifiedBy || '—' }), e.codeUsed ? el('span', { class: 'subtle', text: `Code ${e.codeUsed}` }) : null),
      el('td', {}, el('span', { class: RESULT_BADGE[e.result] || 'badge', text: RESULT_TEXT[e.result] || e.result })),
    );
  });
  $('audit-table').tBodies[0].replaceChildren(...rows);
  labelCells($('audit-table'));
  $('audit-empty').hidden = rows.length > 0;
}

$('audit-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.from.value || !form.to.value) return;
  if (form.from.value > form.to.value) {
    showAlert($('page-error'), 'The start date must be on or before the end date.', 'error');
    return;
  }
  $('page-error').hidden = true;
  try {
    await loadAudit();
  } catch (err) {
    handleError(err);
  }
});

// ---------------------------------------------------------------------------
// Device security alerts: a student tried to sign in from a device that is not
// approved. The server decides everything; these buttons only send the admin's
// decision for exactly one student + device, which the server re-checks.
// ---------------------------------------------------------------------------
const when = (iso) => `${shortDate(dubaiYmd(iso))} · ${time(iso)}`;

function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

async function loadDeviceRequests() {
  const data = await api('/api/admin/device-requests');
  $('device-alerts-list').replaceChildren(
    ...data.pending.map((r) => {
      const details = el(
        'dl',
        {},
        el('dt', { text: 'Email' }), el('dd', { text: r.email }),
        el('dt', { text: 'Device' }), el('dd', {}, el('span', { text: r.device.summary }), el('span', { class: 'subtle', text: r.device.key })),
        el('dt', { text: 'Time' }), el('dd', { text: when(r.requestedAt) }),
      );
      if (r.attempts > 1 && r.lastAttemptAt) details.append(el('dt', { text: 'Attempts' }), el('dd', { text: `${r.attempts} (latest ${when(r.lastAttemptAt)})` }));
      if (r.alsoApprovedFor.length) details.append(el('dt', { text: 'Note' }), el('dd', { text: `This device is also approved for ${r.alsoApprovedFor.join(', ')}.` }));
      details.append(el('dt', { text: 'Status' }), el('dd', {}, el('span', { class: 'badge badge-warn', text: 'Pending' })));
      const approve = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Approve' });
      const deny = el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Deny' });
      approve.addEventListener('click', () => decideDevice(r, 'approve', [approve, deny]));
      deny.addEventListener('click', () => decideDevice(r, 'deny', [approve, deny]));
      return el(
        'article',
        { class: 'device-alert' },
        el('div', { class: 'device-alert-icon', 'aria-hidden': 'true' }, svgIcon('i-alert')),
        el('div', {}, el('h3', { text: '⚠ New Device Detected' }), el('p', { class: 'device-alert-line', text: `${r.student} tried to login via new device` }), details),
        el('div', { class: 'device-alert-actions' }, approve, deny),
      );
    }),
  );
  $('device-alerts-empty').hidden = data.pending.length > 0;
  $('device-alerts-hint').textContent = data.pending.length ? `${data.pending.length} pending` : '';

  const STATUS = { approved: ['badge badge-in', 'Approved'], denied: ['badge badge-danger', 'Denied'] };
  $('device-history-table').tBodies[0].replaceChildren(
    ...data.recent.map((r) => {
      const [cls, label] = r.firstDevice ? ['badge', 'First device'] : STATUS[r.status];
      return el(
        'tr',
        {},
        el('td', {}, el('span', { text: r.student }), el('span', { class: 'subtle', text: r.email })),
        el('td', {}, el('span', { text: r.device.summary }), el('span', { class: 'subtle', text: r.device.key })),
        el('td', {}, el('span', { class: cls, text: label })),
        el('td', { text: r.firstDevice ? 'Automatic (first sign-in)' : r.decidedBy || '—' }),
        el('td', { class: 'num', text: r.decidedAt ? when(r.decidedAt) : '—' }),
      );
    }),
  );
  labelCells($('device-history-table'));
  $('device-history-empty').hidden = data.recent.length > 0;
}

async function decideDevice(request, decision, buttons) {
  const verb = decision === 'approve' ? 'Approve' : 'Deny';
  if (!window.confirm(`${verb} this device for ${request.student}?\n\n${request.device.summary}`)) return;
  buttons.forEach((b) => setBusy(b, true));
  try {
    await api('/api/admin/device-requests/decision', { method: 'POST', body: { userId: request.userId, deviceId: request.deviceId, decision } });
    showAlert(
      $('device-alerts-msg'),
      decision === 'approve'
        ? `Device approved for ${request.student}. They can now sign in from that device.`
        : `Device denied for ${request.student}. They cannot sign in from that device.`,
      'success',
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return handleError(err);
    showAlert($('device-alerts-msg'), err.message, 'error');
  }
  try {
    await Promise.all([loadDeviceRequests(), loadAudit()]);
  } catch (err) {
    handleError(err);
  }
}

$('admin-refresh').addEventListener('click', loadAdmin);

$('admin-history-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.coordinator.value || !form.from.value || !form.to.value) return;
  if (form.from.value > form.to.value) {
    showAlert($('page-error'), 'The start date must be on or before the end date.', 'error');
    return;
  }
  $('page-error').hidden = true;
  try {
    await loadCoordinatorHistory(form.coordinator.value, form.from.value, form.to.value);
  } catch (err) {
    handleError(err);
  }
});

// ===========================================================================
// Start
// ===========================================================================
(async function boot() {
  try {
    const data = await api('/api/auth/me');
    await enterApp(data.user);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) showLogin('');
    else {
      showLogin('');
      showAlert($('login-error'), err.message, 'error');
    }
  }
})();
