import { describe, expect, it } from 'vitest';
import { codeIsValid, generateCode, hashCode } from '../../../src/auth/codes.js';

describe('generateCode', () => {
  it('always produces six digits', () => {
    for (let i = 0; i < 100; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('pads low values from an injected source', () => {
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 42)).toBe('000042');
    expect(generateCode(() => 999999)).toBe('999999');
  });
});

describe('hashCode', () => {
  it('is stable and 64 hex characters', () => {
    const a = hashCode('123456');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode('123456')).toBe(a);
    expect(hashCode('123457')).not.toBe(a);
  });
});

describe('codeIsValid', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const stored = (over: Partial<{ codeHash: string; expiresAt: Date; attempts: number }> = {}) => ({
    codeHash: hashCode('123456'),
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    attempts: 0,
    ...over,
  });

  it('accepts a matching code before expiry', () => {
    expect(codeIsValid({ stored: stored(), code: '123456', now, maxAttempts: 5 })).toBe('ok');
  });

  it('reports expired at expiresAt or later', () => {
    const expiresAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      codeIsValid({ stored: stored({ expiresAt }), code: '123456', now, maxAttempts: 5 }),
    ).toBe('expired');
    expect(
      codeIsValid({
        stored: stored({ expiresAt: new Date('2025-12-31T23:59:59.000Z') }),
        code: '123456',
        now,
        maxAttempts: 5,
      }),
    ).toBe('expired');
  });

  it('reports exhausted when attempts reach the cap, ahead of a mismatch', () => {
    expect(
      codeIsValid({ stored: stored({ attempts: 5 }), code: '000000', now, maxAttempts: 5 }),
    ).toBe('exhausted');
    expect(
      codeIsValid({ stored: stored({ attempts: 6 }), code: '123456', now, maxAttempts: 5 }),
    ).toBe('exhausted');
  });

  it('prefers expired over exhausted', () => {
    expect(
      codeIsValid({
        stored: stored({ attempts: 9, expiresAt: new Date('2025-12-31T00:00:00.000Z') }),
        code: '123456',
        now,
        maxAttempts: 5,
      }),
    ).toBe('expired');
  });

  it('reports a mismatch otherwise', () => {
    expect(codeIsValid({ stored: stored(), code: '654321', now, maxAttempts: 5 })).toBe('mismatch');
    expect(codeIsValid({ stored: stored(), code: '', now, maxAttempts: 5 })).toBe('mismatch');
  });
});
