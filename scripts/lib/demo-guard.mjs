// Safety barrier for every script in this repository that connects to a database.
//
// This is the public demo edition: its scripts must only ever touch a demo
// database. Three independent checks make it hard to point them anywhere else
// by accident:
//
//   1. DEMO_MODE=true must be set explicitly for the command.
//   2. The connection string is read from DEMO_DATABASE_URL — never from
//      DATABASE_URL — so a connection string left in the shell for some other
//      system is simply ignored.
//   3. Before anything is written, the database itself is inspected: every user
//      account in it must belong to the fictional demo directory
//      (@example.com / @example.invalid / @example.test). A database holding any
//      other account is refused.
import { DEMO_EMAIL_RE } from './demo-data.mjs';

export class DemoGuardError extends Error {}

/** Check 1: the explicit opt-in. Call before asking for or using a connection string. */
export function requireDemoMode(env = process.env) {
  if (env.DEMO_MODE !== 'true') {
    throw new DemoGuardError(
      'Refusing to run: this script only works against a demo database.\n' +
        'Set DEMO_MODE=true and DEMO_DATABASE_URL to a database created for the demo.',
    );
  }
}

/**
 * Check 3: the database's own contents. `query(text)` must return `{ rows }`.
 * Returns the number of demo users found (0 for a database without migrations).
 */
export async function assertDemoDatabase(query) {
  const [{ has_users }] = (await query(`SELECT to_regclass('public.users') IS NOT NULL AS has_users`)).rows;
  if (!has_users) return 0;
  const { rows } = await query('SELECT email FROM users');
  const foreign = rows.filter((r) => !DEMO_EMAIL_RE.test(r.email));
  if (foreign.length) {
    // Never print the addresses themselves.
    throw new DemoGuardError(
      `Refusing to run: the target database contains ${foreign.length} account(s) outside the demo directory ` +
        '(@example.com / .invalid / .test). It does not look like a demo database.',
    );
  }
  return rows.length;
}

/** Check 3, stricter: seeding is only allowed into a freshly migrated, empty database. */
export async function assertEmptyActivity(query) {
  const [r] = (await query(
    `SELECT (SELECT count(*) FROM attendance_events)::int AS events,
            (SELECT count(*) FROM audit_log)::int AS audit,
            (SELECT count(*) FROM devices)::int AS devices`,
  )).rows;
  if (r.events || r.audit || r.devices) {
    throw new DemoGuardError(
      'Refusing to seed: the database already has attendance, audit or device rows. ' +
        'The audit log is append-only by design, so seed a fresh database (for example a new Neon branch) instead.',
    );
  }
}
