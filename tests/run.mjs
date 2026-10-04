// npm test: bundle the Worker, then run each suite in its own process
// (each gets a fresh in-memory database and a fresh Worker module).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (file, env = {}) => spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit', env: { ...process.env, ...env } }).status;

if (run('build.mjs') !== 0) process.exit(1);
const suites = [
  ['api.test.mjs', 'V1 regression suite (auth, isolation, attendance, admin, constraints)'],
  // Written for 005/006 (students may use any device); run at that level, which is also
  // how a deployment behaves until migration 007 is applied.
  ['verification.test.mjs', 'devices, admin attendance codes, audit trail (up to 006)', { MIGRATIONS_UPTO: '006' }],
  ['rotation.test.mjs', 'attendance codes rotating every 30 minutes (up to 006)', { MIGRATIONS_UPTO: '006' }],
  ['device-approval.test.mjs', 'student sign-in locked to admin-approved devices (migration 007)'],
  ['revocation.test.mjs', 'revoking access for all users (users.is_active)'],
  ['interim.test.mjs', 'migration 005 applied, 006 not yet (one code per session)', { MIGRATIONS_UPTO: '005' }],
  ['legacy.test.mjs', 'before migration 005 is applied (V1 behaviour)', { MIGRATIONS_UPTO: '004' }],
];
let failed = 0;
for (const [file, title, env] of suites) {
  console.log(`\n=== ${title} (${file}) ===`);
  if (run(file, env) !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
