import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalEmail } from '../../src/auth/email.js';
import type { MailSender } from '../../src/auth/mailer.js';
import { AppError } from '../../src/errors.js';
import type { LinkedInService } from '../../src/linkedin/service.js';
import { buildApp } from '../../src/server.js';
import { TEST_APP_ORIGIN, testAuth, verifiedCookie } from '../helpers/auth.js';

const services = {} as unknown as LinkedInService;

class FailingMailer implements MailSender {
  async sendCode(): Promise<void> {
    throw new AppError('MAIL_FAILED', 'Could not send the code, try again later');
  }
}

describe('email OTP gate', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('request-code, verify, then /v1/profile with the cookie, 401 without', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const cookie = await verifiedCookie(app, mailer, 'viewer@example.com');
    expect(mailer.codes.get('viewer@example.com')).toMatch(/^\d{6}$/);

    const withCookie = await app.inject({ url: '/v1/profile', query: { url: 'x' }, headers: { cookie } });
    // No mocked service, so this either succeeds through auth or fails deep in
    // the (unstubbed) service — either way it must not be 401.
    expect(withCookie.statusCode).not.toBe(401);

    const withoutCookie = await app.inject({ url: '/v1/profile', query: { url: 'x' } });
    expect(withoutCookie.statusCode).toBe(401);
    expect(withoutCookie.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('request-code always answers 200 code_sent', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'a@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'code_sent' });
    expect(mailer.codes.get('a@example.com')).toMatch(/^\d{6}$/);
  });

  it('verify sets an httpOnly, sameSite=lax, ~30-day cookie', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    await app.inject({ method: 'POST', url: '/auth/request-code', payload: { email: 'a@example.com' } });
    const code = mailer.codes.get('a@example.com')!;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { email: 'a@example.com', code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'a@example.com' });

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(cookieHeader).toContain('sid=');
    expect(cookieHeader.toLowerCase()).toContain('httponly');
    expect(cookieHeader.toLowerCase()).toContain('samesite=lax');
    const maxAge = /max-age=(\d+)/i.exec(cookieHeader)?.[1];
    expect(Number(maxAge)).toBe(30 * 24 * 60 * 60);
  });

  it('wrong code five times reports exhausted, not incorrect', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    await app.inject({ method: 'POST', url: '/auth/request-code', payload: { email: 'a@example.com' } });
    const code = mailer.codes.get('a@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';

    // 5 wrong attempts spends the budget; each is reported as incorrect.
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email: 'a@example.com', code: wrong },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { message: string } }>().error.message).toMatch(/incorrect/i);
    }

    // The 6th attempt, even with a wrong code, reports exhausted.
    const sixth = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { email: 'a@example.com', code: wrong },
    });
    expect(sixth.statusCode).toBe(400);
    expect(sixth.json<{ error: { message: string } }>().error.message).toMatch(/attempts/i);

    // Even the correct code is dead now.
    const withRightCode = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { email: 'a@example.com', code },
    });
    expect(withRightCode.statusCode).toBe(400);
    expect(withRightCode.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
  });

  it('an expired code reports expired', async () => {
    const { auth, mailer, store } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const email = canonicalEmail('a@example.com');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = store.issue(email, now);
    if (issued.status !== 'issued') throw new Error('expected issued');
    mailer.codes.set(email, issued.code);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { email, code: issued.code },
    });
    // Real time has moved past `now`, which was fixed 10+ minutes in the
    // past relative to any plausible test run, so the code has expired.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/expired/i);
  });

  it('rejects a cross-origin POST with FORBIDDEN_ORIGIN', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'a@example.com' },
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
  });

  it('accepts a matching Origin', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'a@example.com' },
      headers: { origin: TEST_APP_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-JSON content type on a mutating request', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      headers: { 'content-type': 'text/plain' },
      payload: 'email=a@example.com',
    });
    expect(res.statusCode).toBe(400);
  });

  it('per-email cap answers 429 with retry-after', async () => {
    const { auth, mailer } = testAuth({ perEmailPerHour: 5 });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/request-code',
        payload: { email: 'capped@example.com' },
      });
      expect(res.statusCode).toBe(200);
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'capped@example.com' },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(sixth.headers['retry-after']).toBeDefined();
    void mailer;
  });

  it('logout clears the cookie', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const cookie = await verifiedCookie(app, mailer);
    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ status: 'signed_out' });
    const clearedCookie = logout.headers['set-cookie'];
    const clearedHeader = Array.isArray(clearedCookie) ? clearedCookie[0] : clearedCookie;

    const meAfter = await app.inject({
      url: '/auth/me',
      headers: clearedHeader ? { cookie: clearedHeader.split(';', 1)[0]! } : {},
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it('GET /auth/me is 401 without a cookie', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({ url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('GET /auth/config reports the gate, unlimited', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 2 });
    await app.ready();

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ url: '/auth/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ gate: 'email' });
    }
  });

  it('/ and /health are never limited even with the OTP gate wired in', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 2 });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ url: '/' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    }
  });

  it('two different verified emails from one IP are rate-limited independently on /v1', async () => {
    const { auth, mailer } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1 });
    await app.ready();

    const cookieA = await verifiedCookie(app, mailer, 'a@example.com');
    const cookieB = await verifiedCookie(app, mailer, 'b@example.com');

    const hitA = () =>
      app!.inject({
        url: '/v1/profile',
        query: { url: 'x' },
        headers: { cookie: cookieA },
        remoteAddress: '10.0.0.5',
      });
    const hitB = () =>
      app!.inject({
        url: '/v1/profile',
        query: { url: 'x' },
        headers: { cookie: cookieB },
        remoteAddress: '10.0.0.5',
      });

    expect((await hitA()).statusCode).not.toBe(429);
    // A's budget (1/min) is now spent; B, a different verified email on the
    // same IP, still has its own.
    expect((await hitA()).statusCode).toBe(429);
    expect((await hitB()).statusCode).not.toBe(429);
  });
});

describe('mail failure', () => {
  it('surfaces as 502 MAIL_FAILED without leaking the cause', async () => {
    const { auth } = testAuth();
    const app = await buildApp({
      services,
      auth: { ...auth, mailer: new FailingMailer() },
      rateLimitPerMinute: 1000,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'a@example.com' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'MAIL_FAILED' } });
    await app.close();
  });
});
