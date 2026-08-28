import { Pool, type PoolConfig } from 'pg';

/**
 * Reached over the loopback interface — including the name a container uses
 * for the host it runs on, which resolves to the same machine.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/** Whichever query parameters could contradict the explicit `ssl` option. */
const SSL_PARAMS = ['sslmode', 'ssl'];

/**
 * Neon (and every other hosted Postgres) only speaks TLS, and its certificate
 * chains to a public CA, so verification stays on. A local database is reached
 * over the loopback interface and usually has no certificate at all, so TLS is
 * skipped there rather than made optional-and-unverified everywhere.
 *
 * The decision is made here and only here: `sslmode`/`ssl` are stripped out of
 * the connection string first, because node-pg reads them too and a pasted
 * `?sslmode=no-verify` would otherwise silently downgrade a production
 * connection past this rule.
 */
export function resolvePoolConfig(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  for (const param of SSL_PARAMS) url.searchParams.delete(param);
  const local = LOCAL_HOSTNAMES.has(url.hostname);

  return {
    connectionString: url.toString(),
    // Neon's free tier allows few connections and the API is not write-heavy.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export function createPool(databaseUrl: string): Pool {
  return new Pool(resolvePoolConfig(databaseUrl));
}
