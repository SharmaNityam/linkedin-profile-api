import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../src/config.js';
import { DEFAULT_POSTS_QUERY_ID } from '../../src/linkedin/voyager/endpoints.js';

const SESSION_KEY = 'a'.repeat(64);
const base = { LI_AT: 'x', SESSION_KEY };

describe('loadConfig', () => {
  it('requires LI_AT and strips surrounding quotes', () => {
    expect(() => loadConfig({ SESSION_KEY })).toThrow(/LI_AT/);
    expect(loadConfig({ ...base, LI_AT: '"cookie"' }).LI_AT).toBe('cookie');
  });

  it('defaults the posts query id and accepts an override', () => {
    expect(loadConfig(base).VOYAGER_POSTS_QUERY_ID).toBe(DEFAULT_POSTS_QUERY_ID);
    expect(loadConfig({ ...base, VOYAGER_POSTS_QUERY_ID: 'abcdefgh' }).VOYAGER_POSTS_QUERY_ID).toBe(
      'abcdefgh',
    );
  });

  it('rejects an implausibly short query id', () => {
    expect(() => loadConfig({ ...base, VOYAGER_POSTS_QUERY_ID: 'abc' })).toThrow(
      /VOYAGER_POSTS_QUERY_ID/,
    );
  });

  it('requires SESSION_KEY as 64 hex chars in every environment', () => {
    expect(() => loadConfig({ LI_AT: 'x' })).toThrow(/SESSION_KEY/);
    expect(() => loadConfig({ LI_AT: 'x', SESSION_KEY: 'zz' })).toThrow(/SESSION_KEY/);
    expect(() => loadConfig({ LI_AT: 'x', SESSION_KEY: 'a'.repeat(63) })).toThrow(/SESSION_KEY/);
    expect(loadConfig({ LI_AT: 'x', SESSION_KEY: 'A'.repeat(64) }).SESSION_KEY).toBe(
      'A'.repeat(64),
    );
  });

  it('defaults the auth knobs', () => {
    const config = loadConfig(base);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PHONE_VALIDATION_FAIL_MODE).toBe('open');
    expect(config.AUTH_RATE_LIMIT_PER_HOUR).toBe(20);
    expect(config.PASSWORD_HASHER).toBe('argon2');
    expect(config.APP_ORIGIN).toBe('http://localhost:3000');
    expect(config.EMAIL_FROM).toBe('LinkedIn Profile API <onboarding@resend.dev>');
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it('rejects unknown enum values', () => {
    expect(() => loadConfig({ ...base, PHONE_VALIDATION_FAIL_MODE: 'maybe' })).toThrow(
      /PHONE_VALIDATION_FAIL_MODE/,
    );
    expect(() => loadConfig({ ...base, PASSWORD_HASHER: 'bcrypt' })).toThrow(/PASSWORD_HASHER/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('coerces AUTH_RATE_LIMIT_PER_HOUR and rejects nonsense', () => {
    expect(loadConfig({ ...base, AUTH_RATE_LIMIT_PER_HOUR: '50' }).AUTH_RATE_LIMIT_PER_HOUR).toBe(
      50,
    );
    expect(() => loadConfig({ ...base, AUTH_RATE_LIMIT_PER_HOUR: '0' })).toThrow(
      /AUTH_RATE_LIMIT_PER_HOUR/,
    );
  });

  it('requires a database, a real origin and a mail key in production', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/db',
      APP_ORIGIN: 'https://api.example.com',
      RESEND_API_KEY: 're_key',
    };

    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...prod, APP_ORIGIN: 'http://localhost:3000' })).toThrow(
      /APP_ORIGIN/,
    );
    expect(() => loadConfig({ ...prod, APP_ORIGIN: 'http://127.0.0.1:3000' })).toThrow(
      /APP_ORIGIN/,
    );
    // Without it main.ts falls back to LogMailer, which writes every
    // verification code to the log.
    expect(() => loadConfig({ ...prod, RESEND_API_KEY: undefined })).toThrow(/RESEND_API_KEY/);
    expect(loadConfig(prod).APP_ORIGIN).toBe('https://api.example.com');
  });
});

describe('redactConfig', () => {
  it('redacts the session cookie', () => {
    const redacted = redactConfig(loadConfig({ ...base, LI_AT: 'secret' }));
    expect(redacted.LI_AT).toBe('(6 chars, redacted)');
  });

  it('leaks no secret value', () => {
    const config = loadConfig({
      LI_AT: 'li-at-secret',
      LI_COOKIES: 'cookie-secret',
      SESSION_KEY,
      RESEND_API_KEY: 're_secret_value',
      ABSTRACT_API_KEY: 'abstract_secret_value',
      DATABASE_URL: 'postgres://u:secret@h/db',
    });
    const redacted = redactConfig(config);
    const serialised = JSON.stringify(redacted);

    for (const secret of [
      'li-at-secret',
      'cookie-secret',
      SESSION_KEY,
      're_secret_value',
      'abstract_secret_value',
      'secret@h',
    ])
      expect(serialised).not.toContain(secret);

    expect(redacted.SESSION_KEY).toBe('(64 chars, redacted)');
    expect(redacted.RESEND_API_KEY).toBe('(15 chars, redacted)');
    expect(redacted.ABSTRACT_API_KEY).toBe('(21 chars, redacted)');
    expect(redacted.DATABASE_URL).toBe('postgres://u:***@h/db');
  });

  it('leaves absent optional secrets undefined', () => {
    const redacted = redactConfig(loadConfig(base));
    expect(redacted.RESEND_API_KEY).toBeUndefined();
    expect(redacted.ABSTRACT_API_KEY).toBeUndefined();
    expect(redacted.DATABASE_URL).toBeUndefined();
    expect(redacted.LI_COOKIES).toBeUndefined();
  });
});
