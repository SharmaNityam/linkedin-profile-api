import { describe, expect, it } from 'vitest';
import { canonicalEmail } from '../../../src/auth/email.js';
import { AppError } from '../../../src/errors.js';

describe('canonicalEmail', () => {
  it('trims and lowercases', () => {
    expect(canonicalEmail('  John.Doe@Example.COM  ')).toBe('john.doe@example.com');
  });

  it('folds gmail dots and plus tags', () => {
    expect(canonicalEmail('j.o.h.n+promo@gmail.com')).toBe('john@gmail.com');
    expect(canonicalEmail('john+work@googlemail.com')).toBe('john@gmail.com');
  });

  it('does not fold dots or plus tags on other domains', () => {
    expect(canonicalEmail('john.doe+work@outlook.com')).toBe('john.doe+work@outlook.com');
  });

  it.each(['not-an-email', 'a@', '@b.com', 'a@b@c.com', 'a@localhost', ''])(
    'rejects %s with INVALID_REQUEST',
    (input) => {
      expect(() => canonicalEmail(input)).toThrow(AppError);
      try {
        canonicalEmail(input);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_REQUEST');
      }
    },
  );

  it('rejects a gmail address that is only dots before the plus', () => {
    expect(() => canonicalEmail('.+x@gmail.com')).toThrow(AppError);
  });
});
