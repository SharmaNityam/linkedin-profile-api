import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresRepositories } from '../../src/auth/postgres.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { repositorySuite } from '../helpers/repo-suite.js';

const DATABASE_URL = process.env.DATABASE_URL;

const TABLES = 'users, pending_signups, phone_validations';

/**
 * Runs the same behavioural contract as the memory repositories against a real
 * database. Skipped unless DATABASE_URL is set, so `pnpm test` stays offline.
 */
describe.skipIf(!DATABASE_URL)('postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.query(`truncate table ${TABLES} restart identity cascade`);
    await pool.end();
  });

  it('is idempotent: a second migrate applies nothing', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  repositorySuite(
    'postgres repositories',
    () => createPostgresRepositories(pool),
    async () => {
      await pool.query(`truncate table ${TABLES} restart identity cascade`);
    },
  );
});
