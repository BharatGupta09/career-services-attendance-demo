// Neon's HTTP driver: each query is one HTTPS request to Neon, with no
// persistent connection or pool — the right shape for a Worker. Queries are
// written as tagged templates, so every ${value} is sent as a bound parameter,
// never concatenated into SQL.
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './types';

export type Sql = NeonQueryFunction<false, false>;

export function getSql(env: Env): Sql {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(env.DATABASE_URL);
}

/** Normalise a timestamptz value from the driver (Date or string) to ISO-8601 UTC. */
export function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}
