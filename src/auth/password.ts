import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export type HasherKind = 'argon2' | 'scrypt';

/** OWASP's 2024 minimum for argon2id: 19 MiB, two passes, no parallelism. */
const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 64;
/** N=2^17 needs ~128 MiB; node's 32 MiB default would throw without this. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SCRYPT_PARAMS = `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;

const ARGON2_PREFIX = '$argon2';
const SCRYPT_PREFIX = '$scrypt$';

export class Argon2Hasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2Hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return verifyAny(hash, password);
  }
}

/**
 * A pure-node fallback for environments where the argon2 native binding is a
 * problem. The stored string carries its own parameters so raising them later
 * does not invalidate existing hashes.
 */
export class ScryptHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const key = await scryptKey(password, salt);
    return `${SCRYPT_PREFIX}${SCRYPT_PARAMS}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return verifyAny(hash, password);
  }
}

/**
 * Picks the hasher new passwords are written with. Both kinds verify either
 * format, so flipping the choice re-hashes nothing and logs no one out.
 */
export function createHasher(kind: HasherKind): PasswordHasher {
  return kind === 'argon2' ? new Argon2Hasher() : new ScryptHasher();
}

async function verifyAny(hash: string, password: string): Promise<boolean> {
  if (hash.startsWith(SCRYPT_PREFIX)) return verifyScrypt(hash, password);
  if (hash.startsWith(ARGON2_PREFIX)) {
    try {
      return await argon2Verify(hash, password);
    } catch {
      return false;
    }
  }
  return false;
}

async function verifyScrypt(hash: string, password: string): Promise<boolean> {
  const [, , params, saltB64, keyB64] = hash.split('$');
  if (params !== SCRYPT_PARAMS || !saltB64 || !keyB64) return false;

  const expected = Buffer.from(keyB64, 'base64');
  if (expected.length !== SCRYPT_KEY_BYTES) return false;

  const actual = await scryptKey(password, Buffer.from(saltB64, 'base64'));
  return timingSafeEqual(actual, expected);
}

/** `promisify` resolves to the option-less overload, so wrap it by hand. */
function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}
