import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../../src/auth/phone.js';
import { AppError } from '../../../src/errors.js';

describe('normalizePhone', () => {
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['+44 7911 123456', '+447911123456'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each([
    ['98765 43210', 'no country code'],
    ['+1 555 0100', 'not a valid number'],
    ['hello', 'not a number at all'],
    ['', 'empty'],
  ])('rejects %s (%s)', (bad) => {
    expect(() => normalizePhone(bad)).toThrow(AppError);
    try {
      normalizePhone(bad);
    } catch (err) {
      expect((err as AppError).code).toBe('INVALID_PHONE');
    }
  });

  it('is idempotent on an already normalised number', () => {
    expect(normalizePhone(normalizePhone('+91 98765 43210'))).toBe('+919876543210');
  });
});
