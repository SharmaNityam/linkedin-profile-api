import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkedInService } from '../../src/linkedin/service.js';
import { buildApp } from '../../src/server.js';
import { testAuth } from '../helpers/auth.js';

const services = {} as unknown as LinkedInService;

describe('per-IP account registry on /auth/request-code', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('caps distinct accounts per IP, but existing ones and other IPs keep working', async () => {
    const { auth, mailer } = testAuth({ accountsPerIp: 10 });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const forwardedFor = '203.0.113.20';
    const requestCode = (email: string, forwardedForOverride = forwardedFor) =>
      app!.inject({
        method: 'POST',
        url: '/auth/request-code',
        payload: { email },
        headers: { 'x-forwarded-for': forwardedForOverride },
        remoteAddress: '10.0.0.1',
      });
    const verify = async (email: string) => {
      const requested = await requestCode(email);
      expect(requested.statusCode).toBe(200);
      const code = mailer.codes.get(email)!;
      const res = await app!.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { email, code },
        headers: { 'x-forwarded-for': forwardedFor },
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    };

    for (let i = 0; i < 10; i += 1) {
      await verify(`user${i}@example.com`);
    }

    // 11th distinct account from the same IP is blocked.
    const eleventh = await requestCode('user10@example.com');
    expect(eleventh.statusCode).toBe(403);
    expect(eleventh.json()).toMatchObject({ error: { code: 'TOO_MANY_ACCOUNTS' } });
    expect(eleventh.json<{ error: { message: string } }>().error.message).toContain('10 accounts');

    // An email that already has an account on this IP still gets a code.
    const existing = await requestCode('user0@example.com');
    expect(existing.statusCode).toBe(200);

    // A different IP has its own budget.
    const otherIp = await requestCode('user10@example.com', '203.0.113.21');
    expect(otherIp.statusCode).toBe(200);
  });

  it('records a sign-in on POST /auth/verify', async () => {
    const { auth, mailer, registry } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const email = 'tracked@example.com';
    const requested = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email },
      remoteAddress: '198.51.100.5',
    });
    expect(requested.statusCode).toBe(200);
    const code = mailer.codes.get(email)!;
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { email, code },
      remoteAddress: '198.51.100.5',
    });
    expect(verified.statusCode).toBe(200);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(registry.emailsFor('198.51.100.5', since).has(email)).toBe(true);
  });
});
