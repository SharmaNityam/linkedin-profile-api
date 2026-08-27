import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalEmail } from '../../../src/auth/email.js';
import { createMemoryRepositories } from '../../../src/auth/memory.js';
import type { MailSender } from '../../../src/auth/mailer.js';
import type { PasswordHasher } from '../../../src/auth/password.js';
import type { PhoneValidator, PhoneVerdict } from '../../../src/auth/phone-validation.js';
import type { Repositories, User } from '../../../src/auth/repositories.js';
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

  beforeEach(() => {
    repos = createMemoryRepositories();
    hasher = new FakeHasher();
    mailer = new RecordingMailer();
    validator = new FakeValidator();
    clock = new Date('2026-01-01T00:00:00.000Z');
    service = build();
  });

  describe('signup', () => {
    it('stores a hashed password and mails a six-digit code', async () => {
      await service.signup(EMAIL, PASSWORD);

      const user = await mustFind(EMAIL);
      expect(user.passwordHash).not.toBe(PASSWORD);
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(user.passwordHash.startsWith('fake$')).toBe(true);
      expect(user.emailVerifiedAt).toBeNull();

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe(EMAIL);
      expect(mailer.lastCode).toMatch(/^\d{6}$/);
    });

    it('stores the pending code hashed, never in clear', async () => {
      await service.signup(EMAIL, PASSWORD);

      const user = await mustFind(EMAIL);
      const pending = await repos.verifications.find(user.id);
      expect(pending?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(pending?.codeHash).not.toBe(mailer.lastCode);
      expect(pending?.attempts).toBe(0);
      expect(pending?.expiresAt.getTime()).toBe(clock.getTime() + 10 * 60_000);
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

    it('re-sends a code for an unverified alias without creating a second user', async () => {
      await service.signup(EMAIL, PASSWORD);
      const first = await mustFind(EMAIL);

      await service.signup(ALIAS, PASSWORD);

      const second = await mustFind(EMAIL);
      expect(second.id).toBe(first.id);
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]?.code).not.toBe(mailer.sent[0]?.code);
    });

    it('rotates the code so only the newest one verifies', async () => {
      await service.signup(EMAIL, PASSWORD);
      const stale = mailer.lastCode;
      await service.signup(ALIAS, PASSWORD);
      const fresh = mailer.lastCode;

      expect(stale).not.toBe(fresh);
      expect((await appError(() => service.verifyEmail(EMAIL, stale))).code).toBe('INVALID_CODE');
      await expect(service.verifyEmail(EMAIL, fresh)).resolves.toBeTruthy();
    });

    it('replaces the password when an unverified address is claimed again', async () => {
      const first = 'first-password-in';
      const second = 'second-password-in';
      await service.signup(EMAIL, first);
      await service.signup(ALIAS, second);

      await service.verifyEmail(EMAIL, mailer.lastCode);

      await expect(service.login(EMAIL, second)).resolves.toBeTruthy();
      expect((await appError(() => service.login(EMAIL, first))).code).toBe('INVALID_CREDENTIALS');
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
    it('marks the email verified and returns claims and profile', async () => {
      await service.signup(EMAIL, PASSWORD);
      clock = new Date('2026-01-01T00:05:00.000Z');

      const { claims, me } = await service.verifyEmail(EMAIL, mailer.lastCode);

      const user = await mustFind(EMAIL);
      expect(user.emailVerifiedAt?.toISOString()).toBe('2026-01-01T00:05:00.000Z');
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
      expect(await repos.verifications.find(user.id)).toBeNull();
    });

    it('accepts the alias spelling of the same mailbox', async () => {
      await service.signup(EMAIL, PASSWORD);
      await expect(service.verifyEmail(ALIAS, mailer.lastCode)).resolves.toBeTruthy();
    });

    it('rejects a wrong code and counts the attempt', async () => {
      await service.signup(EMAIL, PASSWORD);
      const user = await mustFind(EMAIL);

      const err = await appError(() => service.verifyEmail(EMAIL, '000000'));

      expect(err.code).toBe('INVALID_CODE');
      expect(err.message).toBe('Verification code is incorrect');
      expect((await repos.verifications.find(user.id))?.attempts).toBe(1);
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

    it('refuses a phone until the email is verified', async () => {
      await service.signup(EMAIL, PASSWORD);
      const user = await mustFind(EMAIL);

      const err = await appError(() => service.setPhone(user.id, PHONE));

      expect(err.code).toBe('EMAIL_UNVERIFIED');
      expect(validator.calls).toHaveLength(0);
      expect((await mustFind(EMAIL)).phoneE164).toBeNull();
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

    it('refuses an unverified account with its own code', async () => {
      await service.signup(EMAIL, PASSWORD);

      const err = await appError(() => service.login(EMAIL, PASSWORD));

      expect(err.code).toBe('EMAIL_UNVERIFIED');
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
