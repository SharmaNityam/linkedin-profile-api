import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../src/config.js';
import { DEFAULT_POSTS_QUERY_ID } from '../../src/linkedin/voyager/endpoints.js';

const SESSION_KEY = 'a'.repeat(64);
const base = { LI_AT: 'x', SESSION_KEY };

describe('loadConfig', () => {
  it('requires LI_AT and strips surrounding quotes', () => {
    expect(() => loadConfig({})).toThrow(/LI_AT/);
    expect(loadConfig({ LI_AT: '"cookie"', SESSION_KEY }).LI_AT).toBe('cookie');
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

  it('defaults the rate limit, cache and concurrency knobs', () => {
    const config = loadConfig(base);
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.CACHE_TTL_SECONDS).toBe(900);
    expect(config.MAX_CONCURRENT_UPSTREAM).toBe(2);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('coerces RATE_LIMIT_PER_MINUTE and rejects nonsense', () => {
    expect(loadConfig({ ...base, RATE_LIMIT_PER_MINUTE: '50' }).RATE_LIMIT_PER_MINUTE).toBe(50);
    expect(() => loadConfig({ ...base, RATE_LIMIT_PER_MINUTE: '0' })).toThrow(
      /RATE_LIMIT_PER_MINUTE/,
    );
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
  });

  it('requires a well-formed SESSION_KEY', () => {
    expect(() => loadConfig({ LI_AT: 'x' })).toThrow(/SESSION_KEY/);
    expect(() => loadConfig({ LI_AT: 'x', SESSION_KEY: 'not-hex' })).toThrow(/SESSION_KEY/);
  });

  it('defaults the SMTP host/port, APP_ORIGIN and OTP limits', () => {
    const config = loadConfig(base);
    expect(config.SMTP_HOST).toBe('smtp.gmail.com');
    expect(config.SMTP_PORT).toBe(465);
    expect(config.APP_ORIGIN).toBe('http://localhost:3000');
    expect(config.OTP_RATE_LIMIT_PER_HOUR).toBe(10);
    expect(config.OTP_PER_EMAIL_PER_HOUR).toBe(5);
  });

  it('defaults EMAIL_FROM to SMTP_USER', () => {
    expect(loadConfig({ ...base, SMTP_USER: 'a@b.com' }).EMAIL_FROM).toBe('a@b.com');
    expect(
      loadConfig({ ...base, SMTP_USER: 'a@b.com', EMAIL_FROM: 'other@b.com' }).EMAIL_FROM,
    ).toBe('other@b.com');
    expect(loadConfig(base).EMAIL_FROM).toBeUndefined();
  });

  it('rejects a NODE_ENV that only differs by case', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'Production' })).toThrow(/NODE_ENV/);
  });

  it('requires BREVO_API_KEY or SMTP_USER/SMTP_PASS in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/BREVO_API_KEY/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SMTP_USER: 'a@b.com' })).toThrow(
      /BREVO_API_KEY/,
    );
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        SMTP_USER: 'a@b.com',
        SMTP_PASS: 'secret',
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        BREVO_API_KEY: 'brevo-key',
        EMAIL_FROM: 'a@b.com',
      }),
    ).not.toThrow();
  });

  it('requires EMAIL_FROM when BREVO_API_KEY is set without SMTP_USER', () => {
    expect(() => loadConfig({ ...base, BREVO_API_KEY: 'brevo-key' })).toThrow(/EMAIL_FROM/);
    expect(
      loadConfig({ ...base, BREVO_API_KEY: 'brevo-key', EMAIL_FROM: 'a@b.com' }).EMAIL_FROM,
    ).toBe('a@b.com');
    expect(
      loadConfig({ ...base, BREVO_API_KEY: 'brevo-key', SMTP_USER: 'a@b.com' }).EMAIL_FROM,
    ).toBe('a@b.com');
  });

  it('defaults ALLOWED_EMAIL_DOMAINS', () => {
    const config = loadConfig(base);
    expect(config.ALLOWED_EMAIL_DOMAINS).toEqual([
      'gmail.com',
      'yahoo.com',
      'outlook.com',
      'myyahoo.com',
    ]);
  });

  it('parses ALLOWED_EMAIL_DOMAINS as a trimmed, lowercased list', () => {
    const config = loadConfig({ ...base, ALLOWED_EMAIL_DOMAINS: ' Proton.me, Example.com ,,' });
    expect(config.ALLOWED_EMAIL_DOMAINS).toEqual(['proton.me', 'example.com']);
  });

  it('requires ADMIN_EMAIL and ADMIN_PASSWORD together', () => {
    expect(() => loadConfig({ ...base, ADMIN_EMAIL: 'admin@example.com' })).toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: 'a-long-enough-password' })).toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(() =>
      loadConfig({
        ...base,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'a-long-enough-password',
      }),
    ).not.toThrow();
    expect(loadConfig(base).ADMIN_EMAIL).toBeUndefined();
  });

  it('rejects an ADMIN_PASSWORD under 12 characters', () => {
    expect(() =>
      loadConfig({ ...base, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'short' }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it('rejects a malformed ADMIN_EMAIL', () => {
    expect(() =>
      loadConfig({ ...base, ADMIN_EMAIL: 'not-an-email', ADMIN_PASSWORD: 'a-long-enough-password' }),
    ).toThrow(/ADMIN_EMAIL/);
  });
});

describe('redactConfig', () => {
  it('redacts the session cookie', () => {
    const redacted = redactConfig(loadConfig({ LI_AT: 'secret', SESSION_KEY }));
    expect(redacted.LI_AT).toBe('(6 chars, redacted)');
  });

  it('redacts SESSION_KEY and SMTP_PASS', () => {
    const config = loadConfig({ ...base, SMTP_USER: 'a@b.com', SMTP_PASS: 'super-secret' });
    const redacted = redactConfig(config);
    expect(redacted.SESSION_KEY).toBe(`(${SESSION_KEY.length} chars, redacted)`);
    expect(redacted.SMTP_PASS).toBe('(12 chars, redacted)');
  });

  it('leaks no secret value', () => {
    const config = loadConfig({
      LI_AT: 'li-at-secret',
      LI_COOKIES: 'cookie-secret',
      SESSION_KEY,
      SMTP_USER: 'a@b.com',
      SMTP_PASS: 'smtp-pass-secret',
    });
    const serialised = JSON.stringify(redactConfig(config));

    for (const secret of ['li-at-secret', 'cookie-secret', SESSION_KEY, 'smtp-pass-secret']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('leaves an absent LI_COOKIES and SMTP_PASS undefined', () => {
    const redacted = redactConfig(loadConfig(base));
    expect(redacted.LI_COOKIES).toBeUndefined();
    expect(redacted.SMTP_PASS).toBeUndefined();
  });

  it('redacts BREVO_API_KEY and leaves it undefined when unset', () => {
    const withKey = redactConfig(
      loadConfig({ ...base, BREVO_API_KEY: 'brevo-secret-key', EMAIL_FROM: 'a@b.com' }),
    );
    expect(withKey.BREVO_API_KEY).toBe('(16 chars, redacted)');
    expect(JSON.stringify(withKey)).not.toContain('brevo-secret-key');

    expect(redactConfig(loadConfig(base)).BREVO_API_KEY).toBeUndefined();
  });

  it('redacts ADMIN_PASSWORD and leaves it undefined when unset', () => {
    const withPassword = redactConfig(
      loadConfig({
        ...base,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'a-long-enough-password',
      }),
    );
    expect(withPassword.ADMIN_PASSWORD).toBe('(22 chars, redacted)');
    expect(JSON.stringify(withPassword)).not.toContain('a-long-enough-password');

    expect(redactConfig(loadConfig(base)).ADMIN_PASSWORD).toBeUndefined();
  });
});
