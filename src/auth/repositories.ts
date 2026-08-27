/**
 * The storage contract for accounts. Everything above this layer talks to these
 * interfaces, so the in-memory implementation (tests, and dev without a
 * DATABASE_URL) and the Postgres one are interchangeable.
 */

export interface User {
  id: string;
  email: string;
  /** The de-duplicated form of `email`; unique, and what lookups match on. */
  emailCanonical: string;
  emailVerifiedAt: Date | null;
  passwordHash: string;
  phoneE164: string | null;
  phoneVerifiedAt: Date | null;
  /** Bumped to invalidate every session already issued to this user. */
  sessionVersion: number;
  createdAt: Date;
}

export interface EmailVerification {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
}

/** A cached verdict from the phone-validation provider, keyed by number. */
export interface PhoneValidation {
  phoneE164: string;
  provider: string;
  /** `null` when the provider could not reach a verdict. */
  valid: boolean | null;
  type: string | null;
  raw: unknown;
  checkedAt: Date;
}

export interface NewUser {
  email: string;
  emailCanonical: string;
  passwordHash: string;
}

export interface UserRepository {
  /**
   * Throws `AppError('INTERNAL_ERROR')` if the canonical email is already
   * taken: callers check for an existing account first and report the friendly
   * error themselves, so losing the race here is genuinely exceptional.
   */
  create(user: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByCanonicalEmail(emailCanonical: string): Promise<User | null>;
  findByPhone(phoneE164: string): Promise<User | null>;
  markEmailVerified(id: string, at: Date): Promise<void>;
  /** `'taken'` when another account already holds the number. */
  setPhone(id: string, phoneE164: string, at: Date): Promise<'ok' | 'taken'>;
  /** Returns the new session version. */
  bumpSessionVersion(id: string): Promise<number>;
}

export interface EmailVerificationRepository {
  /** One pending code per user; re-issuing replaces the previous one. */
  upsert(verification: EmailVerification): Promise<void>;
  find(userId: string): Promise<EmailVerification | null>;
  incrementAttempts(userId: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

export interface PhoneValidationRepository {
  find(phoneE164: string): Promise<PhoneValidation | null>;
  save(validation: PhoneValidation): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  verifications: EmailVerificationRepository;
  phoneValidations: PhoneValidationRepository;
}
