import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

/** Repo root `migrations/`, whether we run from `src/db` or `dist/db`. */
const DEFAULT_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/**
 * An arbitrary but fixed key. Two instances booting at once (a rolling deploy)
 * would otherwise both try to apply the same file; the loser waits here and
 * then finds nothing left to do.
 */
const LOCK_KEY = 8_675_309;

/**
 * How long to wait for the advisory lock before giving up. `pg_advisory_lock`
 * blocks forever by default, so a session that took the lock and then wedged —
 * a half-dead instance, a migration someone is running by hand — would hang
 * every booting container silently and indefinitely. Thirty seconds is longer
 * than any migration here takes and short enough to fail a deploy visibly.
 */
const LOCK_TIMEOUT = '30s';

const CREATE_LEDGER = `
  create table if not exists schema_migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )
`;

export interface MigrateOptions {
  /** Where the `*.sql` files live. Only tests ever pass this. */
  dir?: string;
  /** Progress for a human watching a deploy; silent by default. */
  log?: (message: string) => void;
}

/**
 * Applies every `migrations/*.sql` not yet recorded in `schema_migrations`, in
 * filename order, each in its own transaction. Returns the names applied — an
 * empty array when the database is already up to date.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<string[]> {
  const dir = options.dir ?? DEFAULT_DIR;
  const log = options.log ?? ((): void => {});
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    // Session-scoped, and set before the lock is requested so the wait itself
    // is what it bounds.
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    log(`Waiting for the migration lock (up to ${LOCK_TIMEOUT})…`);
    try {
      await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    } catch (err) {
      throw new Error(
        `Could not acquire the migration lock within ${LOCK_TIMEOUT}. Another instance is ` +
          'probably still migrating, or a session is holding it and has stopped making ' +
          'progress. Retry once it finishes; if nothing is running, look for an idle ' +
          `session holding advisory lock ${LOCK_KEY}.`,
        { cause: err },
      );
    }
    log('Migration lock acquired.');
    await client.query(CREATE_LEDGER);
    const { rows } = await client.query<{ name: string }>('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await readFile(join(dir, name), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        // A rollback that itself fails (the connection died mid-migration)
        // must not replace the error that explains what actually went wrong.
        try {
          await client.query('rollback');
        } catch (rollbackErr) {
          log(`Rollback after ${name} failed: ${String(rollbackErr)}`);
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${name} failed: ${reason}`, { cause: err });
      }
      applied.push(name);
    }
  } finally {
    // A failed unlock means the connection is unusable; drop it rather than
    // return a session still holding the lock to the pool.
    try {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
      client.release();
    } catch {
      client.release(true);
    }
  }

  return applied;
}

/** `pnpm migrate` / `pnpm migrate:dev`. */
async function main(): Promise<void> {
  await import('dotenv/config');
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const pool = createPool(config.DATABASE_URL);
  try {
    const applied = await migrate(pool, { log: (message) => console.log(message) });
    console.log(
      applied.length > 0
        ? `Applied ${applied.length} migration(s): ${applied.join(', ')}`
        : 'No migrations to apply; the database is up to date.',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
