import { describe, expect, it } from 'vitest';
import { resolvePoolConfig } from '../../src/db/pool.js';

const NEON = 'postgres://user:pw@ep-cool-1.eu-central-1.aws.neon.tech/neondb';
const LOCAL = 'postgres://postgres:pg@localhost:55432/postgres';

describe('resolvePoolConfig', () => {
  it('verifies TLS for a remote host', () => {
    expect(resolvePoolConfig(NEON).ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each([
    'postgres://postgres:pg@localhost:55432/postgres',
    'postgres://postgres:pg@127.0.0.1:55432/postgres',
    'postgres://postgres:pg@[::1]:55432/postgres',
    // What a container reaches the host's database on.
    'postgres://postgres:pg@host.docker.internal:55432/postgres',
  ])('skips TLS for %s', (url) => {
    expect(resolvePoolConfig(url).ssl).toBe(false);
  });

  // The connection string is the one place an operator could quietly turn
  // verification off, so the resolved `ssl` option must not be reachable
  // from it: pg lets the string override what it cannot see.
  it.each(['sslmode=require', 'sslmode=no-verify', 'sslmode=disable', 'ssl=false', 'ssl=true'])(
    'strips %s from the connection string',
    (param) => {
      const { connectionString, ssl } = resolvePoolConfig(`${NEON}?${param}`);
      expect(connectionString).not.toContain('ssl');
      expect(ssl).toEqual({ rejectUnauthorized: true });
    },
  );

  it('cannot be talked out of verification on a remote host', () => {
    expect(resolvePoolConfig(`${LOCAL}?sslmode=require`).ssl).toBe(false);
    expect(resolvePoolConfig(`${NEON}?sslmode=disable`).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('keeps every other query parameter', () => {
    const { connectionString } = resolvePoolConfig(
      `${NEON}?application_name=lpa&sslmode=require&connect_timeout=5`,
    );
    expect(connectionString).toContain('application_name=lpa');
    expect(connectionString).toContain('connect_timeout=5');
  });

  it('bounds the pool', () => {
    const config = resolvePoolConfig(NEON);
    expect(config.max).toBe(5);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});
