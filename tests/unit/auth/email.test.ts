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

  it.each([
    ['victim,evil@example.com', 'a comma smuggles in a second recipient'],
    ['a\r\nBcc:evil@example.com', 'CRLF smuggles in a header'],
    ['a b@x.com', 'an embedded space'],
    ['<script>@x.com', 'angle brackets'],
    [`${'a'.repeat(300)}@x.com`, 'a local part over 64 characters'],
  ])('rejects %s (%s) with INVALID_REQUEST', (input) => {
    expect(() => canonicalEmail(input)).toThrow(AppError);
    try {
      canonicalEmail(input);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_REQUEST');
    }
  });

  it('canonicalizes a mixed-case gmail address with dots and a plus tag', () => {
    expect(canonicalEmail('First.Last+tag@Gmail.com')).toBe('firstlast@gmail.com');
  });
});
