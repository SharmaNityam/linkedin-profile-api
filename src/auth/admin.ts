import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonicalEmail } from './email.js';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt cost parameter; 2**15 needs a maxmem above node's 32MB default. */
const SCRYPT_N = 2 ** 15;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface AdminCredential {
  /** Canonical, so comparison is case-insensitive. */
  email: string;
  salt: Buffer;
  hash: Buffer;
}

/** Injectable so tests can observe (or avoid the cost of) the real scrypt call. */
export type ScryptFn = (password: string, salt: Buffer) => Buffer;

export const defaultScrypt: ScryptFn = (password, salt) =>
  scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, maxmem: SCRYPT_MAXMEM });

/** Derives the credential once at boot; never re-hashes the password after this. */
export function deriveAdminCredential(
  email: string,
  password: string,
  scrypt: ScryptFn = defaultScrypt,
): AdminCredential {
  const salt = randomBytes(SALT_LENGTH);
  return { email: canonicalEmail(email), salt, hash: scrypt(password, salt) };
}

/**
 * Always derives a key from `password` when a credential is configured —
 * even on a wrong email — so a timing side channel can't tell an attacker
 * which check failed first.
 */
export function verifyAdminCredential(
  credential: AdminCredential | undefined,
  email: string,
  password: string,
  scrypt: ScryptFn = defaultScrypt,
): boolean {
  if (!credential) return false;
  const hash = scrypt(password, credential.salt);
  const emailMatches = email === credential.email;
  return emailMatches && timingSafeEqual(hash, credential.hash);
}
