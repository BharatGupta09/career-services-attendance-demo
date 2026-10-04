// Terminal prompts shared by the scripts. Hidden answers (passwords, the
// database URL) are never echoed and never written anywhere.
import readline from 'node:readline';
import { requireDemoMode } from './demo-guard.mjs';

let rl = null;
let muted = false;

function iface() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (!muted) write(s);
      else if (s.includes('\n') || s.includes('\r')) write('\n');
    };
  }
  return rl;
}

export const ask = (question) => new Promise((resolve) => iface().question(question, (a) => resolve(a.trim())));

export async function askHidden(question) {
  const i = iface();
  process.stdout.write(question);
  muted = true;
  const answer = await new Promise((resolve) => i.question('', resolve));
  muted = false;
  return answer;
}

export function closePrompt() {
  if (rl) rl.close();
  rl = null;
}

/**
 * The demo database's connection string: from DEMO_DATABASE_URL if set,
 * otherwise asked for with hidden input — so it never lands in shell history.
 * Requires DEMO_MODE=true (demo-guard.mjs), and deliberately ignores
 * DATABASE_URL so a connection string meant for another system is never used.
 */
export async function databaseUrl() {
  try {
    requireDemoMode();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let url = process.env.DEMO_DATABASE_URL;
  if (!url) url = (await askHidden('Demo database connection string (DEMO_DATABASE_URL, input hidden): ')).trim();
  if (!/^postgres(ql)?:\/\/\S+$/.test(url)) {
    console.error('That is not a PostgreSQL connection string (postgresql://...).');
    process.exit(1);
  }
  return url;
}
