import { describe, expect, it } from 'vitest';
import { OtpStore } from '../../../src/auth/otp.js';

describe('OtpStore', () => {
  it('issues a 6-digit code and verifies it once', () => {
    const store = new OtpStore(5);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', now);
    if (outcome.status !== 'issued') throw new Error('expected issued');
    expect(outcome.code).toMatch(/^\d{6}$/);

    expect(store.verify('a@b.com', outcome.code, now)).toBe('ok');
    // Consumed: verifying again reports no pending code.
    expect(store.verify('a@b.com', outcome.code, now)).toBe('none');
  });

  it('reports mismatch for the wrong code', () => {
    const store = new OtpStore(5);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', now);
    if (outcome.status !== 'issued') throw new Error('expected issued');
    const wrong = outcome.code === '000000' ? '111111' : '000000';
    expect(store.verify('a@b.com', wrong, now)).toBe('mismatch');
  });

  it('reports none for an email with no pending code', () => {
    const store = new OtpStore(5);
    expect(store.verify('nobody@b.com', '123456')).toBe('none');
  });

  it('expires a code after 10 minutes', () => {
    const store = new OtpStore(5);
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', issuedAt);
    if (outcome.status !== 'issued') throw new Error('expected issued');

    const justBefore = new Date(issuedAt.getTime() + 10 * 60 * 1000 - 1);
    expect(store.verify('a@b.com', outcome.code, justBefore)).toBe('ok');
  });

  it('reports expired once the 10-minute window has passed', () => {
    const store = new OtpStore(5);
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', issuedAt);
    if (outcome.status !== 'issued') throw new Error('expected issued');

    const afterExpiry = new Date(issuedAt.getTime() + 10 * 60 * 1000);
    expect(store.verify('a@b.com', outcome.code, afterExpiry)).toBe('expired');
  });

  it('exhausts after 5 wrong attempts, even with a fresh unexpired code', () => {
    const store = new OtpStore(5);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', now);
    if (outcome.status !== 'issued') throw new Error('expected issued');
    const wrong = outcome.code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      expect(store.verify('a@b.com', wrong, now)).toBe('mismatch');
    }
    expect(store.verify('a@b.com', outcome.code, now)).toBe('exhausted');
  });

  it('caps issuance at N per email per hour', () => {
    const store = new OtpStore(3);
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(store.issue('a@b.com', now).status).toBe('issued');
    expect(store.issue('a@b.com', now).status).toBe('issued');
    expect(store.issue('a@b.com', now).status).toBe('issued');
    expect(store.issue('a@b.com', now).status).toBe('rate_limited');

    // A different email is unaffected.
    expect(store.issue('c@d.com', now).status).toBe('issued');
  });

  it('resets the per-email cap after an hour', () => {
    const store = new OtpStore(1);
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(store.issue('a@b.com', now).status).toBe('issued');
    expect(store.issue('a@b.com', now).status).toBe('rate_limited');

    const anHourLater = new Date(now.getTime() + 60 * 60 * 1000);
    expect(store.issue('a@b.com', anHourLater).status).toBe('issued');
  });

  it('compares codes in constant time (equal-length mismatch still reports mismatch)', () => {
    const store = new OtpStore(5);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const outcome = store.issue('a@b.com', now);
    if (outcome.status !== 'issued') throw new Error('expected issued');
    // Same length as every code (6 digits), definitely wrong.
    const wrong = String((Number(outcome.code) + 1) % 1_000_000).padStart(6, '0');
    expect(store.verify('a@b.com', wrong, now)).toBe('mismatch');
  });

  it('sweeps a fully stale entry so a later issuance is unaffected', () => {
    const store = new OtpStore(1);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = store.issue('a@b.com', now);
    if (first.status !== 'issued') throw new Error('expected issued');
    // Let the code and the issuance window both lapse.
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    expect(store.verify('a@b.com', first.code, later)).toBe('expired');

    // Sweep runs on the next issue(); the stale entry is gone, cap resets.
    const evenLater = new Date(later.getTime() + 1);
    expect(store.issue('a@b.com', evenLater).status).toBe('issued');
  });

  it('keeps counting toward the per-email cap after a successful verify', () => {
    const store = new OtpStore(2);
    const now = new Date('2026-01-01T00:00:00.000Z');

    const first = store.issue('a@b.com', now);
    if (first.status !== 'issued') throw new Error('expected issued');
    expect(store.verify('a@b.com', first.code, now)).toBe('ok');

    const second = store.issue('a@b.com', now);
    if (second.status !== 'issued') throw new Error('expected issued');
    expect(store.verify('a@b.com', second.code, now)).toBe('ok');

    // A successful verify must not have reset the hourly issuance count.
    expect(store.issue('a@b.com', now).status).toBe('rate_limited');
  });

  it('sweeps expired entries on verify, not just on issue', () => {
    const store = new OtpStore(1000);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = store.issue('a@b.com', now);
    if (first.status !== 'issued') throw new Error('expected issued');

    const afterExpiry = new Date(now.getTime() + 10 * 60 * 1000 + 1);
    // Touching a wholly unrelated email still runs the sweep, which should
    // drop a@b.com's expired entry (proven by it not counting toward the cap).
    expect(store.verify('nobody@b.com', '000000', afterExpiry)).toBe('none');
    expect(store.pendingCount()).toBe(0);
  });

  it('evicts the oldest-expiring entry once the store hits 10,000 pending', () => {
    const store = new OtpStore(1000);
    const now = new Date('2026-01-01T00:00:00.000Z');

    // The first entry expires soonest; give every later one a later expiry.
    const oldest = store.issue('oldest@b.com', now);
    if (oldest.status !== 'issued') throw new Error('expected issued');

    for (let i = 1; i < 10_000; i += 1) {
      const later = new Date(now.getTime() + i);
      const outcome = store.issue(`user${i}@b.com`, later);
      if (outcome.status !== 'issued') throw new Error('expected issued');
    }
    expect(store.pendingCount()).toBe(10_000);

    // One more push should evict the oldest-expiring entry rather than grow.
    const overflow = store.issue('newest@b.com', new Date(now.getTime() + 10_000));
    if (overflow.status !== 'issued') throw new Error('expected issued');
    expect(store.pendingCount()).toBe(10_000);
    expect(store.verify('oldest@b.com', oldest.code, now)).toBe('none');
  });
});
