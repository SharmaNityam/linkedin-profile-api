import type { FastifyInstance } from 'fastify';
import { canonicalEmail } from '../../src/auth/email.js';
import type { MailSender } from '../../src/auth/mailer.js';
import { OtpStore } from '../../src/auth/otp.js';
import type { BuildAppAuthOptions } from '../../src/server.js';

/** A valid 32-byte key, fixed so tests are deterministic. */
export const TEST_SESSION_KEY = 'a'.repeat(64);
export const TEST_APP_ORIGIN = 'http://localhost:3000';

/** Captures every code sent instead of mailing it, so tests can read it back. */
export class RecordingMailer implements MailSender {
  readonly codes = new Map<string, string>();

  async sendCode(to: string, code: string): Promise<void> {
    this.codes.set(to, code);
  }
}

export interface TestAuth {
  auth: BuildAppAuthOptions;
  mailer: RecordingMailer;
  store: OtpStore;
}

export interface TestAuthOverrides {
  /** Per IP, on /auth/request-code and /auth/verify. Generous by default. */
  otpRateLimitPerHour: number;
  /** Per email address, on code issuance. Generous by default. */
  perEmailPerHour: number;
}

/** A ready-to-use `auth` option for `buildApp`, generous limits by default. */
export function testAuth(overrides: Partial<TestAuthOverrides> = {}): TestAuth {
  const mailer = new RecordingMailer();
  const store = new OtpStore(overrides.perEmailPerHour ?? 1000);
  return {
    mailer,
    store,
    auth: {
      store,
      mailer,
      sessionKey: TEST_SESSION_KEY,
      appOrigin: TEST_APP_ORIGIN,
      secureCookies: false,
      otpRateLimitPerHour: overrides.otpRateLimitPerHour ?? 1000,
    },
  };
}

/** Runs the full request-code/verify flow and returns the `sid` cookie header. */
export async function verifiedCookie(
  app: FastifyInstance,
  mailer: RecordingMailer,
  email = 'viewer@example.com',
): Promise<string> {
  const requested = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { email } });
  if (requested.statusCode !== 200) {
    throw new Error(`request-code failed: ${requested.statusCode} ${requested.body}`);
  }

  const code = mailer.codes.get(canonicalEmail(email));
  if (!code) throw new Error(`no code recorded for ${email}`);

  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { email, code } });
  if (verified.statusCode !== 200) {
    throw new Error(`verify failed: ${verified.statusCode} ${verified.body}`);
  }

  const setCookie = verified.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) throw new Error('verify did not set a cookie');
  return cookieHeader.split(';', 1)[0]!;
}
