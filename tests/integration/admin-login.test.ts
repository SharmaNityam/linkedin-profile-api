import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveAdminCredential } from '../../src/auth/admin.js';
import type { LinkedInService } from '../../src/linkedin/service.js';
import { buildApp } from '../../src/server.js';
import { testAuth } from '../helpers/auth.js';

const services = {} as unknown as LinkedInService;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'a-long-enough-password';

describe('admin login', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('correct credentials set a session cookie and unlock /v1', async () => {
    const admin = deriveAdminCredential(ADMIN_EMAIL, ADMIN_PASSWORD);
    const { auth } = testAuth({ admin });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: ADMIN_EMAIL, role: 'admin' });

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain('sid=');
    const cookie = cookieHeader!.split(';', 1)[0]!;

    const profile = await app.inject({ url: '/v1/profile', query: { url: 'x' }, headers: { cookie } });
    expect(profile.statusCode).not.toBe(401);
  });

  it('wrong password reports the same message as an unknown email', async () => {
    const admin = deriveAdminCredential(ADMIN_EMAIL, ADMIN_PASSWORD);
    const { auth } = testAuth({ admin });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'not-the-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });

    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: ADMIN_PASSWORD },
    });
    expect(unknownEmail.statusCode).toBe(401);

    expect(wrongPassword.json<{ error: { message: string } }>().error.message).toBe(
      unknownEmail.json<{ error: { message: string } }>().error.message,
    );
  });

  it('401s when no admin is configured', async () => {
    const { auth } = testAuth();
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  });

  it('reports role in GET /auth/me', async () => {
    const admin = deriveAdminCredential(ADMIN_EMAIL, ADMIN_PASSWORD);
    const { auth } = testAuth({ admin });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';', 1)[0]!;

    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ email: ADMIN_EMAIL, role: 'admin' });
  });

  it('GET /auth/config reports admin: true when configured', async () => {
    const admin = deriveAdminCredential(ADMIN_EMAIL, ADMIN_PASSWORD);
    const { auth } = testAuth({ admin });
    app = await buildApp({ services, auth, rateLimitPerMinute: 1000 });
    await app.ready();

    const res = await app.inject({ url: '/auth/config' });
    expect(res.json()).toMatchObject({ admin: true });
  });
});
