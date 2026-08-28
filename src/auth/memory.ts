import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type {
  NewPendingSignup,
  NewUser,
  PendingSignup,
  PendingSignupRepository,
  PhoneValidation,
  PhoneValidationRepository,
  Repositories,
  User,
  UserRepository,
} from './repositories.js';

/**
 * Postgres stores `raw` as jsonb, which copies the value and drops anything
 * JSON cannot carry. Doing the same here keeps the two implementations honest —
 * and stops a caller mutating a payload it already handed over.
 */
function jsonCopy(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function missingUser(id: string): AppError {
  return new AppError('INTERNAL_ERROR', `No user with id ${id}`);
}

class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  async create(user: NewUser): Promise<User> {
    for (const existing of this.byId.values()) {
      if (existing.emailCanonical === user.emailCanonical) {
        throw new AppError('INTERNAL_ERROR', 'An account with that email already exists');
      }
    }

    const record: User = {
      id: randomUUID(),
      email: user.email,
      emailCanonical: user.emailCanonical,
      emailVerifiedAt: user.emailVerifiedAt,
      passwordHash: user.passwordHash,
      phoneE164: null,
      phoneVerifiedAt: null,
      sessionVersion: 0,
      createdAt: new Date(),
    };
    this.byId.set(record.id, record);
    return { ...record };
  }

  async findById(id: string): Promise<User | null> {
    const user = this.byId.get(id);
    return user ? { ...user } : null;
  }

  async findByCanonicalEmail(emailCanonical: string): Promise<User | null> {
    return this.find((u) => u.emailCanonical === emailCanonical);
  }

  async findByPhone(phoneE164: string): Promise<User | null> {
    return this.find((u) => u.phoneE164 === phoneE164);
  }

  async setPhone(id: string, phoneE164: string, at: Date): Promise<'ok' | 'taken'> {
    const user = this.mutable(id);
    for (const other of this.byId.values()) {
      if (other.id !== id && other.phoneE164 === phoneE164) return 'taken';
    }
    user.phoneE164 = phoneE164;
    user.phoneVerifiedAt = at;
    return 'ok';
  }

  async bumpSessionVersion(id: string): Promise<number> {
    const user = this.mutable(id);
    user.sessionVersion += 1;
    return user.sessionVersion;
  }

  private find(predicate: (user: User) => boolean): User | null {
    for (const user of this.byId.values()) if (predicate(user)) return { ...user };
    return null;
  }

  private mutable(id: string): User {
    const user = this.byId.get(id);
    if (!user) throw missingUser(id);
    return user;
  }
}

class MemoryPendingSignupRepository implements PendingSignupRepository {
  /** Insertion order, which is also creation order; read back reversed. */
  private readonly rows: PendingSignup[] = [];

  async create(pending: NewPendingSignup): Promise<PendingSignup> {
    const record: PendingSignup = {
      id: randomUUID(),
      email: pending.email,
      emailCanonical: pending.emailCanonical,
      passwordHash: pending.passwordHash,
      codeHash: pending.codeHash,
      expiresAt: pending.expiresAt,
      attempts: 0,
      createdAt: new Date(),
    };
    this.rows.push(record);
    return { ...record };
  }

  async listByCanonicalEmail(emailCanonical: string): Promise<PendingSignup[]> {
    const matching = this.rows.filter((row) => row.emailCanonical === emailCanonical);
    // Newest first: the code someone just received is the one most likely to
    // be presented, and the caller stops at the first row that matches.
    return matching.reverse().map((row) => ({ ...row }));
  }

  async incrementAttempts(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.attempts += 1;
  }

  async deleteById(id: string): Promise<void> {
    this.remove((row) => row.id === id);
  }

  async deleteByCanonicalEmail(emailCanonical: string): Promise<void> {
    this.remove((row) => row.emailCanonical === emailCanonical);
  }

  async deleteExpired(now: Date): Promise<number> {
    return this.remove((row) => row.expiresAt.getTime() <= now.getTime());
  }

  private remove(predicate: (row: PendingSignup) => boolean): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (predicate(this.rows[i]!)) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemoryPhoneValidationRepository implements PhoneValidationRepository {
  private readonly byPhone = new Map<string, PhoneValidation>();

  async find(phoneE164: string): Promise<PhoneValidation | null> {
    const stored = this.byPhone.get(phoneE164);
    return stored ? { ...stored, raw: jsonCopy(stored.raw) } : null;
  }

  async save(validation: PhoneValidation): Promise<void> {
    this.byPhone.set(validation.phoneE164, { ...validation, raw: jsonCopy(validation.raw) });
  }
}

/**
 * Process-local storage: everything is lost on restart. Good enough for tests
 * and for running the API locally without a database, never for production
 * (`loadConfig` requires DATABASE_URL when NODE_ENV=production).
 */
export function createMemoryRepositories(): Repositories {
  return {
    users: new MemoryUserRepository(),
    pendingSignups: new MemoryPendingSignupRepository(),
    phoneValidations: new MemoryPhoneValidationRepository(),
  };
}
