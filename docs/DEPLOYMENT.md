# Deploying your own demo

You don't need any of this to try the app: `npm run demo` runs everything locally
with an in-memory database. This guide is for putting a demo instance online
using free plans only (**Neon Free** and **Cloudflare Workers Free**), in your
own accounts.

> Always create a **new** Neon project (or branch) for the demo. The scripts in this
> repository refuse to run unless `DEMO_MODE=true` is set, read only
> `DEMO_DATABASE_URL`, and refuse any database that contains an account outside
> the fictional demo directory. Even so, never point them at a database that
> holds real data.

The only secret is the demo database's connection string. It is stored as a
Cloudflare Worker secret named `DATABASE_URL`, never in Git and never in the frontend.

| What | Where it lives |
| --- | --- |
| Source code | your fork / clone of this repository |
| Demo data (users, sessions, attendance) | your Neon demo database |
| Running application | Cloudflare Worker `career-services-attendance-demo` |
| Connection string | Worker secret `DATABASE_URL`; `DEMO_DATABASE_URL` in your shell for the scripts |

---

## 1. Neon: create a demo database

1. Sign in at <https://console.neon.tech> (Free plan).
2. **New project**, named for example `attendance-demo`. Postgres 16 or 17.
3. **Connect**: copy the connection string
   (`postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require`). Treat it as a password.

The Free plan's compute scales to zero when idle, which this app is designed for.
At the time of writing, the Free plan doesn't ask for a payment method.

How this app talks to Neon (`@neondatabase/serverless`):

- **The Worker** sends each query as an HTTPS request to Neon (`neon()`), so it
  needs no TCP sockets, pool or Hyperdrive. Use the connection string the console
  shows by default (the pooled one, host containing `-pooler`).
- **The scripts** (`db:migrate`, `db:seed-demo`, `db:set-credentials`,
  `validate`) use the same driver's WebSocket client, because a migration file
  holds several statements. They work with Neon only. A plain local PostgreSQL
  has no Neon WebSocket proxy, so locally use `npm run demo` instead.
- `sslmode=require` and `channel_binding=require` can stay in the copied string.
  The driver always uses TLS to Neon.
- The default `neondb_owner` role has `BYPASSRLS`. The app doesn't use RLS
  (README → Database schema), so nothing depends on it.

## 2. Apply the migrations and load the demo data

From a terminal with Node.js 22+:

```bash
npm ci
export DEMO_MODE=true
npm run db:migrate      # asks for the connection string (input hidden)
npm run db:seed-demo    # asks again; loads the synthetic dataset in one transaction
```

Windows PowerShell:

```powershell
npm ci
$env:DEMO_MODE = "true"
npm run db:migrate
npm run db:seed-demo
```

You can also set `DEMO_DATABASE_URL` for the session instead of typing the
connection string at each prompt. Prompted input never lands in your shell history.

- `db:migrate` applies `migrations/001_…` to `007_…` in order, each in its own
  transaction, and records them in `schema_migrations`. Running it again is safe.
- `db:seed-demo` sets the demo password on the ten fictional accounts and loads four
  weeks of synthetic attendance, devices and audit entries relative to today. It
  refuses a database that already has attendance, device or audit rows. The audit
  log is append-only, so to re-seed, create a fresh Neon branch.
- **For a public deployment, choose your own password**: `DEMO_PASSWORD='…' npm run db:seed-demo`
  (8–72 characters). Everyone who knows the password can sign in as a demo admin.

## 3. Cloudflare: deploy the Worker

```bash
npx wrangler login                     # opens a browser; a Free account is fine
npx wrangler whoami                    # check that this is the intended account
npm run deploy                         # = wrangler deploy (Worker "career-services-attendance-demo")
npx wrangler secret put DATABASE_URL   # paste the demo database's connection string (input hidden)
```

These commands are the same in PowerShell. `wrangler deploy` **replaces** any
Worker of the same name in that account. If `career-services-attendance-demo`
already exists there for something else, change `name` in `wrangler.jsonc` first.
The first deploy to an account may ask you to pick a free `workers.dev` subdomain.

The app is then at `https://career-services-attendance-demo.<your-subdomain>.workers.dev`.
Check it with `/api/health`. It answers `{"status":"ready","database":"connected"}`,
or `503 not_configured` until the secret is set.

**Free-plan fit:** 100,000 Worker requests per day, counting `/api/*` only,
because static assets are served free and unlimited. Passwords are checked with
bcrypt inside PostgreSQL, so the Worker stays within the 10 ms CPU limit. There is
one database round trip per query and no bindings beyond static assets.

