import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkedInService } from '../../src/linkedin/service.js';
import { buildApp } from '../../src/server.js';
import { testAuth } from '../helpers/auth.js';

const services = {} as unknown as LinkedInService;
const DEFAULT_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'myyahoo.com'];

describe('email domain allowlist on /auth/request-code', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(DEFAULT_DOMAINS)('accepts an address on %s', async (domain) => {
    const { auth } = testAuth({ allowedEmailDomains: DEFAULT_DOMAINS });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: `viewer@${domain}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each(['outlook.in', 'proton.me', 'mailinator.com'])('rejects an address on %s', async (domain) => {
    const { auth } = testAuth({ allowedEmailDomains: DEFAULT_DOMAINS });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: `viewer@${domain}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED' } });
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'Use a gmail.com, yahoo.com, outlook.com or myyahoo.com address',
    );
  });

  it('honours a narrower configured list', async () => {
    const { auth } = testAuth({ allowedEmailDomains: ['proton.me'] });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'viewer@proton.me' },
    });
    expect(allowed.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { email: 'viewer@gmail.com' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED' } });
  });
});
