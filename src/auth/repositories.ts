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
  /**
   * When the mailbox was proved. Never null: a `users` row is only ever created
   * by a successful verification, so an account and a verified address are the
   * same thing.
   */
  emailVerifiedAt: Date;
  passwordHash: string;
  phoneE164: string | null;
  phoneVerifiedAt: Date | null;
  /** Bumped to invalidate every session already issued to this user. */
  sessionVersion: number;
  createdAt: Date;
}

/**
 * One signup submission that has not been verified yet. Deliberately keyed by
 * its own id rather than by address: several people may have a submission in
 * flight for the same mailbox, and each carries the password it was submitted
 * with, so the code that arrives in the mail is the only thing that decides
 * which password the account ends up with.
 */
export interface PendingSignup {
  id: string;
  /** The address as typed; what the code was mailed to. */
  email: string;
  emailCanonical: string;
  passwordHash: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
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
  /** Accounts are created verified; there is no unverified user state. */
  emailVerifiedAt: Date;
}

export interface NewPendingSignup {
  email: string;
  emailCanonical: string;
  passwordHash: string;
  codeHash: string;
  expiresAt: Date;
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
  /** `'taken'` when another account already holds the number. */
  setPhone(id: string, phoneE164: string, at: Date): Promise<'ok' | 'taken'>;
  /** Returns the new session version. */
  bumpSessionVersion(id: string): Promise<number>;
}

export interface PendingSignupRepository {
  create(pending: NewPendingSignup): Promise<PendingSignup>;
  /** Every submission in flight for the address, newest first. */
  listByCanonicalEmail(emailCanonical: string): Promise<PendingSignup[]>;
  /** Counted per row: a wrong guess only burns the submission it was aimed at. */
  incrementAttempts(id: string): Promise<void>;
  /** Used to evict the oldest submission once an address is over its cap. */
  deleteById(id: string): Promise<void>;
  /** Drops every submission for one address, after one of them verified. */
  deleteByCanonicalEmail(emailCanonical: string): Promise<void>;
  /** Housekeeping; returns how many rows were dropped. */
  deleteExpired(now: Date): Promise<number>;
}

export interface PhoneValidationRepository {
  find(phoneE164: string): Promise<PhoneValidation | null>;
  save(validation: PhoneValidation): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  pendingSignups: PendingSignupRepository;
  phoneValidations: PhoneValidationRepository;
}
