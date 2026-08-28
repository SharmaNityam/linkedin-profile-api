import { describe, expect, it } from 'vitest';
import { canonicalEmail, emailDomain } from '../../../src/auth/email.js';
import {
  DEFAULT_ALLOWED_EMAIL_DOMAINS,
  isAllowedDomain,
  parseAllowedDomains,
} from '../../../src/auth/email-domains.js';

describe('canonicalEmail', () => {
  it.each([
    ['John.Doe+promo@Gmail.com', 'johndoe@gmail.com'],
    ['j.o.h.n@googlemail.com', 'john@gmail.com'],
    ['John+tag@Outlook.com', 'john+tag@outlook.com'],
    ['  Jane@Yahoo.co.in ', 'jane@yahoo.co.in'],
  ])('%s → %s', (input, out) => expect(canonicalEmail(input)).toBe(out));

  it.each(['nope', '@gmail.com', 'a@', 'a@b@c'])('rejects %s', (bad) =>
    expect(() => canonicalEmail(bad)).toThrow(),
  );

  it('rejects a gmail address that canonicalises to an empty local part', () => {
    expect(() => canonicalEmail('+promo@gmail.com')).toThrow();
    expect(() => canonicalEmail('...@gmail.com')).toThrow();
  });

  it('extracts the domain', () => expect(emailDomain('X@GoogleMail.com')).toBe('gmail.com'));
});

describe('allowlist', () => {
  it('ships consumer domains by default', () => {
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.co.in', 'live.com'])
      expect(isAllowedDomain(d, DEFAULT_ALLOWED_EMAIL_DOMAINS)).toBe(true);
    expect(isAllowedDomain('brackets.agency', DEFAULT_ALLOWED_EMAIL_DOMAINS)).toBe(false);
  });

  it('compares case-insensitively and ignores surrounding space', () => {
    expect(isAllowedDomain(' Gmail.COM ', DEFAULT_ALLOWED_EMAIL_DOMAINS)).toBe(true);
    expect(isAllowedDomain('example.com', ['Example.com'])).toBe(true);
  });

  it('parses the env override', () => {
    expect(parseAllowedDomains(' Example.com, gmail.com ')).toEqual(['example.com', 'gmail.com']);
    expect(parseAllowedDomains(undefined)).toEqual([...DEFAULT_ALLOWED_EMAIL_DOMAINS]);
    expect(parseAllowedDomains('')).toEqual([...DEFAULT_ALLOWED_EMAIL_DOMAINS]);
    expect(parseAllowedDomains(' , , ')).toEqual([...DEFAULT_ALLOWED_EMAIL_DOMAINS]);
  });
});
