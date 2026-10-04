#!/usr/bin/env node
// Zero-setup local demo: the real Worker code, an in-memory PostgreSQL (PGlite,
// the same engine the test suites use) and the synthetic demo dataset.
//
//   npm run demo          then open http://localhost:8787
//
// Nothing leaves this machine: no Neon, no Cloudflare, no network database and
// no DATABASE_URL. The data lives in memory and is rebuilt on every start.
//
// LOGIN/LOGOUT need an admin's attendance code. So that one browser is enough
// to try the student view, this script keeps one admin session of its own and
// prints that admin's current code here whenever it rotates (every 30 minutes).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DEMO_PASSWORD, seedDemoData } from './lib/demo-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const PASSWORD = process.env.DEMO_PASSWORD || DEFAULT_DEMO_PASSWORD;
const CODE_ADMIN = 'elena.rossi@example.com';

// Bundle the Worker exactly as the tests do (Neon driver swapped for PGlite).
if (spawnSync(process.execPath, [path.join(root, 'tests', 'build.mjs')], { stdio: 'inherit' }).status !== 0) process.exit(1);
const { setupDb, startServer } = await import('../tests/server.mjs');

const { db } = await setupDb({ testAccounts: false });
const counts = await seedDemoData((text, params) => db.query(text, params), { password: PASSWORD });
const { worker, env, base } = await startServer(PORT);

console.log(`
Career Services Attendance — local demo (synthetic data only)
  ${base}

  Seeded: ${counts.users} fictional users, ${counts.events} attendance events, ${counts.audit} audit entries.
  Password for every demo account: ${PASSWORD}

  Admin:    priya.raman@example.com
  Student:  maya.thompson@example.com   (her first sign-in approves your browser)
            omar.haddad@example.com     (likewise)
            kenji.watanabe@example.com  (device-locked: your browser becomes a pending request)

  Data is in memory and resets when this process stops (Ctrl+C).
`);

// ---- the attendance code helper ---------------------------------------------
let cookie = null;
let shown = null;
let expiresAt = 0;
async function call(p, init = {}) {
  const res = await worker.fetch(new Request(base + p, { ...init, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...init.headers } }), env);
  return { res, json: await res.json().catch(() => null) };
}
async function refreshCode() {
  if (Date.now() < expiresAt) return;
  let { res, json } = cookie ? await call('/api/admin/code') : { res: { status: 401 } };
  if (res.status === 401) {
    const r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: CODE_ADMIN, password: PASSWORD }) });
    if (r.res.status !== 200) return console.error('Could not sign in the code helper admin:', r.json?.error);
    cookie = r.res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    ({ res, json } = await call('/api/admin/code'));
  }
  if (!json?.attendanceCode) return;
  expiresAt = Date.parse(json.attendanceCodeExpiresAt);
  if (json.attendanceCode !== shown) {
    shown = json.attendanceCode;
    const until = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(expiresAt));
    console.log(`Attendance code (Elena Rossi, admin): ${shown}   valid until ${until} Dubai time`);
  }
}
await refreshCode();
setInterval(() => refreshCode().catch((err) => console.error(err.message)), 15_000).unref?.();
// Keep the process alive for the HTTP server.
process.on('SIGINT', () => process.exit(0));
