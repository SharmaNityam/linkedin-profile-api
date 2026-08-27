import { describe, expect, it } from 'vitest';
import {
  buildSessionCookies,
  parseCookieString,
  serializeCookies,
} from '../../src/linkedin/cookies.js';

describe('cookies', () => {
  it('parses a document.cookie string, tolerating quotes and stray separators', () => {
    const jar = parseCookieString('bcookie="v2:abc"; lidc=x; ;JSESSIONID="ajax:123" ; broken');
    expect([...jar]).toEqual([
      ['bcookie', '"v2:abc"'],
      ['lidc', 'x'],
      ['JSESSIONID', '"ajax:123"'],
    ]);
    expect(serializeCookies(jar)).toBe('bcookie="v2:abc"; lidc=x; JSESSIONID="ajax:123"');
  });

  it('uses the browser JSESSIONID as CSRF token when companions are supplied', () => {
    const s = buildSessionCookies('LIAT', 'bcookie=b; JSESSIONID="ajax:777"', () => 'ajax:minted');
    expect(s.csrfToken).toBe('ajax:777');
    expect(serializeCookies(s.jar)).toBe('bcookie=b; JSESSIONID="ajax:777"; li_at=LIAT');
  });

  it('mints a JSESSIONID when none is supplied', () => {
    const s = buildSessionCookies('LIAT', undefined, () => 'ajax:minted');
    expect(s.csrfToken).toBe('ajax:minted');
    expect(serializeCookies(s.jar)).toBe('li_at=LIAT; JSESSIONID="ajax:minted"');
  });

  it('never lets a companion li_at override the configured one', () => {
    const s = buildSessionCookies('REAL', 'li_at=STALE', () => 'ajax:minted');
    expect(s.jar.get('li_at')).toBe('REAL');
  });
});
