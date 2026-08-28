import { AppError } from '../errors.js';
import type { LogFn } from '../linkedin/voyager/client.js';
import { codeIsValid, generateCode, hashCode } from './codes.js';
import { canonicalEmail, emailDomain } from './email.js';
import { isAllowedDomain } from './email-domains.js';
import type { MailSender } from './mailer.js';
import type { PasswordHasher } from './password.js';
import { normalizePhone } from './phone.js';
import { answeredVerdict, type PhoneValidator, type PhoneVerdict } from './phone-validation.js';
import type { PendingSignup, PhoneValidation, Repositories, User } from './repositories.js';

/** Long enough to be worth hashing, short enough not to be a DoS vector. */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

/**
 * How many unverified submissions one address may have in flight. Every
 * submission is kept, so somebody has to bound the table; five is enough for a
 * person who mistypes their password and retries, and small enough that
 * hammering one address costs the attacker nothing they can use.
 */
const MAX_PENDING_PER_EMAIL = 5;

/** The one message every wrong-code path returns, so none of them is an oracle. */
const WRONG_CODE = 'Verification code is incorrect';

/** Whether a mailbox has to be proved before an account exists. */
export type EmailVerificationMode = 'required' | 'off';

export interface AuthServiceDeps {
  repos: Repositories;
  hasher: PasswordHasher;
  mailer: MailSender;
  phoneValidator: PhoneValidator;
  allowedDomains: readonly string[];
  /** What to do when the phone provider gives no answer. */
  failMode: 'open' | 'closed';
  /**
   * `required` (the default) mails a code and creates the account only when it
   * comes back. `off` creates a verified account on the signup call itself.
   */
  emailVerification?: EmailVerificationMode;
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
  private readonly emailVerification: EmailVerificationMode;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.emailVerification = deps.emailVerification ?? 'required';
  }

  /**
   * Resolves whether or not the address is already taken: telling the caller
   * "that email exists" would turn signup into an account-existence oracle.
   * A domain outside the allowlist and a too-short password are safe to
   * report, because neither depends on who has already signed up.
   *
   * Every submission is stored on its own, never merged with or overwritten by
   * another one for the same address. An attacker who signs up as
   * `victim@gmail.com` gets their own pending row and their own code; the
   * victim's code creates the account from the victim's row.
   *
   * Resolves to `undefined` when a code was mailed and nothing exists yet, and
   * to a session when `emailVerification` is `off` and the account was created
   * on this call.
   */
  async signup(
    email: string,
    password: string,
  ): Promise<{ claims: SessionClaims; me: Me } | undefined> {
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

    if (this.emailVerification === 'off') {
      return this.signupWithoutVerification(email, canonical, password);
    }

    // An account already exists, so there is nothing to sign up for and no code
    // to send. Burn a hash anyway, so this branch costs what the other one does
    // and response latency does not say which addresses are registered.
    const existing = await this.deps.repos.users.findByCanonicalEmail(canonical);
    if (existing) {
      await this.deps.hasher.hash(password);
      this.deps.log?.('debug', 'signup for an address that already has an account', { canonical });
      return;
    }

    const passwordHash = await this.deps.hasher.hash(password);
    const code = generateCode();
    await this.deps.repos.pendingSignups.create({
      email: email.trim(),
      emailCanonical: canonical,
      passwordHash,
      codeHash: hashCode(code),
      expiresAt: new Date(this.now().getTime() + CODE_TTL_MS),
    });
    await this.capPending(canonical);

    // Deliberately not awaited. The mail provider is a network round trip we do
    // not control, and it is the one step whose duration differs between "this
    // address is free" and "this address already has an account" — awaiting it
    // would hand back the account-existence answer that the matched hash above
    // is there to hide. A send that fails is a logged warning; the caller is
    // told to check their mail either way, and can sign up again.
    void this.deps.mailer.sendVerificationCode(email.trim(), code).catch((err: unknown) => {
      this.deps.log?.('warn', 'verification mail failed', {
        emailCanonical: canonical,
        err: String(err),
      });
    });
  }

  /**
   * Consumes the emailed code, and creates the account from the submission that
   * code belongs to. Wrong, expired and exhausted all surface as `INVALID_CODE`
   * — the message says which, since by this point the caller has already proven
   * they know an address that received a code.
   */
  async verifyEmail(email: string, code: string): Promise<{ claims: SessionClaims; me: Me }> {
    if (this.emailVerification === 'off') {
      throw new AppError('INVALID_REQUEST', 'Email verification is disabled');
    }
    const canonical = canonicalEmail(email);
    const pending = await this.deps.repos.pendingSignups.listByCanonicalEmail(canonical);
    const now = this.now();

    // Newest first, because the code someone has just been mailed is the one
    // they are most likely to be typing.
    let live = 0;
    let exhausted = 0;
    for (const row of pending) {
      const check = codeIsValid({ stored: row, code, now, maxAttempts: MAX_CODE_ATTEMPTS });
      if (check === 'expired') continue;
      live += 1;
      if (check === 'exhausted') {
        exhausted += 1;
        continue;
      }
      if (check === 'mismatch') {
        // Attempts are counted per submission: guessing at one row must not
        // spend the budget of the row the real owner is about to use.
        await this.deps.repos.pendingSignups.incrementAttempts(row.id);
        continue;
      }
      return this.completeSignup(row, canonical, now);
    }

    if (pending.length > 0 && live === 0) {
      throw new AppError('INVALID_CODE', 'Verification code has expired; request a new one');
    }
    if (live > 0 && exhausted === live) {
      throw new AppError('INVALID_CODE', 'Too many attempts; request a new code');
    }
    throw new AppError('INVALID_CODE', WRONG_CODE);
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
    // Establish who is asking before anything else: nobody without an account
    // gets to spend provider quota or claim a number. An account only exists
    // once its mailbox has been proved, so that is the same check.
    const account = await this.deps.repos.users.findById(userId);
    if (!account) throw noSession();

    const phoneE164 = normalizePhone(phone);

    const owner = await this.deps.repos.users.findByPhone(phoneE164);
    if (owner && owner.id !== userId) throw phoneTaken();

    const verdict = await this.verdictFor(phoneE164);
    const phoneValidation = this.gate(verdict);

    const outcome = await this.deps.repos.users.setPhone(userId, phoneE164, this.now());
    if (outcome === 'taken') throw phoneTaken();

    const user = await this.deps.repos.users.findById(userId);
    if (!user) throw noSession();
    return { me: this.me(user), phoneValidation };
  }

  /**
   * An unknown address and a wrong password are the same answer — and an
   * address that has only ever been signed up for, never verified, is an
   * unknown address here: it has no account yet.
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
      // Always true: an account is only ever created by verifying a code. The
      // field stays in the response because clients read it.
      emailVerified: true,
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

  /**
   * The `emailVerification: 'off'` path: no code, no pending row, no mail. The
   * account is created verified and the caller is signed in on the spot.
   *
   * Nothing is being hidden here. Without a code there is no mailbox proof to
   * protect, so a taken address is reported as such rather than answered with
   * the same `verification_sent` every time — an oracle only matters while
   * "already registered" is a different amount of work from "free", and here
   * both branches are one lookup.
   */
  private async signupWithoutVerification(
    email: string,
    canonical: string,
    password: string,
  ): Promise<{ claims: SessionClaims; me: Me }> {
    if (await this.deps.repos.users.findByCanonicalEmail(canonical)) throw emailTaken();

    const passwordHash = await this.deps.hasher.hash(password);
    const at = this.now();
    let user: User;
    try {
      user = await this.deps.repos.users.create({
        email: email.trim(),
        emailCanonical: canonical,
        passwordHash,
        emailVerifiedAt: at,
      });
    } catch (err) {
      // Another signup for the address landed between the lookup and the
      // insert. That is the same answer, reached a moment later.
      if (!(await this.deps.repos.users.findByCanonicalEmail(canonical))) throw err;
      this.deps.log?.('warn', 'lost the race to create an account', { canonical });
      throw emailTaken();
    }

    return { claims: this.claims(user), me: this.me(user) };
  }

  /**
   * Turns the submission whose code was presented into the account. The
   * password that arrives is the one that was submitted with that code, which
   * is the whole point: another submission for the same address cannot lend
   * its password to somebody else's code.
   */
  private async completeSignup(
    pending: PendingSignup,
    canonical: string,
    at: Date,
  ): Promise<{ claims: SessionClaims; me: Me }> {
    let user: User;
    try {
      user = await this.deps.repos.users.create({
        email: pending.email,
        emailCanonical: pending.emailCanonical,
        passwordHash: pending.passwordHash,
        emailVerifiedAt: at,
      });
    } catch (err) {
      // Another submission for this address verified between the listing and
      // the insert. The account is not this caller's to claim, and saying so
      // would tell them one exists.
      const taken = await this.deps.repos.users.findByCanonicalEmail(canonical);
      if (!taken) throw err;
      this.deps.log?.('warn', 'lost the race to create an account', { canonical });
      throw new AppError('INVALID_CODE', WRONG_CODE);
    }

    // Single use, and every rival submission goes with it: once the mailbox
    // has spoken, nobody else's pending password can still become this account.
    await this.deps.repos.pendingSignups.deleteByCanonicalEmail(canonical);
    return { claims: this.claims(user), me: this.me(user) };
  }

  /**
   * Bounds the table. Expired rows are dropped wholesale first — they can never
   * verify again — and anything past the cap for this address goes oldest
   * first, so the submission someone just made always survives.
   */
  private async capPending(canonical: string): Promise<void> {
    await this.deps.repos.pendingSignups.deleteExpired(this.now());
    const pending = await this.deps.repos.pendingSignups.listByCanonicalEmail(canonical);
    for (const row of pending.slice(MAX_PENDING_PER_EMAIL)) {
      await this.deps.repos.pendingSignups.deleteById(row.id);
    }
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
      // The provider's own wording reaches the log and the cached `raw`; the
      // caller gets a phrase we chose, so an unfamiliar line type cannot put
      // provider text into our response.
      this.deps.log?.('debug', 'phone rejected', {
        provider: verdict.provider,
        type: verdict.type,
        valid: verdict.valid,
        reason: verdict.reason,
      });
      throw new AppError(
        'PHONE_REJECTED',
        `We can only accept a mobile number: ${lineType(verdict)}.`,
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
 * Cached rows are only ever written when the provider answered, so replaying
 * one through the same rule is exactly the call we would make today.
 */
function fromCache(cached: PhoneValidation): PhoneVerdict {
  return answeredVerdict({
    provider: cached.provider,
    valid: cached.valid,
    type: cached.type,
    raw: cached.raw,
  });
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

/**
 * How we describe a rejected number. Only line types we recognise are named;
 * anything else collapses to one fixed phrase, so the provider never gets to
 * choose the words in a user-facing message.
 */
const LINE_TYPES: Record<string, string> = {
  landline: 'that one is a landline',
  voip: 'that one is an internet (VoIP) number',
  toll_free: 'that one is a toll-free number',
  prepaid: 'that one is a prepaid number',
  satellite: 'that one is a satellite number',
  pager: 'that one is a pager',
};

const UNRECOGNISED_LINE = 'that one is not a mobile line';

function lineType(verdict: PhoneVerdict): string {
  if (verdict.valid === false) return 'that one is not in service';
  const known = verdict.type ? LINE_TYPES[verdict.type.toLowerCase()] : undefined;
  return known ?? UNRECOGNISED_LINE;
}

function noSession(): AppError {
  return new AppError('UNAUTHENTICATED', 'Your session is no longer valid');
}

function emailTaken(): AppError {
  return new AppError('EMAIL_TAKEN', 'That email address already has an account');
}

function phoneTaken(): AppError {
  return new AppError('PHONE_TAKEN', 'That phone number is already linked to another account');
}
