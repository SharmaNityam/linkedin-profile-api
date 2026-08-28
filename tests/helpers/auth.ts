import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { canonicalEmail } from '../../src/auth/email.js';
import { DEFAULT_ALLOWED_EMAIL_DOMAINS } from '../../src/auth/email-domains.js';
import type { MailSender } from '../../src/auth/mailer.js';
import { createMemoryRepositories } from '../../src/auth/memory.js';
import type { PasswordHasher } from '../../src/auth/password.js';
import type { PhoneValidator, PhoneVerdict } from '../../src/auth/phone-validation.js';
import type { Repositories } from '../../src/auth/repositories.js';
import { AuthService } from '../../src/auth/service.js';

/** 32 bytes of hex. Well-formed is all that matters; it is not a secret here. */
export const TEST_SESSION_KEY = 'a3f1'.repeat(16);
export const TEST_ORIGIN = 'http://localhost:3000';

/**
 * Argon2 and scrypt are deliberately slow, which is right in production and
 * useless in a test that signs a handful of users in. The real hashers have
 * their own unit tests.
 */
export class FakeHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `plain:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `plain:${password}`;
  }
}

/**
 * Keeps every code it was asked to send, so tests can read them back. The push
 * happens before the first `await` on purpose: `signup` does not await the
 * send, so a test that reads a code straight after it only sees the code if
 * recording it is synchronous.
 */
export class RecordingMailer implements MailSender {
  readonly sent: { to: string; code: string }[] = [];

  async sendVerificationCode(to: string, code: string): Promise<void> {
    this.sent.push({ to, code });
  }

  /** Every code sent to an address, oldest first, matched the way lookups match. */
  codesFor(email: string): string[] {
    const canonical = canonicalEmail(email);
    return this.sent.filter((m) => canonicalEmail(m.to) === canonical).map((m) => m.code);
  }

  /** The newest code sent to an address, matched the way lookups match. */
  lastCodeFor(email: string): string {
    const last = this.codesFor(email).at(-1);
    if (last === undefined) throw new Error(`no verification code was sent to ${email}`);
    return last;
  }
}

export function acceptedVerdict(over: Partial<PhoneVerdict> = {}): PhoneVerdict {
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

/** Answers with whatever the test scripted; no network, ever. */
export class ScriptedValidator implements PhoneValidator {
  readonly calls: string[] = [];
  next: PhoneVerdict = acceptedVerdict();

  async validate(phoneE164: string): Promise<PhoneVerdict> {
    this.calls.push(phoneE164);
    return this.next;
  }
}

export interface TestAuth {
  auth: AuthService;
  repos: Repositories;
  mailer: RecordingMailer;
  validator: ScriptedValidator;
}

export function buildTestAuth(
  options: { allowedDomains?: readonly string[]; failMode?: 'open' | 'closed' } = {},
): TestAuth {
  const repos = createMemoryRepositories();
  const mailer = new RecordingMailer();
  const validator = new ScriptedValidator();
  const auth = new AuthService({
    repos,
    hasher: new FakeHasher(),
    mailer,
    phoneValidator: validator,
    allowedDomains: options.allowedDomains ?? DEFAULT_ALLOWED_EMAIL_DOMAINS,
    failMode: options.failMode ?? 'open',
  });
  return { auth, repos, mailer, validator };
}

/** The `name=value` pair of the session cookie, ready to send back as `cookie`. */
export function sidCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  const sid = all.find((c) => c.startsWith('sid='));
  if (!sid) throw new Error(`no sid cookie in ${JSON.stringify(all)}`);
  return sid.split(';')[0] ?? '';
}

export const TEST_PASSWORD = 'correct horse battery';

/**
 * Drives the real HTTP flow — signup, then the emailed code, then optionally a
 * phone — and hands back the cookie a browser would be holding afterwards.
 */
export async function signedInCookie(
  app: FastifyInstance,
  harness: TestAuth,
  opts: { email: string; password?: string; phone?: string; remoteAddress?: string },
): Promise<string> {
  const password = opts.password ?? TEST_PASSWORD;
  const address = opts.remoteAddress ?? '127.0.0.1';

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email: opts.email, password },
    remoteAddress: address,
  });
  if (signup.statusCode !== 200) throw new Error(`signup failed: ${signup.body}`);

  const verified = await app.inject({
    method: 'POST',
    url: '/auth/verify-email',
    payload: { email: opts.email, code: harness.mailer.lastCodeFor(opts.email) },
    remoteAddress: address,
  });
  if (verified.statusCode !== 200) throw new Error(`verify-email failed: ${verified.body}`);
  let cookie = sidCookie(verified);

  if (opts.phone !== undefined) {
    const phoned = await app.inject({
      method: 'POST',
      url: '/auth/phone',
      payload: { phone: opts.phone },
      headers: { cookie },
      remoteAddress: address,
    });
    if (phoned.statusCode !== 200) throw new Error(`phone failed: ${phoned.body}`);
    // The session is rolling, so this response may carry a refreshed cookie.
    if (phoned.headers['set-cookie'] !== undefined) cookie = sidCookie(phoned);
  }

  return cookie;
}
