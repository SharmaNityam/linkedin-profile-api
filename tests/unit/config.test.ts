import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../src/config.js';
import { DEFAULT_POSTS_QUERY_ID } from '../../src/linkedin/voyager/endpoints.js';

describe('loadConfig', () => {
  it('requires LI_AT and strips surrounding quotes', () => {
    expect(() => loadConfig({})).toThrow(/LI_AT/);
    expect(loadConfig({ LI_AT: '"cookie"' }).LI_AT).toBe('cookie');
  });

  it('defaults the posts query id and accepts an override', () => {
    expect(loadConfig({ LI_AT: 'x' }).VOYAGER_POSTS_QUERY_ID).toBe(DEFAULT_POSTS_QUERY_ID);
    expect(
      loadConfig({ LI_AT: 'x', VOYAGER_POSTS_QUERY_ID: 'abcdefgh' }).VOYAGER_POSTS_QUERY_ID,
    ).toBe('abcdefgh');
  });

  it('rejects an implausibly short query id', () => {
    expect(() => loadConfig({ LI_AT: 'x', VOYAGER_POSTS_QUERY_ID: 'abc' })).toThrow(
      /VOYAGER_POSTS_QUERY_ID/,
    );
  });

  it('redacts the session cookie', () => {
    const redacted = redactConfig(loadConfig({ LI_AT: 'secret' }));
    expect(redacted.LI_AT).toBe('(6 chars, redacted)');
  });
});
