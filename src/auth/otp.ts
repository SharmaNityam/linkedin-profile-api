import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_DIGITS = 6;
const CODE_RANGE = 10 ** CODE_DIGITS;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;

interface Entry {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  /** Epoch ms of every issuance still inside the trailing hour window. */
  issuedAt: number[];
}

export type IssueOutcome = { status: 'issued'; code: string } | { status: 'rate_limited' };
export type VerifyResult = 'ok' | 'expired' | 'exhausted' | 'mismatch' | 'none';

/**
 * A six-digit code, zero-padded. `crypto.randomInt` is uniform and
 * unpredictable, unlike `Math.random`.
 */
function generateCode(): string {
  return String(randomInt(CODE_RANGE)).padStart(CODE_DIGITS, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time over two hex digests; a length mismatch is already a no. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * In-memory codes, keyed by whatever the caller passes as `email` (routes
 * pass the canonicalised address). No persistence: a restart invalidates
 * every pending code, which just means the caller asks again.
 */
export class OtpStore {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly perEmailPerHour: number) {}

  /** Mints and stores a new code, replacing any still pending for that email. */
  issue(email: string, now: Date = new Date()): IssueOutcome {
    const nowMs = now.getTime();
    this.sweep(nowMs);

    const recent = (this.store.get(email)?.issuedAt ?? []).filter((t) => nowMs - t < HOUR_MS);
    if (recent.length >= this.perEmailPerHour) {
      return { status: 'rate_limited' };
    }

    const code = generateCode();
    this.store.set(email, {
      codeHash: hashCode(code),
      expiresAt: nowMs + CODE_TTL_MS,
      attempts: 0,
      issuedAt: [...recent, nowMs],
    });
    return { status: 'issued', code };
  }

  /**
   * Expiry is checked before the attempt cap, so an expired code is dead
   * regardless of attempts left; the cap is checked before comparing, so
   * brute forcing learns nothing once the budget is spent. Consumed on
   * success so a code can't be replayed.
   */
  verify(email: string, code: string, now: Date = new Date()): VerifyResult {
    const entry = this.store.get(email);
    if (!entry) return 'none';
    if (now.getTime() >= entry.expiresAt) return 'expired';
    if (entry.attempts >= MAX_ATTEMPTS) return 'exhausted';

    entry.attempts += 1;
    if (!hashesMatch(hashCode(code), entry.codeHash)) return 'mismatch';

    this.store.delete(email);
    return 'ok';
  }

  /**
   * Drops entries that are both expired and outside the per-email issuance
   * window, so a mailbox that stops trying eventually leaves no trace.
   */
  private sweep(nowMs: number): void {
    for (const [email, entry] of this.store) {
      const recent = entry.issuedAt.filter((t) => nowMs - t < HOUR_MS);
      if (recent.length === 0 && nowMs >= entry.expiresAt) {
        this.store.delete(email);
      } else if (recent.length !== entry.issuedAt.length) {
        entry.issuedAt = recent;
      }
    }
  }
}