`wrangler.jsonc` contains only the Worker script, static assets and one plain
variable (`SESSION_HOURS`). There are no account IDs, routes, custom domains or
bindings that need a paid plan. Nothing in this repository deploys automatically:
the GitHub Actions workflow only type-checks, tests, builds (dry run) and scans.

## 4. Optional: validate the deployment

```bash
DEMO_MODE=true npm run validate -- https://career-services-attendance-demo.<your-subdomain>.workers.dev
```

```powershell
$env:DEMO_MODE = "true"; npm run validate -- https://career-services-attendance-demo.<your-subdomain>.workers.dev
```

Checks the demo database's schema, constraints and indexes and the ten demo users
(integrity tests run in a rolled-back transaction). It then checks the deployed
Worker: pages, security headers, API access control, and each admin's sign-in and
rotating code. Passwords are typed hidden and kept in memory only. Once migration
007 (device approval) is applied, which is the normal state, the script does not
sign students in, because its throwaway device would become their first approved
device. Its LOGIN/LOGOUT checks therefore run only on a database without 007. They
ask for confirmation and remove their test events afterwards.

## Local development against Neon (optional)

`npm run demo` needs no database. To run `wrangler dev` against your Neon demo
database instead, copy `.dev.vars.example` to `.dev.vars` (git-ignored), set
`DATABASE_URL`, then run `npm run dev` and open the `http://localhost:8787`
address Wrangler prints.

## Managing users

- **Passwords and emails**: `DEMO_MODE=true npm run db:set-credentials` lists the
  users and sets passwords interactively. Passwords are typed hidden and hashed
  inside PostgreSQL with bcrypt. Avoid the Neon SQL Editor for passwords, because
  it keeps a query history.
- **Add a user**:
  `INSERT INTO users (full_name, email, role) VALUES ('New Person', 'new.person@example.com', 'student');`
  then set a password with the script. (The scripts accept only `example.com`,
  `.invalid` and `.test` addresses in a demo database.)
- **Revoke access** for everyone, immediately and without a redeploy:
  `UPDATE users SET is_active = false WHERE is_active;`. Each request re-checks
  `is_active`, so open sessions end and admin codes stop working. Reactivate with
  `UPDATE users SET is_active = true WHERE NOT is_active;`.

## How schema changes roll out

The Worker checks which migrations exist (`src/verification.ts`) and works at the
level the database supports. A new Worker can therefore be deployed before its
migration is applied:

| Database | Behaviour |
| --- | --- |
| 001–004 | LOGIN/LOGOUT without a code; admins see a "database update" notice |
| + 005 | One attendance code per admin session; devices and audit trail |
| + 006 | Codes rotate every 30 minutes |
| + 007 | Students sign in only from approved devices |

Each migration from 005 onwards is additive (new tables, nullable columns,
constraints and indexes), so it is safe to apply while the app is in use. The test
suites cover each level (`MIGRATIONS_UPTO`).

To change the schema later, add `migrations/008_….sql` and run `npm run db:migrate`.
To rotate the database password, reset it in Neon, then update the Worker's
`DATABASE_URL` secret.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Refusing to run: this script only works against a demo database` | Set `DEMO_MODE=true` (PowerShell: `$env:DEMO_MODE = "true"`) for the command. |
| `Refusing to run: the target database contains N account(s) outside the demo directory` | Intended: the database is not a demo database. Create a new Neon project or branch. |
| `Refusing to seed: the database already has attendance, audit or device rows` | Seeding runs once per database (the audit log is append-only). Seed a fresh Neon branch. |
| `Expected the ten demo users … Run npm run db:migrate first` | Migrations haven't been applied to this database yet. |
| `This script needs Node.js 22 or newer` | The scripts need the global `WebSocket` of Node 22+. |
| Script hangs or fails connecting to `localhost` | The scripts need Neon (WebSocket proxy). Use `npm run demo` for a local database. |
| `/api/health` → `503 not_configured` | `npx wrangler secret put DATABASE_URL`. A placeholder value counts as unset. |
| `/api/health` → `503 unreachable` | Wrong connection string or password, or the compute is waking up. Retry, then check the string in Neon. |
| `429 Too many failed login attempts` | Wait 15 minutes. The lock applies to that email from your address. |
| `wrangler … You are not authenticated` | `npx wrangler login`. |
| Signed in, but the session immediately ends at `http://127.0.0.1` | Cookies are `Secure`; use `http://localhost:8787`. |
