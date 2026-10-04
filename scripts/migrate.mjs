#!/usr/bin/env node
// Applies migrations/NNN_*.sql to the demo database in DEMO_DATABASE_URL, in
// order, each in its own transaction, recording applied versions in
// schema_migrations. Safe to run repeatedly: already-applied files are skipped.
//
//   DEMO_MODE=true npm run db:migrate        (asks for the connection string, hidden)
//
// Refuses to run unless DEMO_MODE=true, and refuses a database that holds any
// account outside the demo directory (scripts/lib/demo-guard.mjs).
//
// Uses the Neon driver's WebSocket Client (Node 22+ has a global WebSocket),
// because a migration file contains several statements.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, neonConfig } from '@neondatabase/serverless';
import { assertDemoDatabase } from './lib/demo-guard.mjs';
import { closePrompt, databaseUrl } from './lib/prompt.mjs';

const url = await databaseUrl();
closePrompt();
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This script needs Node.js 22 or newer (global WebSocket).');
  process.exit(1);
}
neonConfig.webSocketConstructor = globalThis.WebSocket;

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

const client = new Client(url);
await client.connect();
try {
  await assertDemoDatabase((text) => client.query(text)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log('done');
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('FAILED');
      console.error(err.message);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(count ? `${count} migration(s) applied.` : 'Migrations up to date.');
} finally {
  await client.end();
}
