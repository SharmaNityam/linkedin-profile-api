import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalEmail } from '../../../src/auth/email.js';
import { createMemoryRepositories } from '../../../src/auth/memory.js';
import type { MailSender } from '../../../src/auth/mailer.js';
import type { PasswordHasher } from '../../../src/auth/password.js';
import type { PhoneValidator, PhoneVerdict } from '../../../src/auth/phone-validation.js';
import type { PendingSignup, Repositories, User } from '../../../src/auth/repositories.js';
import { AuthService } from '../../../src/auth/service.js';
import { AppError } from '../../../src/errors.js';

const EMAIL = 'john@gmail.com';
const ALIAS = 'j.ohn+1@gmail.com';
const PASSWORD = 'correct horse battery';
const PHONE = '+91 98765 43210';
const PHONE_E164 = '+919876543210';
const OTHER_PHONE = '+919876543211';

function digest(password: string): string {
  return `fake$${createHash('sha256').update(password).digest('hex')}`;
}

/**
 * Fast and deterministic; the real hashers are covered by password.test.ts.
 * It counts `hash` calls, because "how many times did we hash?" is how the
 * timing-oracle guards are asserted. `verify` deliberately does not count.
 */
class FakeHasher implements PasswordHasher {
  hashCalls = 0;

  async hash(password: string): Promise<string> {
    this.hashCalls += 1;
    return digest(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === digest(password);
  }
}

class RecordingMailer implements MailSender {
  readonly sent: { to: string; code: string }[] = [];

  async sendVerificationCode(to: string, code: string): Promise<void> {
    this.sent.push({ to, code });
  }

  get lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('no verification code was sent');
    return last.code;
  }
}

function verdict(over: Partial<PhoneVerdict> = {}): PhoneVerdict {
  return {
    verdict: 'accepted',
    reason: null,
    raw: { valid: true, type: 'Mobile' },
    provider: 'fake',
    type: 'Mobile',
    valid: true,
    ...over,
  };
}

class FakeValidator implements PhoneValidator {
  readonly calls: string[] = [];
  next: PhoneVerdict = verdict();

  async validate(phoneE164: string): Promise<PhoneVerdict> {
    this.calls.push(phoneE164);
    return this.next;
  }
}

async function appError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError, but the call resolved');
}

