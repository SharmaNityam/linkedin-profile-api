import { AppError } from '../errors.js';
import type { LogFn } from '../linkedin/voyager/client.js';
import { codeIsValid, generateCode, hashCode } from './codes.js';
import { canonicalEmail, emailDomain } from './email.js';
import { isAllowedDomain } from './email-domains.js';
import type { MailSender } from './mailer.js';
import type { PasswordHasher } from './password.js';
import { normalizePhone } from './phone.js';
import type { PhoneValidator, PhoneVerdict } from './phone-validation.js';
import type { PhoneValidation, Repositories, User } from './repositories.js';

/** Long enough to be worth hashing, short enough not to be a DoS vector. */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

/** The one message every wrong-code path returns, so none of them is an oracle. */
const WRONG_CODE = 'Verification code is incorrect';

export interface AuthServiceDeps {
  repos: Repositories;
  hasher: PasswordHasher;
  mailer: MailSender;
  phoneValidator: PhoneValidator;
  allowedDomains: readonly string[];
  /** What to do when the phone provider gives no answer. */
  failMode: 'open' | 'closed';
  log?: LogFn;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** What the session cookie carries; small, and never trusted on its own. */
export interface SessionClaims {
  userId: string;
  /** Compared against the stored version, so "log out everywhere" works. */
  sessionVersion: number;
  issuedAt: number;
}

/** The public shape of an account: no ids, no hashes, no phone number. */
export interface Me {
  email: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
}

/**
 * Every account rule lives here, not in the routes: the HTTP layer only maps
 * bodies in and `AppError`s out, so the same flow can be exercised without a
 * server.
 */
export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Resolves whether or not the address is already taken: telling the caller
   * "that email exists" would turn signup into an account-existence oracle.
   * A domain outside the allowlist and a too-short password are safe to
   * report, because neither depends on who has already signed up.
   */
  async signup(email: string, password: string): Promise<void> {
    const canonical = canonicalEmail(email);
    const domain = emailDomain(email);
    if (!isAllowedDomain(domain, this.deps.allowedDomains)) {
      throw new AppError(
        'EMAIL_DOMAIN_NOT_ALLOWED',
        `We only accept addresses from common consumer providers; "${domain}" is not one of them.`,
        { domain },
      );
    }
    assertPasswordPolicy(password);

    const existing = await this.deps.repos.users.findByCanonicalEmail(canonical);
    if (existing) {
      // A verified account keeps its password: re-running signup must not be a
      // way to reset someone else's credentials.
      if (existing.emailVerifiedAt) {
        this.deps.log?.('debug', 'signup for an already verified address', { canonical });
        return;
      }
      await this.issueCode(existing);
      return;
    }

    const user = await this.deps.repos.users.create({
      email: email.trim(),
      emailCanonical: canonical,
      passwordHash: await this.deps.hasher.hash(password),
    });
    await this.issueCode(user);
  }

  /**
   * Consumes the emailed code. Wrong, expired and exhausted all surface as
   * `INVALID_CODE` — the message says which, since by this point the caller
   * has already proven they know an address that received a code.
   */
  async verifyEmail(email: string, code: string): Promise<{ claims: SessionClaims; me: Me }> {
    const user = await this.deps.repos.users.findByCanonicalEmail(canonicalEmail(email));
    if (!user) throw new AppError('INVALID_CODE', WRONG_CODE);

    const stored = await this.deps.repos.verifications.find(user.id);
    if (!stored) throw new AppError('INVALID_CODE', WRONG_CODE);

    const check = codeIsValid({
      stored,
      code,
      now: this.now(),
      maxAttempts: MAX_CODE_ATTEMPTS,
    });
    if (check === 'expired') {
      throw new AppError('INVALID_CODE', 'Verification code has expired; request a new one');
    }
    if (check === 'exhausted') {
      throw new AppError('INVALID_CODE', 'Too many attempts; request a new code');
    }
    if (check === 'mismatch') {
      await this.deps.repos.verifications.incrementAttempts(user.id);
      throw new AppError('INVALID_CODE', WRONG_CODE);
    }

    const at = this.now();
    await this.deps.repos.users.markEmailVerified(user.id, at);
    // Single use: a code that has done its job is not left lying around.
    await this.deps.repos.verifications.delete(user.id);

    const verified = (await this.deps.repos.users.findById(user.id)) ?? {
      ...user,
      emailVerifiedAt: at,
    };
    return { claims: this.claims(verified), me: this.me(verified) };
  }

  /**
   * Claims a phone number for an account. The provider verdict is cached by
   * number, so re-checking one we have already paid for costs nothing — and a
   * `skipped` is never cached, or one bad minute for the provider would be
   * remembered forever.
   */
  async setPhone(
    userId: string,
    phone: string,
  ): Promise<{ me: Me; phoneValidation: 'accepted' | 'skipped' }> {
    const phoneE164 = normalizePhone(phone);

    const owner = await this.deps.repos.users.findByPhone(phoneE164);
    if (owner && owner.id !== userId) throw phoneTaken();

    const verdict = await this.verdictFor(phoneE164);
    const phoneValidation = this.gate(verdict);

    const outcome = await this.deps.repos.users.setPhone(userId, phoneE164, this.now());
    if (outcome === 'taken') throw phoneTaken();

    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid');
    return { me: this.me(user), phoneValidation };
  }

