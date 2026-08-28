import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { AppError } from '../errors.js';

/**
 * The stable identity of a phone number: E.164, so a single line cannot
 * register twice under different spellings.
 *
 * There is no default country — the caller must supply the country code. A
 * bare `98765 43210` is Indian to one reader and nonsense to another, and
 * guessing would let two accounts claim the same line from different regions.
 * `/max` gives the full metadata set, so number-type validation is exact.
 */
export function normalizePhone(input: string): string {
  const parsed = parsePhoneNumberFromString(input.trim());
  if (!parsed?.isValid() || !parsed.number.startsWith('+')) {
    throw new AppError(
      'INVALID_PHONE',
      'Phone number is not valid. Include the country code, e.g. +919876543210.',
    );
  }
  return parsed.number;
}
