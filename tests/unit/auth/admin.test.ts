import { scryptSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveAdminCredential, verifyAdminCredential } from '../../../src/auth/admin.js';

/** A fast stand-in for the real (deliberately slow) scrypt call. */
const fastScrypt = (password: string, salt: Buffer) => scryptSync(password, salt, 64, { N: 16 });

describe('deriveAdminCredential', () => {
  it('canonicalizes the email', () => {
    const credential = deriveAdminCredential('  Admin@Example.COM  ', 'password', fastScrypt);
    expect(credential.email).toBe('admin@example.com');
  });

  it('derives a different salt (and so a different hash) on each call', () => {
    const a = deriveAdminCredential('admin@example.com', 'password', fastScrypt);
    const b = deriveAdminCredential('admin@example.com', 'password', fastScrypt);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
  });
});

describe('verifyAdminCredential', () => {
  it('accepts the right email and password, case-insensitively on email', () => {
    const credential = deriveAdminCredential('Admin@Example.com', 'password', fastScrypt);
    expect(verifyAdminCredential(credential, 'admin@example.com', 'password', fastScrypt)).toBe(
      true,
    );
  });

  it('rejects a wrong password', () => {
    const credential = deriveAdminCredential('admin@example.com', 'password', fastScrypt);
    expect(verifyAdminCredential(credential, 'admin@example.com', 'wrong', fastScrypt)).toBe(false);
  });

  it('rejects an unknown email', () => {
    const credential = deriveAdminCredential('admin@example.com', 'password', fastScrypt);
    expect(
      verifyAdminCredential(credential, 'someone-else@example.com', 'password', fastScrypt),
    ).toBe(false);
  });

  it('rejects everything when no credential is configured', () => {
    expect(verifyAdminCredential(undefined, 'admin@example.com', 'anything', fastScrypt)).toBe(
      false,
    );
  });

  it('invokes the hasher even on the wrong-email path, so timing does not leak the mismatch', () => {
    const credential = deriveAdminCredential('admin@example.com', 'password', fastScrypt);
    const scrypt = vi.fn(fastScrypt);
    verifyAdminCredential(credential, 'someone-else@example.com', 'password', scrypt);
    expect(scrypt).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the hasher when no credential is configured', () => {
    const scrypt = vi.fn(fastScrypt);
    verifyAdminCredential(undefined, 'admin@example.com', 'password', scrypt);
    expect(scrypt).not.toHaveBeenCalled();
  });
});