describe('AuthService', () => {
  let repos: Repositories;
  let hasher: FakeHasher;
  let mailer: RecordingMailer;
  let validator: FakeValidator;
  let clock: Date;
  let service: AuthService;

  const now = (): Date => clock;

  function build(failMode: 'open' | 'closed' = 'open'): AuthService {
    return new AuthService({
      repos,
      hasher,
      mailer,
      phoneValidator: validator,
      allowedDomains: ['gmail.com', 'outlook.com'],
      failMode,
      now,
    });
  }

  async function signupAndVerify(email = EMAIL): Promise<User> {
    await service.signup(email, PASSWORD);
    await service.verifyEmail(email, mailer.lastCode);
    return mustFind(email);
  }

  async function mustFind(email: string): Promise<User> {
    const user = await repos.users.findByCanonicalEmail(canonicalEmail(email));
    if (!user) throw new Error(`no user for ${email}`);
    return user;
  }

  /** Every submission still in flight for an address, newest first. */
  function pendingFor(email: string): Promise<PendingSignup[]> {
    return repos.pendingSignups.listByCanonicalEmail(canonicalEmail(email));
  }

  beforeEach(() => {
    repos = createMemoryRepositories();
    hasher = new FakeHasher();
    mailer = new RecordingMailer();
    validator = new FakeValidator();
    clock = new Date('2026-01-01T00:00:00.000Z');
    service = build();
  });

  describe('signup', () => {
    it('stores a hashed password and mails a six-digit code, creating no account', async () => {
      await service.signup(EMAIL, PASSWORD);

      // Nothing is an account until a code comes back.
      expect(await repos.users.findByCanonicalEmail(canonicalEmail(EMAIL))).toBeNull();

      const [pending] = await pendingFor(EMAIL);
      expect(pending?.passwordHash).not.toBe(PASSWORD);
      expect(pending?.passwordHash).not.toContain(PASSWORD);
      expect(pending?.passwordHash.startsWith('fake$')).toBe(true);
      expect(pending?.email).toBe(EMAIL);

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe(EMAIL);
      expect(mailer.lastCode).toMatch(/^\d{6}$/);
    });

    it('stores the pending code hashed, never in clear', async () => {
      await service.signup(EMAIL, PASSWORD);

      const [pending] = await pendingFor(EMAIL);
      expect(pending?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(pending?.codeHash).not.toBe(mailer.lastCode);
      expect(pending?.attempts).toBe(0);
      expect(pending?.expiresAt.getTime()).toBe(clock.getTime() + 10 * 60_000);
    });

    // The provider is a network round trip we do not control, and it is the
    // one step whose duration would separate "free address" from "already
    // registered". A failure is logged, never returned.
    it('does not fail the signup when the mail provider does', async () => {
      const logged: string[] = [];
      service = new AuthService({
        repos,
        hasher,
        mailer: {
          sendVerificationCode: () => Promise.reject(new Error('provider is down')),
        },
        phoneValidator: validator,
        allowedDomains: ['gmail.com', 'outlook.com'],
        failMode: 'open',
        now,
        log: (_level, message) => logged.push(message),
      });

      await expect(service.signup(EMAIL, PASSWORD)).resolves.toBeUndefined();
      // Let the detached rejection settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(logged).toContain('verification mail failed');
      expect(await pendingFor(EMAIL)).toHaveLength(1);
    });

    it('rejects a domain outside the allowlist', async () => {
      const err = await appError(() => service.signup('john@example.com', PASSWORD));
      expect(err.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
      expect(mailer.sent).toHaveLength(0);
    });

    it('rejects a password shorter than 10 characters', async () => {
      const err = await appError(() => service.signup(EMAIL, 'short1'));
      expect(err.code).toBe('INVALID_REQUEST');
    });

    it('rejects an absurdly long password', async () => {
      const err = await appError(() => service.signup(EMAIL, 'a'.repeat(201)));
      expect(err.code).toBe('INVALID_REQUEST');
    });

    it('rejects a malformed email', async () => {
      const err = await appError(() => service.signup('not-an-email', PASSWORD));
      expect(err.code).toBe('INVALID_REQUEST');
    });

    it('gives an alias of the same mailbox its own submission and its own code', async () => {
      await service.signup(EMAIL, PASSWORD);
      await service.signup(ALIAS, PASSWORD);

      const pending = await pendingFor(EMAIL);
      expect(pending).toHaveLength(2);
      expect(pending[0]?.id).not.toBe(pending[1]?.id);
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]?.code).not.toBe(mailer.sent[0]?.code);
    });

    it('keeps at most five submissions per address, evicting the oldest', async () => {
      for (let i = 1; i <= 5; i += 1) await service.signup(EMAIL, `password-${i}0`);
      const oldest = (await pendingFor(EMAIL)).at(-1);
      const firstCode = mailer.sent[0]!.code;

      await service.signup(EMAIL, 'password-60');

      const pending = await pendingFor(EMAIL);
      expect(pending).toHaveLength(5);
      expect(pending.map((row) => row.id)).not.toContain(oldest?.id);
      // The evicted submission's code no longer opens anything.
      expect((await appError(() => service.verifyEmail(EMAIL, firstCode))).code).toBe(
        'INVALID_CODE',
      );
    });

    it('does not evict submissions for a different address', async () => {
      for (let i = 0; i < 6; i += 1) await service.signup(EMAIL, PASSWORD);
      await service.signup('jane@outlook.com', PASSWORD);
      for (let i = 0; i < 6; i += 1) await service.signup(EMAIL, PASSWORD);

      expect(await pendingFor('jane@outlook.com')).toHaveLength(1);
    });

    it('drops submissions that have expired rather than counting them', async () => {
      await service.signup(EMAIL, PASSWORD);
      clock = new Date('2026-01-01T00:11:00.000Z');

      await service.signup(EMAIL, PASSWORD);

      expect(await pendingFor(EMAIL)).toHaveLength(1);
    });

    it('hashes exactly once for an address that is already verified', async () => {
      await signupAndVerify();
      hasher.hashCalls = 0;

      await service.signup(ALIAS, 'a-completely-different-password');

      expect(hasher.hashCalls).toBe(1);
    });

    it('says nothing and sends nothing once the address is verified', async () => {
      await signupAndVerify();
      mailer.sent.length = 0;

      await expect(
        service.signup(ALIAS, 'a-completely-different-password'),
      ).resolves.toBeUndefined();

      expect(mailer.sent).toHaveLength(0);
      const user = await mustFind(EMAIL);
      expect(user.passwordHash).toBe(digest(PASSWORD));
    });
  });

  describe('verifyEmail', () => {
    it('creates the verified account and returns claims and profile', async () => {
      await service.signup(EMAIL, PASSWORD);
      clock = new Date('2026-01-01T00:05:00.000Z');

      const { claims, me } = await service.verifyEmail(EMAIL, mailer.lastCode);

      const user = await mustFind(EMAIL);
      expect(user.emailVerifiedAt.toISOString()).toBe('2026-01-01T00:05:00.000Z');
      expect(user.passwordHash).toBe(digest(PASSWORD));
      expect(claims).toEqual({
        userId: user.id,
        sessionVersion: user.sessionVersion,
        issuedAt: clock.getTime(),
      });
      expect(me).toEqual({
        email: EMAIL,
        emailVerified: true,
        phoneVerified: false,
        createdAt: user.createdAt.toISOString(),
      });
      expect(await pendingFor(EMAIL)).toEqual([]);
    });

    it('accepts the alias spelling of the same mailbox', async () => {
      await service.signup(EMAIL, PASSWORD);
      await expect(service.verifyEmail(ALIAS, mailer.lastCode)).resolves.toBeTruthy();
    });

    it('clears every rival submission once one of them verifies', async () => {
      await service.signup(EMAIL, 'first-password');
      const first = mailer.lastCode;
      await service.signup(EMAIL, 'second-password');

      await service.verifyEmail(EMAIL, mailer.lastCode);

      expect(await pendingFor(EMAIL)).toEqual([]);
      expect((await appError(() => service.verifyEmail(EMAIL, first))).code).toBe('INVALID_CODE');
    });

    it('rejects a wrong code and counts the attempt', async () => {
      await service.signup(EMAIL, PASSWORD);

      const err = await appError(() => service.verifyEmail(EMAIL, '000000'));

      expect(err.code).toBe('INVALID_CODE');
      expect(err.message).toBe('Verification code is incorrect');
      expect((await pendingFor(EMAIL))[0]?.attempts).toBe(1);
    });

    it('counts attempts per submission, not per address', async () => {
      await service.signup(EMAIL, 'first-password');
      const first = mailer.lastCode;
      await service.signup(EMAIL, 'second-password');

      // Five wrong guesses spend both budgets, because a guess is tried
      // against every live row — but each row counts its own.
      for (let i = 0; i < 3; i += 1) await appError(() => service.verifyEmail(EMAIL, '000000'));

      expect((await pendingFor(EMAIL)).map((row) => row.attempts)).toEqual([3, 3]);
      // Neither row is exhausted yet, so the older code still works.
      await expect(service.verifyEmail(EMAIL, first)).resolves.toBeTruthy();
    });

    it('stops accepting attempts after five wrong ones', async () => {
      await service.signup(EMAIL, PASSWORD);
      const good = mailer.lastCode;

      for (let i = 0; i < 5; i++) {
        expect((await appError(() => service.verifyEmail(EMAIL, '000000'))).code).toBe(
          'INVALID_CODE',
        );
      }

      const err = await appError(() => service.verifyEmail(EMAIL, good));
      expect(err.message).toBe('Too many attempts; request a new code');
    });

    it('reports an expired code', async () => {
      await service.signup(EMAIL, PASSWORD);
      const code = mailer.lastCode;
      clock = new Date('2026-01-01T00:10:01.000Z');

      const err = await appError(() => service.verifyEmail(EMAIL, code));

      expect(err.code).toBe('INVALID_CODE');
      expect(err.message).toContain('expired');
    });

    it('is indistinguishable for an unknown address', async () => {
      const err = await appError(() => service.verifyEmail('nobody@gmail.com', '000000'));
      expect(err.code).toBe('INVALID_CODE');
      expect(err.message).toBe('Verification code is incorrect');
    });

    it('is indistinguishable when nothing is pending', async () => {
      await signupAndVerify();
      const err = await appError(() => service.verifyEmail(EMAIL, '000000'));
      expect(err.code).toBe('INVALID_CODE');
      expect(err.message).toBe('Verification code is incorrect');
    });

    it('ignores an expired submission while a live one is still waiting', async () => {
      await service.signup(EMAIL, 'stale-password');
      const stale = mailer.lastCode;
      clock = new Date('2026-01-01T00:11:00.000Z');
      await service.signup(EMAIL, 'fresh-password');

      expect((await appError(() => service.verifyEmail(EMAIL, stale))).code).toBe('INVALID_CODE');
      await expect(service.verifyEmail(EMAIL, mailer.lastCode)).resolves.toBeTruthy();
      expect((await mustFind(EMAIL)).passwordHash).toBe(digest('fresh-password'));
    });

    it('says "expired" only when every submission has expired', async () => {
      await service.signup(EMAIL, PASSWORD);
      const code = mailer.lastCode;
      clock = new Date('2026-01-01T00:05:00.000Z');
      await service.signup(EMAIL, PASSWORD);
      clock = new Date('2026-01-01T00:12:00.000Z');

      // One live submission left, so a wrong guess is just wrong.
      expect((await appError(() => service.verifyEmail(EMAIL, code))).message).toBe(
        'Verification code is incorrect',
      );

      clock = new Date('2026-01-01T00:16:00.000Z');
      expect((await appError(() => service.verifyEmail(EMAIL, code))).message).toContain('expired');
    });
  });

  /**
   * The hijack this whole table exists to stop. Whoever's mailbox receives the
   * code decides which password the account is created with, no matter who
   * submitted first or last.
   */
  describe('competing signups for one address', () => {
    const VICTIM = 'password-victim-a';
    const ATTACKER = 'password-attacker-b';

    it('gives the account to the code the victim actually received, signing up first', async () => {
      await service.signup(EMAIL, VICTIM);
      const victimCode = mailer.lastCode;
      await service.signup(ALIAS, ATTACKER);

      await service.verifyEmail(EMAIL, victimCode);

      await expect(service.login(EMAIL, VICTIM)).resolves.toBeTruthy();
      expect((await appError(() => service.login(EMAIL, ATTACKER))).code).toBe(
        'INVALID_CREDENTIALS',
      );
    });

    it('gives it to the victim just the same when the attacker signed up first', async () => {
      await service.signup(ALIAS, ATTACKER);
      await service.signup(EMAIL, VICTIM);
      const victimCode = mailer.lastCode;

      await service.verifyEmail(EMAIL, victimCode);

      await expect(service.login(EMAIL, VICTIM)).resolves.toBeTruthy();
      expect((await appError(() => service.login(EMAIL, ATTACKER))).code).toBe(
        'INVALID_CREDENTIALS',
      );
    });

    it('leaves the attacker nothing to verify once the account exists', async () => {
      await service.signup(EMAIL, VICTIM);
      const victimCode = mailer.lastCode;
      await service.signup(ALIAS, ATTACKER);
      const attackerCode = mailer.lastCode;

      await service.verifyEmail(EMAIL, victimCode);

      const err = await appError(() => service.verifyEmail(EMAIL, attackerCode));
      expect(err.code).toBe('INVALID_CODE');
      expect((await mustFind(EMAIL)).passwordHash).toBe(digest(VICTIM));
    });
  });

  describe('setPhone', () => {
    it('normalises the number, records the verdict and marks the phone verified', async () => {
      const user = await signupAndVerify();

      const result = await service.setPhone(user.id, PHONE);

      expect(result.phoneValidation).toBe('accepted');
      expect(result.me.phoneVerified).toBe(true);
      expect(validator.calls).toEqual([PHONE_E164]);

      const stored = await mustFind(EMAIL);
      expect(stored.phoneE164).toBe(PHONE_E164);
      expect(stored.phoneVerifiedAt).toEqual(clock);

      const cached = await repos.phoneValidations.find(PHONE_E164);
      expect(cached).toMatchObject({ provider: 'fake', valid: true, type: 'Mobile' });
    });

    it('reuses the cached verdict instead of calling the provider again', async () => {
      const user = await signupAndVerify();
      await service.setPhone(user.id, PHONE);

      await service.setPhone(user.id, PHONE_E164);

      expect(validator.calls).toHaveLength(1);
    });

    it('rejects a number the provider does not like', async () => {
      const user = await signupAndVerify();
      validator.next = verdict({
        verdict: 'rejected',
        reason: 'the provider reports this number as type Landline',
        type: 'Landline',
      });

      const err = await appError(() => service.setPhone(user.id, PHONE));

      expect(err.code).toBe('PHONE_REJECTED');
      expect((await mustFind(EMAIL)).phoneE164).toBeNull();
    });

    it('caches a rejection too', async () => {
      const user = await signupAndVerify();
      validator.next = verdict({ verdict: 'rejected', reason: 'landline', type: 'Landline' });

      await appError(() => service.setPhone(user.id, PHONE));
      await appError(() => service.setPhone(user.id, PHONE));

      expect(validator.calls).toHaveLength(1);
    });

    it('lets a skipped verdict through when failing open, without caching it', async () => {
      const user = await signupAndVerify();
      validator.next = verdict({
        verdict: 'skipped',
        reason: 'provider returned HTTP 429',
        valid: null,
        type: null,
        raw: null,
      });

      const result = await service.setPhone(user.id, PHONE);

      expect(result.phoneValidation).toBe('skipped');
      expect(result.me.phoneVerified).toBe(true);
      expect(await repos.phoneValidations.find(PHONE_E164)).toBeNull();
    });

    it('refuses a skipped verdict when failing closed', async () => {
      const user = await signupAndVerify();
      service = build('closed');
      validator.next = verdict({
        verdict: 'skipped',
        reason: 'no API key',
        valid: null,
        type: null,
      });

      const err = await appError(() => service.setPhone(user.id, PHONE));

      expect(err.code).toBe('PHONE_REJECTED');
      expect((await mustFind(EMAIL)).phoneE164).toBeNull();
    });

    it('refuses a number another account already holds', async () => {
      const first = await signupAndVerify();
      await service.setPhone(first.id, PHONE);

      await service.signup('jane@outlook.com', PASSWORD);
      await service.verifyEmail('jane@outlook.com', mailer.lastCode);
      const second = await mustFind('jane@outlook.com');

      const err = await appError(() => service.setPhone(second.id, PHONE));
      expect(err.code).toBe('PHONE_TAKEN');
    });

    it('is idempotent for the account that already owns the number', async () => {
      const user = await signupAndVerify();
      await service.setPhone(user.id, PHONE);

      const again = await service.setPhone(user.id, PHONE);

      expect(again.phoneValidation).toBe('accepted');
      expect(again.me.phoneVerified).toBe(true);
    });

    it('lets the same account replace its number', async () => {
      const user = await signupAndVerify();
      await service.setPhone(user.id, PHONE);

      await service.setPhone(user.id, OTHER_PHONE);

      expect((await mustFind(EMAIL)).phoneE164).toBe(OTHER_PHONE);
    });

    it('rejects a user id that no longer exists', async () => {
      const err = await appError(() =>
        service.setPhone('ffffffff-ffff-4fff-8fff-ffffffffffff', PHONE),
      );

      expect(err.code).toBe('UNAUTHENTICATED');
      expect(validator.calls).toHaveLength(0);
    });

    it('names a line type it recognises without quoting the provider', async () => {
      const user = await signupAndVerify();
      validator.next = verdict({
        verdict: 'rejected',
        reason: 'the provider reports this number as type Landline, not a mobile',
        type: 'Landline',
      });

      const err = await appError(() => service.setPhone(user.id, PHONE));

      expect(err.code).toBe('PHONE_REJECTED');
      expect(err.message).toContain('landline');
      expect(err.message).not.toContain('the provider reports');
    });

    it('does not echo an unknown line type back to the caller', async () => {
      const user = await signupAndVerify();
      const type = 'FIXED_LINE_OR_MOBILE <script>';
      validator.next = verdict({
        verdict: 'rejected',
        reason: `the provider reports this number as type ${type}, not a mobile`,
        type,
      });

      const err = await appError(() => service.setPhone(user.id, PHONE));

      expect(err.code).toBe('PHONE_REJECTED');
      expect(err.message).not.toContain(type);
      expect(err.message).not.toContain('the provider reports');
      // The provider's own spelling still reaches the cache, where it is useful.
      expect((await repos.phoneValidations.find(PHONE_E164))?.type).toBe(type);
    });

    it('rejects an unparseable number before touching the provider', async () => {
      const user = await signupAndVerify();

      const err = await appError(() => service.setPhone(user.id, '98765 43210'));

      expect(err.code).toBe('INVALID_PHONE');
      expect(validator.calls).toHaveLength(0);
    });
  });

  describe('login', () => {
    it('returns claims and profile for the right password', async () => {
      const user = await signupAndVerify();

      const { claims, me } = await service.login(ALIAS, PASSWORD);

      expect(claims.userId).toBe(user.id);
      expect(claims.sessionVersion).toBe(user.sessionVersion);
      expect(me.emailVerified).toBe(true);
    });

    it('reports the same error for a wrong password and an unknown address', async () => {
      await signupAndVerify();

      const wrong = await appError(() => service.login(EMAIL, 'not the password'));
      const unknown = await appError(() => service.login('nobody@gmail.com', PASSWORD));

      expect(wrong.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.message).toBe(wrong.message);
    });

    // A pending signup is not an account, and saying so any other way would
    // tell a stranger that somebody is midway through claiming the address.
    it('treats an address that has only been signed up for as unknown', async () => {
      await service.signup(EMAIL, PASSWORD);

      const err = await appError(() => service.login(EMAIL, PASSWORD));

      expect(err.code).toBe('INVALID_CREDENTIALS');
    });

    it('treats a malformed address as bad credentials', async () => {
      const err = await appError(() => service.login('not-an-email', PASSWORD));
      expect(err.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('resolve', () => {
    it('returns the user for current claims', async () => {
      const user = await signupAndVerify();
      const { claims } = await service.login(EMAIL, PASSWORD);

      expect((await service.resolve(claims))?.id).toBe(user.id);
    });

    it('returns null with no claims at all', async () => {
      expect(await service.resolve(undefined)).toBeNull();
    });

    it('returns null for an unknown user', async () => {
      const claims = {
        userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sessionVersion: 0,
        issuedAt: 0,
      };
      expect(await service.resolve(claims)).toBeNull();
    });

    it('returns null once the session version has moved on', async () => {
      const user = await signupAndVerify();
      const { claims } = await service.login(EMAIL, PASSWORD);

      await service.logoutEverywhere(user.id);

      expect(await service.resolve(claims)).toBeNull();
      const after = await service.login(EMAIL, PASSWORD);
      expect(after.claims.sessionVersion).toBe(claims.sessionVersion + 1);
      expect((await service.resolve(after.claims))?.id).toBe(user.id);
    });
  });

  /**
   * With `emailVerification: 'off'` the mailbox is never proved, so the code
   * step disappears entirely: signup is the account, and a taken address is
   * reported instead of hidden.
   */
  describe('without email verification', () => {
    beforeEach(() => {
      service = new AuthService({
        repos,
        hasher,
        mailer,
        phoneValidator: validator,
        allowedDomains: ['gmail.com', 'outlook.com'],
        failMode: 'open',
        emailVerification: 'off',
        now,
      });
    });

    it('creates a verified account and a session, mailing nothing', async () => {
      const result = await service.signup(EMAIL, PASSWORD);

      const user = await mustFind(EMAIL);
      expect(user.emailVerifiedAt).toEqual(clock);
      expect(user.passwordHash).toBe(digest(PASSWORD));
      expect(result?.claims).toEqual({
        userId: user.id,
        sessionVersion: user.sessionVersion,
        issuedAt: clock.getTime(),
      });
      expect(result?.me).toEqual({
        email: EMAIL,
        emailVerified: true,
        phoneVerified: false,
        createdAt: user.createdAt.toISOString(),
      });

      expect(mailer.sent).toHaveLength(0);
      expect(await pendingFor(EMAIL)).toEqual([]);
    });

    it('signs the new account straight in', async () => {
      const result = await service.signup(EMAIL, PASSWORD);
      expect((await service.resolve(result?.claims))?.id).toBe((await mustFind(EMAIL)).id);
    });

    it('reports a second signup for the same mailbox as taken', async () => {
      await service.signup(EMAIL, PASSWORD);

      const err = await appError(() => service.signup(ALIAS, 'a-different-password'));

      expect(err.code).toBe('EMAIL_TAKEN');
      expect(err.status).toBe(409);
      // The first password still owns the account.
      expect((await mustFind(EMAIL)).passwordHash).toBe(digest(PASSWORD));
    });

    it('still enforces the domain allowlist and the password policy', async () => {
      expect((await appError(() => service.signup('john@example.com', PASSWORD))).code).toBe(
        'EMAIL_DOMAIN_NOT_ALLOWED',
      );
      expect((await appError(() => service.signup(EMAIL, 'short1'))).code).toBe('INVALID_REQUEST');
      expect(await repos.users.findByCanonicalEmail(canonicalEmail(EMAIL))).toBeNull();
    });

    it('refuses to verify an email, since no code was ever sent', async () => {
      await service.signup(EMAIL, PASSWORD);

      const err = await appError(() => service.verifyEmail(EMAIL, '000000'));

      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.message).toBe('Email verification is disabled');
    });

    it('leaves login and the phone step exactly as they are', async () => {
      const signup = await service.signup(EMAIL, PASSWORD);
      const user = await mustFind(EMAIL);

      const phoned = await service.setPhone(user.id, PHONE);
      expect(phoned.phoneValidation).toBe('accepted');
      expect(phoned.me.phoneVerified).toBe(true);

      const login = await service.login(ALIAS, PASSWORD);
      expect(login.claims.userId).toBe(signup?.claims.userId);
      expect(login.me.phoneVerified).toBe(true);
    });
  });

  describe('me', () => {
    it('exposes only the four public fields', async () => {
      const user = await signupAndVerify();
      expect(Object.keys(service.me(user)).sort()).toEqual([
        'createdAt',
        'email',
        'emailVerified',
        'phoneVerified',
      ]);
    });
  });
});
