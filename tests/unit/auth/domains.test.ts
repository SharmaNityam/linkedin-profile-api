import { describe, expect, it } from 'vitest';
import { domainNotAllowedMessage, domainOf, isDomainAllowed } from '../../../src/auth/domains.js';

const DEFAULT_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'myyahoo.com'];

describe('domainOf', () => {
  it('returns everything after the last @', () => {
    expect(domainOf('john@gmail.com')).toBe('gmail.com');
  });
});

describe('isDomainAllowed', () => {
  it.each(DEFAULT_DOMAINS)('allows %s', (domain) => {
    expect(isDomainAllowed(`john@${domain}`, DEFAULT_DOMAINS)).toBe(true);
  });

  it.each(['outlook.in', 'proton.me', 'mailinator.com'])('rejects %s', (domain) => {
    expect(isDomainAllowed(`john@${domain}`, DEFAULT_DOMAINS)).toBe(false);
  });

  it('respects a custom list', () => {
    expect(isDomainAllowed('john@proton.me', ['proton.me'])).toBe(true);
    expect(isDomainAllowed('john@gmail.com', ['proton.me'])).toBe(false);
  });
});

describe('domainNotAllowedMessage', () => {
  it('joins the default four with commas and a trailing "or"', () => {
    expect(domainNotAllowedMessage(DEFAULT_DOMAINS)).toBe(
      'Use a gmail.com, yahoo.com, outlook.com or myyahoo.com address',
    );
  });

  it('joins two domains with just "or"', () => {
    expect(domainNotAllowedMessage(['gmail.com', 'yahoo.com'])).toBe(
      'Use a gmail.com or yahoo.com address',
    );
  });

  it('names a single domain plainly', () => {
    expect(domainNotAllowedMessage(['gmail.com'])).toBe('Use a gmail.com address');
  });
});
