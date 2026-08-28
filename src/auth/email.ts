import { AppError } from '../errors.js';

/**
 * Google treats `googlemail.com` as `gmail.com`, ignores dots in the local
 * part and everything after a `+`. Every other provider is left alone beyond
 * trimming and lowercasing, so `john+tag@outlook.com` stays distinct.
 */
const GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The stable identity of an address: what the OTP store and the session key
 * on, so a mailbox cannot be issued or checked twice under different
 * spellings.
 */
export function canonicalEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) {
    throw new AppError('INVALID_REQUEST', 'Email address is not valid');
  }

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) {
    throw new AppError('INVALID_REQUEST', 'Email address is not valid');
  }

  if (GOOGLE_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.split('+')[0]!.replace(/\./g, '');
  }

  if (!local) throw new AppError('INVALID_REQUEST', 'Email address is not valid');
  return `${local}@${domain}`;
}