  /**
   * An unknown address and a wrong password are the same answer. An
   * unverified one is not: the caller already proved they know the password,
   * so telling them to go and check their mail leaks nothing new.
   */
  async login(email: string, password: string): Promise<{ claims: SessionClaims; me: Me }> {
    let canonical: string;
    try {
      canonical = canonicalEmail(email);
    } catch {
      throw invalidCredentials();
    }

    const user = await this.deps.repos.users.findByCanonicalEmail(canonical);
    if (!user) {
      // Burn a comparable amount of time, so response latency does not tell an
      // attacker which addresses are registered.
      await this.deps.hasher.hash(password);
      throw invalidCredentials();
    }

    if (!(await this.deps.hasher.verify(user.passwordHash, password))) throw invalidCredentials();
    if (!user.emailVerifiedAt) {
      throw new AppError(
        'EMAIL_UNVERIFIED',
        'Verify your email address before signing in; we sent you a code.',
      );
    }

    return { claims: this.claims(user), me: this.me(user) };
  }

  /** Invalidates every session already issued to this account. */
  async logoutEverywhere(userId: string): Promise<void> {
    await this.deps.repos.users.bumpSessionVersion(userId);
  }

  /**
   * Turns cookie claims back into an account. `null` covers "no cookie",
   * "user is gone" and "the session was revoked" alike; the caller only needs
   * to know it has nobody.
   */
  async resolve(claims: SessionClaims | undefined): Promise<User | null> {
    if (!claims) return null;
    const user = await this.deps.repos.users.findById(claims.userId);
    if (!user || user.sessionVersion !== claims.sessionVersion) return null;
    return user;
  }

  me(user: User): Me {
    return {
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private claims(user: User): SessionClaims {
    return {
      userId: user.id,
      sessionVersion: user.sessionVersion,
      issuedAt: this.now().getTime(),
    };
  }

  /** Replaces any pending code: only the newest one ever verifies. */
  private async issueCode(user: User): Promise<void> {
    const code = generateCode();
    await this.deps.repos.verifications.upsert({
      userId: user.id,
      codeHash: hashCode(code),
      expiresAt: new Date(this.now().getTime() + CODE_TTL_MS),
      attempts: 0,
    });
    await this.deps.mailer.sendVerificationCode(user.email, code);
  }

  /** The cache first, the provider only for numbers nobody has checked yet. */
  private async verdictFor(phoneE164: string): Promise<PhoneVerdict> {
    const cached = await this.deps.repos.phoneValidations.find(phoneE164);
    if (cached) return fromCache(cached);

    const verdict = await this.deps.phoneValidator.validate(phoneE164);
    if (verdict.verdict !== 'skipped') {
      await this.deps.repos.phoneValidations.save({
        phoneE164,
        provider: verdict.provider,
        valid: verdict.valid,
        type: verdict.type,
        raw: verdict.raw,
        checkedAt: this.now(),
      });
    }
    return verdict;
  }

  /** Maps a verdict onto the configured fail mode. */
  private gate(verdict: PhoneVerdict): 'accepted' | 'skipped' {
    if (verdict.verdict === 'accepted') return 'accepted';
    if (verdict.verdict === 'rejected') {
      throw new AppError(
        'PHONE_REJECTED',
        `We can only accept a mobile number: ${verdict.reason ?? 'this one was not accepted'}.`,
      );
    }
    if (this.deps.failMode === 'closed') {
      throw new AppError(
        'PHONE_REJECTED',
        'We could not verify that number right now. Please try again later.',
      );
    }
    this.deps.log?.('warn', 'phone accepted without validation', { reason: verdict.reason });
    return 'skipped';
  }
}

/**
 * Cached rows are only written when the provider actually answered, so the
 * same rule applies as at the time of the call.
 */
function fromCache(cached: PhoneValidation): PhoneVerdict {
  const accepted = cached.valid === true && cached.type?.toLowerCase() === 'mobile';
  return {
    verdict: accepted ? 'accepted' : 'rejected',
    reason: accepted
      ? null
      : cached.valid === true
        ? `the provider reports this number as type ${cached.type ?? 'unknown'}, not a mobile`
        : 'the provider reports this number as not in service (valid=false)',
    raw: cached.raw,
    provider: cached.provider,
    type: cached.type,
    valid: cached.valid,
  };
}

function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AppError(
      'INVALID_REQUEST',
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'That email and password combination is not valid');
}

function phoneTaken(): AppError {
  return new AppError('PHONE_TAKEN', 'That phone number is already linked to another account');
}
