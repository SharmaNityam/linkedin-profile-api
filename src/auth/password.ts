import type * as Argon2 from 'argon2';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export type HasherKind = 'argon2' | 'scrypt';

/** OWASP's 2024 minimum for argon2id: 19 MiB, two passes, no parallelism. */
const ARGON2_MEMORY_COST = 19456;
const ARGON2_TIME_COST = 2;
const ARGON2_PARALLELISM = 1;

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

/**
 * The argon2 package loads a native addon at module scope, which is exactly
 * what `ScryptHasher` exists to have no dependency on. Importing it lazily —
 * and only from the argon2 code paths below — means constructing or using a
 * `ScryptHasher` never touches argon2 at all, and an unavailable addon only
 * breaks argon2 operations. Cached so the import only happens once.
 */
let argon2Module: Promise<typeof Argon2> | undefined;
function loadArgon2(): Promise<typeof Argon2> {
  argon2Module ??= import('argon2');
  return argon2Module;
}

export class Argon2Hasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const argon2 = await loadArgon2();
    const options: Argon2.HashOptions = {
      type: argon2.argon2id,
      memoryCost: ARGON2_MEMORY_COST,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
    };
    return argon2.hash(password, options);
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
      const argon2 = await loadArgon2();
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Stored scrypt hashes carry their own N/r/p, so raising the module's
 * defaults later doesn't invalidate hashes minted under the old ones — but
 * that means verification must derive the key using whatever parameters the
 * hash actually names, not the current constants.
 */
async function verifyScrypt(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 5) return false;
  const [, , paramsField, saltB64, keyB64] = parts;

  const params = parseScryptParams(paramsField);
  if (!params || !saltB64 || !keyB64) return false;

  const expected = Buffer.from(keyB64, 'base64');
  if (expected.length !== SCRYPT_KEY_BYTES) return false;

  const actual = await scryptKey(password, Buffer.from(saltB64, 'base64'), params);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Parses and sanity-checks an `N=<int>,r=<int>,p=<int>` header, rejecting
 * anything node's `scrypt` would otherwise throw on (or that could be used
 * to force an oversized memory allocation). */
function parseScryptParams(paramsField: string | undefined): ScryptParams | undefined {
  const match = paramsField ? /^N=(\d+),r=(\d+),p=(\d+)$/.exec(paramsField) : null;
  if (!match) return undefined;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isInteger(N) || N <= 0 || (N & (N - 1)) !== 0) return undefined;
  if (!Number.isInteger(r) || r <= 0) return undefined;
  if (!Number.isInteger(p) || p <= 0) return undefined;
  if (N * r * 128 > SCRYPT_MAXMEM) return undefined;

  return { N, r, p };
}

const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

/** `promisify` resolves to the option-less overload, so wrap it by hand. */
function scryptKey(
  password: string,
  salt: Buffer,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { ...params, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}
