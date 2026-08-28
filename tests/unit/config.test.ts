import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../src/config.js';
import { DEFAULT_POSTS_QUERY_ID } from '../../src/linkedin/voyager/endpoints.js';

const base = { LI_AT: 'x' };

describe('loadConfig', () => {
  it('requires LI_AT and strips surrounding quotes', () => {
    expect(() => loadConfig({})).toThrow(/LI_AT/);
    expect(loadConfig({ LI_AT: '"cookie"' }).LI_AT).toBe('cookie');
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
});

describe('redactConfig', () => {
  it('redacts the session cookie', () => {
    const redacted = redactConfig(loadConfig({ LI_AT: 'secret' }));
    expect(redacted.LI_AT).toBe('(6 chars, redacted)');
  });

  it('leaks no secret value', () => {
    const config = loadConfig({ LI_AT: 'li-at-secret', LI_COOKIES: 'cookie-secret' });
    const serialised = JSON.stringify(redactConfig(config));

    for (const secret of ['li-at-secret', 'cookie-secret']) expect(serialised).not.toContain(secret);
  });

  it('leaves an absent LI_COOKIES undefined', () => {
    expect(redactConfig(loadConfig(base)).LI_COOKIES).toBeUndefined();
  });
});
