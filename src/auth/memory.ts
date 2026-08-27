import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type {
  EmailVerification,
  EmailVerificationRepository,
  NewUser,
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
      emailVerifiedAt: null,
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

  async markEmailVerified(id: string, at: Date): Promise<void> {
    this.mutable(id).emailVerifiedAt = at;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    this.mutable(id).passwordHash = passwordHash;
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

class MemoryEmailVerificationRepository implements EmailVerificationRepository {
  private readonly byUserId = new Map<string, EmailVerification>();

  async upsert(verification: EmailVerification): Promise<void> {
    this.byUserId.set(verification.userId, { ...verification });
  }

  async find(userId: string): Promise<EmailVerification | null> {
    const stored = this.byUserId.get(userId);
    return stored ? { ...stored } : null;
  }

  async incrementAttempts(userId: string): Promise<void> {
    const stored = this.byUserId.get(userId);
    if (stored) stored.attempts += 1;
  }

  async delete(userId: string): Promise<void> {
    this.byUserId.delete(userId);
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
    verifications: new MemoryEmailVerificationRepository(),
    phoneValidations: new MemoryPhoneValidationRepository(),
  };
}
