import { Pool } from 'pg';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Neon (and every other hosted Postgres) only speaks TLS, and its certificate
 * chains to a public CA, so verification stays on. A local database is reached
 * over the loopback interface and usually has no certificate at all, so TLS is
 * skipped there rather than made optional-and-unverified everywhere.
 */
export function createPool(databaseUrl: string): Pool {
  const { hostname } = new URL(databaseUrl);
  const local = LOCAL_HOSTNAMES.has(hostname);

  return new Pool({
    connectionString: databaseUrl,
    // Neon's free tier allows few connections and the API is not write-heavy.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(local ? {} : { ssl: { rejectUnauthorized: true } }),
  });
}
