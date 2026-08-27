import { beforeAll, describe, expect, it } from 'vitest';
import { Argon2Hasher, createHasher, ScryptHasher } from '../../../src/auth/password.js';

const PASSWORD = 'correct horse battery staple';

// Each argon2 hash costs ~19 MiB and ~50 ms, so the suite reuses a small,
// fixed set of hashes rather than minting one per assertion.
let argon2Hash: string;
let argon2HashAgain: string;
let scryptHash: string;
let scryptHashAgain: string;

beforeAll(async () => {
  const argon = new Argon2Hasher();
  const scrypt = new ScryptHasher();
  [argon2Hash, argon2HashAgain, scryptHash, scryptHashAgain] = await Promise.all([
    argon.hash(PASSWORD),
    argon.hash(PASSWORD),
    scrypt.hash(PASSWORD),
    scrypt.hash(PASSWORD),
  ]);
}, 30_000);

describe('Argon2Hasher', () => {
  it('produces an argon2id PHC string with the configured memory cost', () => {
    expect(argon2Hash.startsWith('$argon2id$')).toBe(true);
    expect(argon2Hash).toContain('m=19456');
    expect(argon2Hash).toContain('t=2');
    expect(argon2Hash).toContain('p=1');
  });

  it('round-trips and rejects the wrong password', async () => {
    const hasher = new Argon2Hasher();
    expect(await hasher.verify(argon2Hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(argon2Hash, 'wrong password')).toBe(false);
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(argon2Hash).not.toBe(argon2HashAgain);
  });
});

describe('ScryptHasher', () => {
  it('produces the documented format (N=2^17 does not blow past maxmem)', () => {
    expect(scryptHash.startsWith('$scrypt$')).toBe(true);
    const parts = scryptHash.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[2]).toBe('N=131072,r=8,p=1');
    expect(Buffer.from(parts[3]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(64);
  });

  it('round-trips and rejects the wrong password', async () => {
    const hasher = new ScryptHasher();
    expect(await hasher.verify(scryptHash, PASSWORD)).toBe(true);
    expect(await hasher.verify(scryptHash, 'wrong password')).toBe(false);
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(scryptHash).not.toBe(scryptHashAgain);
  });

  it('rejects a malformed hash rather than throwing', async () => {
    const hasher = new ScryptHasher();
    expect(await hasher.verify('$scrypt$broken', PASSWORD)).toBe(false);
    expect(await hasher.verify('', PASSWORD)).toBe(false);
  });
});

describe('createHasher', () => {
  it('hashes with the requested algorithm', async () => {
    expect((await createHasher('argon2').hash(PASSWORD)).startsWith('$argon2id$')).toBe(true);
    expect((await createHasher('scrypt').hash(PASSWORD)).startsWith('$scrypt$')).toBe(true);
  });

  it('verifies either format whichever kind it was created with', async () => {
    const argon = createHasher('argon2');
    const scrypt = createHasher('scrypt');
    expect(await argon.verify(scryptHash, PASSWORD)).toBe(true);
    expect(await scrypt.verify(argon2Hash, PASSWORD)).toBe(true);
    expect(await argon.verify(scryptHash, 'wrong password')).toBe(false);
    expect(await scrypt.verify(argon2Hash, 'wrong password')).toBe(false);
  });

  it('returns false for a hash in no known format', async () => {
    expect(await createHasher('argon2').verify('plaintext', PASSWORD)).toBe(false);
  });
});
