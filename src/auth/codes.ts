import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_DIGITS = 6;
const CODE_RANGE = 10 ** CODE_DIGITS;

/**
 * A six-digit verification code, zero-padded so every code has the same shape.
 * `random` exists for tests; production uses `crypto.randomInt`, which is
 * uniform and unpredictable (`Math.random` is neither).
 */
export function generateCode(random: () => number = () => randomInt(CODE_RANGE)): string {
  return String(random() % CODE_RANGE).padStart(CODE_DIGITS, '0');
}

/**
 * What we store instead of the code itself. Six digits are trivially
 * brute-forced offline, so the protection is the short expiry, the attempt cap
 * and single use — not the cost of the digest; a slow KDF here would only add
 * latency to every verification.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export type CodeCheck = 'ok' | 'expired' | 'exhausted' | 'mismatch';

/**
 * Pure decision about a stored code. Expiry is checked first (an expired code
 * is dead regardless of attempts left), then the attempt cap, so brute forcing
 * cannot learn anything from the response once the budget is spent. Counting
 * attempts is the caller's job.
 */
export function codeIsValid(args: {
  stored: { codeHash: string; expiresAt: Date; attempts: number };
  code: string;
  now: Date;
  maxAttempts: number;
}): CodeCheck {
  const { stored, code, now, maxAttempts } = args;
  if (now.getTime() >= stored.expiresAt.getTime()) return 'expired';
  if (stored.attempts >= maxAttempts) return 'exhausted';
  return hashesMatch(hashCode(code), stored.codeHash) ? 'ok' : 'mismatch';
}

/** Constant-time over two hex digests; a length mismatch is already a no. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
