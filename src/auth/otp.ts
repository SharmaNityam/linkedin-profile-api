import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_DIGITS = 6;
const CODE_RANGE = 10 ** CODE_DIGITS;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;
/** Hard ceiling on pending codes, independent of any one email's cap. */
const MAX_PENDING = 10_000;

interface Entry {
  codeHash: string;
  expiresAt: number;
  attempts: number;
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
  /** Pending codes only: code hash, expiry, attempts. `verify` deletes from here on success. */
  private readonly store = new Map<string, Entry>();
  /**
   * Every issuance timestamp still inside the trailing hour window, kept
   * apart from `store` so a successful `verify` — which clears the pending
   * code — can never reset the per-email hourly issuance cap.
   */
  private readonly issueTimestamps = new Map<string, number[]>();

  constructor(private readonly perEmailPerHour: number) {}

  /** Mints and stores a new code, replacing any still pending for that email. */
  issue(email: string, now: Date = new Date()): IssueOutcome {
    const nowMs = now.getTime();
    this.sweep(nowMs);

    const recent = (this.issueTimestamps.get(email) ?? []).filter((t) => nowMs - t < HOUR_MS);
    if (recent.length >= this.perEmailPerHour) {
      this.issueTimestamps.set(email, recent);
      return { status: 'rate_limited' };
    }

    this.issueTimestamps.set(email, [...recent, nowMs]);

    if (!this.store.has(email) && this.store.size >= MAX_PENDING) {
      this.evictOldest();
    }

    const code = generateCode();
    this.store.set(email, {
      codeHash: hashCode(code),
      expiresAt: nowMs + CODE_TTL_MS,
      attempts: 0,
    });
    return { status: 'issued', code };
  }

  /**
   * Expiry is checked before the attempt cap, so an expired code is dead
   * regardless of attempts left; the cap is checked before comparing, so
   * brute forcing learns nothing once the budget is spent. Consumed on
   * success so a code can't be replayed. Only the pending code/attempts are
   * cleared on success — the issuance timestamps are never touched here, so
   * the hourly cap survives a successful verify.
   */
  verify(email: string, code: string, now: Date = new Date()): VerifyResult {
    const nowMs = now.getTime();
    const entry = this.store.get(email);

    let result: VerifyResult;
    if (!entry) {
      result = 'none';
    } else if (nowMs >= entry.expiresAt) {
      result = 'expired';
    } else if (entry.attempts >= MAX_ATTEMPTS) {
      result = 'exhausted';
    } else {
      entry.attempts += 1;
      result = hashesMatch(hashCode(code), entry.codeHash) ? 'ok' : 'mismatch';
      if (result === 'ok') this.store.delete(email);
    }

    // Sweep runs after the result for this email is settled, so it never
    // changes what this call reports — it only cleans up everything else.
    this.sweep(nowMs);
    return result;
  }

  /** Number of pending (unconsumed, not-yet-swept) codes. For tests. */
  pendingCount(): number {
    return this.store.size;
  }

  /**
   * Drops pending entries once they're expired, and prunes/clears issuance
   * timestamps once they've aged out of the trailing hour window — so a
   * mailbox that stops trying eventually leaves no trace in either map.
   */
  private sweep(nowMs: number): void {
    for (const [email, entry] of this.store) {
      if (nowMs >= entry.expiresAt) {
        this.store.delete(email);
      }
    }
    for (const [email, timestamps] of this.issueTimestamps) {
      const recent = timestamps.filter((t) => nowMs - t < HOUR_MS);
      if (recent.length === 0) {
        this.issueTimestamps.delete(email);
      } else if (recent.length !== timestamps.length) {
        this.issueTimestamps.set(email, recent);
      }
    }
  }

  /** Evicts the pending entry with the earliest `expiresAt` to make room. */
  private evictOldest(): void {
    let oldestEmail: string | undefined;
    let oldestExpiresAt = Infinity;
    for (const [email, entry] of this.store) {
      if (entry.expiresAt < oldestExpiresAt) {
        oldestExpiresAt = entry.expiresAt;
        oldestEmail = email;
      }
    }
    if (oldestEmail !== undefined) this.store.delete(oldestEmail);
  }
}
