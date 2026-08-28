import type { Pool } from 'pg';
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

/** Postgres' `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * The constraints declared in `migrations/0001_accounts.sql`, under the names
 * Postgres derives for a column-level `unique`.
 */
const EMAIL_CONSTRAINT = 'users_email_canonical_key';
const PHONE_CONSTRAINT = 'users_phone_e164_key';

/**
 * A `23505` alone says only that *some* unique index was tripped. Translating
 * it into "that email is taken" without checking which one turns a future
 * constraint — a second unique column, an index added by a later migration —
 * into a silently wrong answer, so the name has to match.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === UNIQUE_VIOLATION && e.constraint === constraint;
}

interface UserRow {
  id: string;
  email: string;
  email_canonical: string;
  email_verified_at: Date;
  password_hash: string;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  session_version: number;
  created_at: Date;
}

const USER_COLUMNS = `id, email, email_canonical, email_verified_at, password_hash,
                      phone_e164, phone_verified_at, session_version, created_at`;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    emailCanonical: row.email_canonical,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    phoneE164: row.phone_e164,
    phoneVerifiedAt: row.phone_verified_at,
    sessionVersion: row.session_version,
    createdAt: row.created_at,
  };
}

function missingUser(id: string): AppError {
  return new AppError('INTERNAL_ERROR', `No user with id ${id}`);
}

class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(user: NewUser): Promise<User> {
    try {
      const { rows } = await this.pool.query<UserRow>(
        `insert into users (email, email_canonical, password_hash, email_verified_at)
         values ($1, $2, $3, $4) returning ${USER_COLUMNS}`,
        [user.email, user.emailCanonical, user.passwordHash, user.emailVerifiedAt],
      );
      return toUser(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, EMAIL_CONSTRAINT)) {
        // Deliberately says nothing about *why*: this message reaches the
        // caller in a 500 body, and "that email is taken" is the one fact the
        // whole signup flow is built to withhold. The driver's own error is
        // attached as `cause`, so the log still says which constraint tripped.
        const conflict = new AppError('INTERNAL_ERROR', 'Could not create the account');
        conflict.cause = err;
        throw conflict;
      }
      throw err;
    }
  }

  async findById(id: string): Promise<User | null> {
    return this.findOne('id = $1', id);
  }

  async findByCanonicalEmail(emailCanonical: string): Promise<User | null> {
    return this.findOne('email_canonical = $1', emailCanonical);
  }

  async findByPhone(phoneE164: string): Promise<User | null> {
    return this.findOne('phone_e164 = $1', phoneE164);
  }

  async setPhone(id: string, phoneE164: string, at: Date): Promise<'ok' | 'taken'> {
    try {
      const { rowCount } = await this.pool.query(
        'update users set phone_e164 = $2, phone_verified_at = $3 where id = $1',
        [id, phoneE164, at],
      );
      if (rowCount === 0) throw missingUser(id);
      return 'ok';
    } catch (err) {
      if (isUniqueViolation(err, PHONE_CONSTRAINT)) return 'taken';
      throw err;
    }
  }

  async bumpSessionVersion(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ session_version: number }>(
      `update users set session_version = session_version + 1
       where id = $1 returning session_version`,
      [id],
    );
    const row = rows[0];
    if (!row) throw missingUser(id);
    return row.session_version;
  }

  private async findOne(where: string, value: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `select ${USER_COLUMNS} from users where ${where}`,
      [value],
    );
    const row = rows[0];
    return row ? toUser(row) : null;
  }
}

interface PendingSignupRow {
  id: string;
  email: string;
  email_canonical: string;
  password_hash: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  created_at: Date;
}

const PENDING_COLUMNS = `id, email, email_canonical, password_hash, code_hash,
                         expires_at, attempts, created_at`;

function toPendingSignup(row: PendingSignupRow): PendingSignup {
  return {
    id: row.id,
    email: row.email,
    emailCanonical: row.email_canonical,
    passwordHash: row.password_hash,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

class PostgresPendingSignupRepository implements PendingSignupRepository {
  constructor(private readonly pool: Pool) {}

  async create(pending: NewPendingSignup): Promise<PendingSignup> {
    const { rows } = await this.pool.query<PendingSignupRow>(
      `insert into pending_signups (email, email_canonical, password_hash, code_hash, expires_at)
       values ($1, $2, $3, $4, $5) returning ${PENDING_COLUMNS}`,
      [
        pending.email,
        pending.emailCanonical,
        pending.passwordHash,
        pending.codeHash,
        pending.expiresAt,
      ],
    );
    return toPendingSignup(rows[0]!);
  }

  async listByCanonicalEmail(emailCanonical: string): Promise<PendingSignup[]> {
    const { rows } = await this.pool.query<PendingSignupRow>(
      `select ${PENDING_COLUMNS} from pending_signups
       where email_canonical = $1 order by created_at desc`,
      [emailCanonical],
    );
    return rows.map(toPendingSignup);
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.pool.query('update pending_signups set attempts = attempts + 1 where id = $1', [id]);
  }

  async deleteById(id: string): Promise<void> {
    await this.pool.query('delete from pending_signups where id = $1', [id]);
  }

  async deleteByCanonicalEmail(emailCanonical: string): Promise<void> {
    await this.pool.query('delete from pending_signups where email_canonical = $1', [
      emailCanonical,
    ]);
  }

  async deleteExpired(now: Date): Promise<number> {
    const { rowCount } = await this.pool.query('delete from pending_signups where expires_at <= $1', [
      now,
    ]);
    return rowCount ?? 0;
  }
}

interface PhoneValidationRow {
  phone_e164: string;
  provider: string;
  valid: boolean | null;
  type: string | null;
  raw: unknown;
  checked_at: Date;
}

class PostgresPhoneValidationRepository implements PhoneValidationRepository {
  constructor(private readonly pool: Pool) {}

  async find(phoneE164: string): Promise<PhoneValidation | null> {
    const { rows } = await this.pool.query<PhoneValidationRow>(
      `select phone_e164, provider, valid, type, raw, checked_at
       from phone_validations where phone_e164 = $1`,
      [phoneE164],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      phoneE164: row.phone_e164,
      provider: row.provider,
      valid: row.valid,
      type: row.type,
      raw: row.raw ?? null,
      checkedAt: row.checked_at,
    };
  }

  async save(validation: PhoneValidation): Promise<void> {
    await this.pool.query(
      `insert into phone_validations (phone_e164, provider, valid, type, raw, checked_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (phone_e164) do update
         set provider   = excluded.provider,
             valid      = excluded.valid,
             type       = excluded.type,
             raw        = excluded.raw,
             checked_at = excluded.checked_at`,
      [
        validation.phoneE164,
        validation.provider,
        validation.valid,
        validation.type,
        // Serialise explicitly: node-pg would send a bare string or number
        // as-is, which is not valid jsonb input.
        JSON.stringify(validation.raw ?? null),
        validation.checkedAt,
      ],
    );
  }
}

export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    users: new PostgresUserRepository(pool),
    pendingSignups: new PostgresPendingSignupRepository(pool),
    phoneValidations: new PostgresPhoneValidationRepository(pool),
  };
}
