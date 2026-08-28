import { describe, expect, it, vi } from 'vitest';

// Simulates environments where the argon2 native addon fails to load: any
// import of `argon2` (static or dynamic) throws instead of resolving.
vi.mock('argon2', () => {
  throw new Error('native addon unavailable');
});

const { createHasher, ScryptHasher } = await import('../../../src/auth/password.js');

const PASSWORD = 'correct horse battery staple';

describe('ScryptHasher when argon2 is unavailable', () => {
  it('constructs and round-trips without touching argon2', async () => {
    const hasher = new ScryptHasher();
    const hash = await hasher.hash(PASSWORD);
    expect(hash.startsWith('$scrypt$')).toBe(true);
    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, 'wrong password')).toBe(false);
  });

  it('verifying an argon2-format hash returns false rather than throwing', async () => {
    const hasher = createHasher('scrypt');
    const argon2Looking = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$c29tZWhhc2g';
    await expect(hasher.verify(argon2Looking, PASSWORD)).resolves.toBe(false);
  });
});
