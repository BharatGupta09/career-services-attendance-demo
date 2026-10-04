#!/usr/bin/env node
// Public-safety scan: this is a public repository, so nothing in it may be a
// secret, a real person's data or a pointer to private infrastructure.
//
//   npm run check:public        (also runs in CI)
//
// Scans every tracked (and not-ignored untracked) file for: private keys,
// API tokens, JWTs, database connection strings with credentials, database
// hostnames, Cloudflare account/zone ids or routes, concrete workers.dev URLs,
// email addresses outside the reserved example domains, IPv4 addresses outside
// loopback and the documentation ranges, and file types that must not be
// published (.env files, keys, dumps, exports, logs, office documents).
// Findings are reported as file:line and kind; matched values are never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);

const findings = [];
const report = (file, line, kind) => findings.push(`${file}${line ? `:${line}` : ''}  ${kind}`);

// ---- files that must never be published -------------------------------------
const FORBIDDEN_FILES = [
  [/(^|\/)\.env(\.(?!example$)[^/]+)?$/, '.env file'],
  [/(^|\/)\.dev\.vars(\.(?!example$)[^/]+)?$/, '.dev.vars file'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'key or certificate file'],
  [/(^|\/)id_(rsa|ecdsa|ed25519)$/, 'SSH private key'],
  [/\.(sqlite3?|db|dump|bak|sql\.gz)$/i, 'database file or dump'],
  [/\.(csv|tsv|xlsx?)$/i, 'data export'],
  [/\.log$/i, 'log file'],
  [/\.(docx?|pdf|pptx?)$/i, 'office document (may carry real data or metadata)'],
  [/(^|\/)(credentials|secrets?)[^/]*\.(json|ya?ml|txt)$/i, 'credentials file'],
];
const IMAGE = /\.(png|jpe?g|gif|webp|ico)$/i;

// ---- content patterns ----------------------------------------------------------
const ALLOWED_EMAIL = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i;
const DOC_IP = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];
const PATTERNS = [
  [new RegExp('-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}'), 'private key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/, 'GitHub token'],
  [/\bnapi_[A-Za-z0-9]{20,}/, 'Neon API key'],
  [/\bnpg_[A-Za-z0-9]{8,}/, 'Neon database password'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'secret API key'],
  [/(?:api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{24,}['"]/i, 'hard-coded secret'],
  [/\bep-[a-z]+-[a-z]+-[a-z0-9]{6,}/, 'Neon endpoint hostname'],
  [/"(?:account_id|zone_id)"\s*:/, 'Cloudflare account/zone id'],
  [/"(?:routes?|custom_domain)"\s*:/, 'Cloudflare route or custom domain'],
];

function checkLine(file, n, line) {
  for (const [re, kind] of PATTERNS) if (re.test(line)) report(file, n, kind);

  for (const m of line.matchAll(/postgres(?:ql)?:\/\/([^\s:/@'"`]+):([^\s@'"`]+)@([^\s/'"`]+)/g)) {
    const placeholder = (m[1] === 'USER' && m[2] === 'PASSWORD') || m[0].includes('…');
    if (!placeholder) report(file, n, 'database connection string with credentials');
  }
  for (const m of line.matchAll(/https?:\/\/[a-z0-9-]+\.([a-z0-9-]+)\.workers\.dev/gi)) {
    if (m[1].toLowerCase() !== 'example') report(file, n, 'concrete workers.dev URL');
  }
  for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    if (!ALLOWED_EMAIL.test(m[0])) report(file, n, 'email address outside the example domains');
  }
  for (const m of line.matchAll(/(?<![\w./-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g)) {
    if (m.slice(1, 5).some((o) => Number(o) > 255)) continue;
    if (!DOC_IP.some((re) => re.test(m[0]))) report(file, n, 'IPv4 address outside loopback/documentation ranges');
  }
}

for (const file of files) {
  for (const [re, kind] of FORBIDDEN_FILES) if (re.test(file)) report(file, 0, kind);
  if (IMAGE.test(file)) {
    if (!file.startsWith('docs/screenshots/') && !file.startsWith('public/')) report(file, 0, 'image outside docs/screenshots or public');
    continue;
  }
  let text;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes('\u0000')) {
    report(file, 0, 'unexpected binary file');
    continue;
  }
  text.split('\n').forEach((line, i) => checkLine(file, i + 1, line));
}

// ---- deployment configuration ---------------------------------------------------
const wrangler = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
const name = /"name"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
if (!name || !name.endsWith('-demo')) report('wrangler.jsonc', 0, 'Worker name must be demo-specific (end with "-demo")');
for (const f of files.filter((f) => f.startsWith('.github/workflows/'))) {
  const wf = readFileSync(path.join(root, f), 'utf8');
  if (/wrangler\s+(deploy|publish)|wrangler-action|secrets\./.test(wf)) report(f, 0, 'workflow deploys or uses repository secrets');
}

if (findings.length) {
  console.error(`Public-safety check FAILED (${findings.length} finding(s)):\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`Public-safety check passed: ${files.length} files scanned.`);
