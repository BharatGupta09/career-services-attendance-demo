#!/usr/bin/env node
// Loads the synthetic demo dataset (scripts/lib/demo-data.mjs) into a demo
// database that has just been migrated: demo passwords for the ten fictional
// users, devices, four weeks of attendance and the matching audit trail.
//
//   DEMO_MODE=true npm run db:seed-demo     (asks for the connection string, hidden)
//
// Safety barrier (scripts/lib/demo-guard.mjs): refuses to run without
// DEMO_MODE=true, reads only DEMO_DATABASE_URL, refuses a database holding any
// account outside the demo directory, and refuses a database that already has
// attendance, device or audit rows. Everything is written in one transaction.
//
// DEMO_PASSWORD (optional) sets the password of all ten demo accounts; the
// default is the documented demo password. Use your own for a public deployment.
import { Client, neonConfig } from '@neondatabase/serverless';
import { DEFAULT_DEMO_PASSWORD, seedDemoData } from './lib/demo-data.mjs';
import { assertDemoDatabase, assertEmptyActivity } from './lib/demo-guard.mjs';
import { closePrompt, databaseUrl } from './lib/prompt.mjs';

const url = await databaseUrl();
closePrompt();
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This script needs Node.js 22 or newer (global WebSocket).');
  process.exit(1);
}
neonConfig.webSocketConstructor = globalThis.WebSocket;

const client = new Client(url);
await client.connect();
try {
  const query = (text, params) => client.query(text, params);
  const users = await assertDemoDatabase(query);
  if (users !== 10) throw new Error('Expected the ten demo users from migrations 003/004. Run `npm run db:migrate` first.');
  await assertEmptyActivity(query);
  await client.query('BEGIN');
  const counts = await seedDemoData(query, { password: process.env.DEMO_PASSWORD || DEFAULT_DEMO_PASSWORD });
  await client.query('COMMIT');
  console.log(`Seeded ${counts.events} attendance events, ${counts.audit} audit entries and ${counts.devices} devices for ${counts.users} demo users.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
