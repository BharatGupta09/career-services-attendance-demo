// Neon's HTTP driver: each query is one HTTPS request to Neon, with no
// persistent connection or pool — the right shape for a Worker. Queries are
// written as tagged templates, so every ${value} is sent as a bound parameter,
// never concatenated into SQL.
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './types';

export type Sql = NeonQueryFunction<false, false>;

// An empty value or a template placeholder (e.g. "your_database_url_here") is "not configured".
const PLACEHOLDER = /^(your[_-].*|.*[_-]here|changeme|change[_-]me|placeholder|xxx+|<.*>)$/i;

export function databaseConfigured(env: Env): boolean {
  const v = env.DATABASE_URL?.trim();
  return !!v && !PLACEHOLDER.test(v);
}

export function getSql(env: Env): Sql {
  if (!databaseConfigured(env)) throw new Error('DATABASE_URL is not configured');
  return neon(env.DATABASE_URL.trim());
}

/** Normalise a timestamptz value from the driver (Date or string) to ISO-8601 UTC. */
export function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}
