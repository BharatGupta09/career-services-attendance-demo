// Test harness: the real Worker code (bundled by tests/build.mjs with the Neon driver
// swapped for tests/neon-shim.mjs) + an in-memory PostgreSQL (PGlite) + public/ assets.
// Test accounts use a random password generated per run; nothing leaves this process.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

import { fileURLToPath } from 'node:url';
export const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_PASSWORD = process.env.TEST_PASSWORD || crypto.randomBytes(12).toString('base64url');

export async function setupDb({ testAccounts = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  globalThis.__PGLITE__ = db;
  await db.exec(`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(P, 'migrations');
  const applied = [];
  const upto = process.env.MIGRATIONS_UPTO || '999';
  for (const f of (await readdir(dir)).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f.slice(0, 3) <= upto).sort()) {
    await db.exec('BEGIN');
    await db.exec(await readFile(path.join(dir, f), 'utf8'));
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f.replace(/\.sql$/, '')]);
    await db.exec('COMMIT');
    applied.push(f);
  }
  if (!testAccounts) return { db, applied };
  // Local-only test accounts (never exist outside this in-memory database).
  const users = [
    ['Test Student A', 'test.a@example.test', 'student', true],
    ['Test Student B', 'test.b@example.test', 'student', true],
    ['Test Student C', 'test.c@example.test', 'student', true],
    ['Test Student D', 'test.d@example.test', 'student', true],
    ['Test Inactive', 'test.inactive@example.test', 'student', false],
    ['Test Admin', 'test.admin@example.test', 'admin', true],
  ];
  for (const [n, e, r, a] of users) {
    await db.query(`INSERT INTO users (full_name, email, role, is_active, password_hash) VALUES ($1,$2,$3,$4, crypt($5, gen_salt('bf', 10)))`, [n, e, r, a, TEST_PASSWORD]);
  }
  return { db, applied };
}

function parseHeadersFile(text) {
  const headers = {};
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) headers[m[1]] = m[2].trim();
  }
  return headers;
}

export async function startServer(port = 8788) {
  const worker = (await import('./.build/worker.mjs')).default;
  const assetHeaders = parseHeadersFile(await readFile(path.join(P, 'public/_headers'), 'utf8'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const ASSETS = {
    async fetch(req) {
      let p = new URL(req.url).pathname;
      if (p === '/') p = '/index.html';
      try {
        const body = await readFile(path.join(P, 'public', path.normalize(p).replace(/^([\/])+/, '')));
        return new Response(body, { headers: { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', ...assetHeaders } });
      } catch { return new Response('Not found', { status: 404 }); }
    },
  };
  const env = { DATABASE_URL: 'pglite://in-memory', SESSION_HOURS: '12', ASSETS };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env);
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, worker, env, base: `http://localhost:${port}` };
}
