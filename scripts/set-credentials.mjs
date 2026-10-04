#!/usr/bin/env node
// Interactive user setup: set the email address and password for any of the
// users in the demo database. Nothing is written to disk.
//
//   DEMO_MODE=true npm run db:set-credentials     (asks for the connection string, hidden)
//
// The password is typed hidden, sent to PostgreSQL over TLS as a bound
// parameter and hashed there with bcrypt (pgcrypto crypt/gen_salt). Only the
// hash is stored; nothing is written to disk. Changing a password signs that
// user out everywhere.
import { neon } from '@neondatabase/serverless';
import { assertDemoDatabase } from './lib/demo-guard.mjs';
import { ask, askHidden, closePrompt, databaseUrl } from './lib/prompt.mjs';

const sql = neon(await databaseUrl());
try {
  await assertDemoDatabase(async (text) => ({ rows: await sql.query(text) }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listUsers() {
  const users = await sql`
    SELECT id, full_name, email, role, is_active, password_hash IS NOT NULL AS has_password
    FROM users ORDER BY role DESC, full_name`;
  console.log('\n #  Name                  Role     Active  Password  Email');
  users.forEach((u, i) => {
    console.log(
      `${String(i + 1).padStart(2)}  ${u.full_name.padEnd(20)}${u.role.padEnd(7)}  ${(u.is_active ? 'yes' : 'no').padEnd(6)}  ${(u.has_password ? 'set' : 'NOT SET').padEnd(8)}  ${u.email}`,
    );
  });
  return users;
}

async function editUser(u, { passwordOnly = false } = {}) {
  console.log(`\n${u.full_name} (${u.role}, ${u.email}). Press Enter to keep a value unchanged.`);
  let email = passwordOnly ? '' : (await ask(`  Email [${u.email}]: `)).toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    console.log('  That does not look like an email address; email unchanged.');
    email = '';
  }
  let password = await askHidden('  New password (hidden, min 8 chars): ');
  if (password) {
    if (password.length < 8 || password.length > 72) {
      console.log('  Password must be 8–72 characters; password unchanged.');
      password = '';
    } else if ((await askHidden('  Repeat password: ')) !== password) {
      console.log('  Passwords did not match; password unchanged.');
      password = '';
    }
  }
  if (!email && !password) {
    console.log('  Nothing changed.');
    return;
  }
  try {
    await sql.transaction([
      sql`UPDATE users SET
            email = COALESCE(${email || null}::text, email),
            password_hash = CASE WHEN ${password || null}::text IS NULL THEN password_hash
                                 ELSE crypt(${password || null}::text, gen_salt('bf', 10)) END
          WHERE id = ${u.id}::uuid`,
      // A new password ends every existing application session for this user.
      sql`DELETE FROM sessions WHERE user_id = ${u.id}::uuid AND ${password ? true : false}::boolean`,
    ]);
    console.log(`  Saved${email ? ' email' : ''}${email && password ? ' and' : ''}${password ? ' password' : ''}.`);
  } catch (err) {
    console.log(err.code === '23505' ? '  That email is already used by another user.' : `  Failed: ${err.message}`);
  }
}

try {
  for (;;) {
    const users = await listUsers();
    const choice = await ask('\nNumber to edit, "missing" = passwords for users without one, "all" = everyone, Enter = quit: ');
    if (!choice) break;
    if (choice.toLowerCase() === 'missing') {
      for (const u of users.filter((x) => !x.has_password)) await editUser(u, { passwordOnly: true });
      continue;
    }
    if (choice.toLowerCase() === 'all') {
      for (const u of users) await editUser(u);
      continue;
    }
    const u = users[Number(choice) - 1];
    if (u) await editUser(u);
    else console.log('No such number.');
  }
} finally {
  closePrompt();
}
