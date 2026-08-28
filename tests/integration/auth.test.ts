import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EmailVerificationMode } from '../../src/auth/service.js';
import type { LinkedInService } from '../../src/linkedin/service.js';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import type { Meta } from '../../src/schema/common.js';
import type { ProfileResponse } from '../../src/schema/profile.js';
import { buildApp } from '../../src/server.js';
import { loadFixture } from '../helpers/fixtures.js';
import {
  buildTestAuth,
  sidCookie,
  signedInCookie,
  TEST_ORIGIN,
  TEST_PASSWORD,
  TEST_SESSION_KEY,
  type TestAuth,
} from '../helpers/auth.js';

const meta: Meta = {
  source: 'voyager',
  fetchedAt: '2026-08-27T00:00:00.000Z',
  cached: false,
  durationMs: 12,
  warnings: [],
};

const PROFILE: ProfileResponse = {
  ...normalizeProfile({
    full: loadFixture('minimal', 'full.json'),
    topCard: loadFixture('minimal', 'topcard.json'),
  }),
  meta,
};

const EMAIL = 'jane@gmail.com';
const OTHER_EMAIL = 'john@gmail.com';
const PHONE = '+91 98765 43210';
const OTHER_PHONE = '+91 98765 43211';

interface Harness {
  app: FastifyInstance;
  auth: TestAuth;
  getProfile: ReturnType<typeof profileStub>;
}

function profileStub() {
  return vi.fn<(url: string) => Promise<ProfileResponse>>().mockResolvedValue(PROFILE);
}

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function harness(
  over: {
    rateLimitPerMinute?: number;
    authRateLimitPerHour?: number;
    emailVerification?: EmailVerificationMode;
  } = {},
): Promise<Harness> {
  const emailVerification = over.emailVerification ?? 'required';
  const auth = buildTestAuth({ emailVerification });
  const getProfile = profileStub();
  const services = {
    getProfile,
    getCompany: vi.fn(),
    getPosts: vi.fn(),
  } as unknown as LinkedInService;

  const app = await buildApp({
    services,
    auth: auth.auth,
    sessionKey: TEST_SESSION_KEY,
    appOrigin: TEST_ORIGIN,
    secureCookies: false,
    rateLimitPerMinute: over.rateLimitPerMinute ?? 1000,
    authRateLimitPerHour: over.authRateLimitPerHour ?? 1000,
    emailVerification,
  });
  await app.ready();
  open.push(app);
  return { app, auth, getProfile };
}

describe('auth flow', () => {
  it('walks signup → verify → phone → /v1/profile', async () => {
    const { app, auth, getProfile } = await harness();

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: EMAIL, password: TEST_PASSWORD },
    });
    expect(signup.statusCode).toBe(200);
    expect(signup.json()).toEqual({ status: 'verification_sent' });

    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { email: EMAIL, code: auth.mailer.lastCodeFor(EMAIL) },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      email: EMAIL,
      emailVerified: true,
      phoneVerified: false,
    });

    const setCookie = verified.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieHeader).toContain('sid=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).not.toContain('Secure');

    const cookie = sidCookie(verified);

    const beforePhone = await app.inject({
      url: '/v1/profile',
      query: { url: 'jane-doe' },
      headers: { cookie },
    });
    expect(beforePhone.statusCode).toBe(403);
    expect(beforePhone.json()).toMatchObject({ error: { code: 'PHONE_REQUIRED' } });

    const phoned = await app.inject({
      method: 'POST',
      url: '/auth/phone',
      payload: { phone: PHONE },
      headers: { cookie },
    });
    expect(phoned.statusCode).toBe(200);
    expect(phoned.json()).toMatchObject({ phoneVerified: true, phoneValidation: 'accepted' });

    const ok = await app.inject({
      url: '/v1/profile',
      query: { url: 'jane-doe' },
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(PROFILE);
    expect(getProfile).toHaveBeenCalledWith('jane-doe');
  });

  it.each(['/v1/profile', '/v1/company', '/v1/posts'])(
    'refuses %s without a session',
    async (url) => {
      const { app } = await harness();
      const res = await app.inject({ url, query: { url: 'jane-doe' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    },
  );

  it('answers a repeat signup identically and keeps the original password', async () => {
    const { app, auth } = await harness();
    const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
    expect(cookie).toContain('sid=');

    const again = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: EMAIL, password: 'a completely different password' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'verification_sent' });

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ email: EMAIL, phoneVerified: true });
  });

  /**
   * The pre-registration hijack, over real HTTP. Two people submit a signup for
   * one address; the account belongs to whoever's code comes back, whichever
   * order they arrived in.
   */
  describe('two signups racing for one address', () => {
    const VICTIM = 'victim password aa';
    const ATTACKER = 'attacker password bb';

    async function signup(app: FastifyInstance, password: string): Promise<void> {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email: EMAIL, password },
      });
      expect(res.statusCode).toBe(200);
    }

    async function login(app: FastifyInstance, password: string): Promise<number> {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: EMAIL, password },
      });
      return res.statusCode;
    }

    it.each([
      ['the victim signed up first', 0],
      ['the attacker signed up first', 1],
    ])('gives the account to the code the victim received when %s', async (_case, victimIndex) => {
      const { app, auth } = await harness();
      const order = victimIndex === 0 ? [VICTIM, ATTACKER] : [ATTACKER, VICTIM];
      for (const password of order) await signup(app, password);

      // The victim types the code from their own mail, not the newest one.
      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { email: EMAIL, code: auth.mailer.codesFor(EMAIL)[victimIndex] },
      });
      expect(verified.statusCode).toBe(200);

      expect(await login(app, VICTIM)).toBe(200);
      expect(await login(app, ATTACKER)).toBe(401);
    });

    it('leaves the attacker code useless once the account exists', async () => {
      const { app, auth } = await harness();
      await signup(app, VICTIM);
      await signup(app, ATTACKER);
      const [victimCode, attackerCode] = auth.mailer.codesFor(EMAIL);

      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { email: EMAIL, code: victimCode },
      });
      expect(verified.statusCode).toBe(200);

      const attacker = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { email: EMAIL, code: attackerCode },
      });
      expect(attacker.statusCode).toBe(400);
      expect(attacker.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
      expect(await login(app, ATTACKER)).toBe(401);
    });

    it('caps an address at five pending submissions, evicting the oldest', async () => {
      const { app, auth } = await harness();
      for (let i = 1; i <= 6; i += 1) await signup(app, `password number ${i}`);

      const evicted = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { email: EMAIL, code: auth.mailer.codesFor(EMAIL)[0] },
      });
      expect(evicted.statusCode).toBe(400);
      expect(evicted.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });

      // The second-oldest survived, so five is a cap and not a purge.
      const kept = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { email: EMAIL, code: auth.mailer.codesFor(EMAIL)[1] },
      });
      expect(kept.statusCode).toBe(200);
      expect(await login(app, 'password number 2')).toBe(200);
    });
  });

  it('rejects a phone number another account already holds', async () => {
    const { app, auth } = await harness();
    await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
    const second = await signedInCookie(app, auth, { email: OTHER_EMAIL });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/phone',
      payload: { phone: PHONE },
      headers: { cookie: second },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'PHONE_TAKEN' } });
  });
});

/**
 * `EMAIL_VERIFICATION=off`: the same app minus the code step, which is what the
 * hosted demo runs because its sender only delivers to the operator.
 */
describe('auth flow without email verification', () => {
  const off = () => harness({ emailVerification: 'off' });

  it('walks signup → phone → /v1/profile with no code in between', async () => {
    const { app, auth, getProfile } = await off();

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: EMAIL, password: TEST_PASSWORD },
    });
    expect(signup.statusCode).toBe(200);
    expect(signup.json()).toMatchObject({
      email: EMAIL,
      emailVerified: true,
      phoneVerified: false,
    });
    expect(auth.mailer.sent).toHaveLength(0);

    // Signup itself issues the session, so there is nothing to verify.
    const cookie = sidCookie(signup);
    expect(cookie).toContain('sid=');

    const beforePhone = await app.inject({
      url: '/v1/profile',
      query: { url: 'jane-doe' },
      headers: { cookie },
    });
    expect(beforePhone.statusCode).toBe(403);
    expect(beforePhone.json()).toMatchObject({ error: { code: 'PHONE_REQUIRED' } });

    const phoned = await app.inject({
      method: 'POST',
      url: '/auth/phone',
      payload: { phone: PHONE },
      headers: { cookie },
    });
    expect(phoned.statusCode).toBe(200);
    expect(phoned.json()).toMatchObject({ phoneVerified: true, phoneValidation: 'accepted' });

    const ok = await app.inject({
      url: '/v1/profile',
      query: { url: 'jane-doe' },
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(PROFILE);
    expect(getProfile).toHaveBeenCalledWith('jane-doe');
  });

  it('answers a second signup for the address with 409 EMAIL_TAKEN', async () => {
    const { app } = await off();
    const signup = () =>
      app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email: EMAIL, password: TEST_PASSWORD },
      });

    expect((await signup()).statusCode).toBe(200);

    const again = await signup();
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
  });

  it('has nothing for /auth/verify-email to do', async () => {
    const { app } = await off();
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: EMAIL, password: TEST_PASSWORD },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { email: EMAIL, code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', message: 'Email verification is disabled' },
    });
  });

  it('reports the mode on /auth/config, with no session and no budget', async () => {
    const { app } = await off();

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ url: '/auth/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ emailVerification: 'off', phoneValidation: 'none' });
    }
  });
});

describe('GET /auth/config', () => {
  it('reports the required mode by default', async () => {
    const { app } = await harness();
    const res = await app.inject({ url: '/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emailVerification: 'required', phoneValidation: 'none' });
  });

  it('is not budgeted, the way /health is not', async () => {
    const { app } = await harness({ rateLimitPerMinute: 2, authRateLimitPerHour: 2 });
    for (let i = 0; i < 20; i += 1) {
      expect((await app.inject({ url: '/auth/config' })).statusCode).toBe(200);
    }
  });
});

describe('CSRF guards', () => {
  it('rejects a cross-origin POST', async () => {
    const { app, auth } = await harness();
    await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: TEST_PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
  });

  it.each([TEST_ORIGIN, `${TEST_ORIGIN}/`, undefined])('allows origin %s', async (origin) => {
    const { app, auth } = await harness();
    await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: TEST_PASSWORD },
      ...(origin === undefined ? {} : { headers: { origin } }),
    });
    expect(res.statusCode).toBe(200);
  });

  it.each(['https://evil.example', 'null', 'http://localhost:3001'])(
    'rejects a mutating request declaring origin %s',
    async (origin) => {
      const { app, auth } = await harness();
      const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/profile',
        payload: { url: 'jane-doe' },
        headers: { cookie, origin },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
    },
  );

  it('rejects a POST that is not application/json', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: 'email=jane@gmail.com',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  // A cross-site HTML form can post an empty body just as easily as a filled
  // one; the content type is the tell, so it is checked whenever it is sent.
  it('rejects an empty form-encoded POST', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});

describe('public routes', () => {
  /**
   * A cookie on a request for the playground is not a reason to go to the
   * database, and the rolling session must not re-issue a cookie on every
   * asset the page pulls.
   */
  it.each(['/', '/health', '/openapi.json'])(
    'resolves no session for %s, even with a valid cookie',
    async (url) => {
      const { app, auth } = await harness();
      const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
      const findById = vi.spyOn(auth.repos.users, 'findById');

      const res = await app.inject({ url, headers: { cookie } });

      expect(res.statusCode).toBe(200);
      expect(findById).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    },
  );

  it('still resolves the session on /auth/* and /v1/*', async () => {
    const { app, auth } = await harness();
    const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
    const findById = vi.spyOn(auth.repos.users, 'findById');

    expect((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/v1/profile', query: { url: 'jane-doe' }, headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    expect(findById).toHaveBeenCalledTimes(2);
  });
});

describe('session lifecycle', () => {
  it('reports the account through /auth/me only when signed in', async () => {
    const { app, auth } = await harness();

    const anonymous = await app.inject({ url: '/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email: EMAIL,
      emailVerified: true,
      phoneVerified: true,
    });
  });

  it('clears the cookie on logout', async () => {
    const { app, auth } = await harness();
    const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const setCookie = out.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    // What the browser is left holding after applying that header.
    const after = await app.inject({ url: '/auth/me', headers: { cookie: sidCookie(out) } });
    expect(after.statusCode).toBe(401);
  });

  it('invalidates every other session with logout everywhere', async () => {
    const { app, auth } = await harness();
    const first = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

    const second = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: TEST_PASSWORD },
    });
    expect(second.statusCode).toBe(200);
    const secondCookie = sidCookie(second);

    expect((await app.inject({ url: '/auth/me', headers: { cookie: first } })).statusCode).toBe(
      200,
    );

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { everywhere: true },
      headers: { cookie: secondCookie },
    });
    expect(out.statusCode).toBe(200);

    const stale = await app.inject({ url: '/auth/me', headers: { cookie: first } });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('rate limiting', () => {
  it('counts /v1 requests per account, not per IP', async () => {
    const { app, auth } = await harness({ rateLimitPerMinute: 2 });
    const jane = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });
    const john = await signedInCookie(app, auth, { email: OTHER_EMAIL, phone: OTHER_PHONE });

    const hit = (cookie: string) =>
      app.inject({
        url: '/v1/profile',
        query: { url: 'jane-doe' },
        headers: { cookie },
        remoteAddress: '10.0.0.1',
      });

    for (const cookie of [jane, john]) {
      expect((await hit(cookie)).statusCode).toBe(200);
      expect((await hit(cookie)).statusCode).toBe(200);
      const limited = await hit(cookie);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(limited.json<{ error: { message: string } }>().error.message).toContain('per account');
    }
  });

  it('limits /auth/signup per IP', async () => {
    const { app } = await harness({ authRateLimitPerHour: 3 });
    const signup = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email: `jane${n}@gmail.com`, password: TEST_PASSWORD },
        remoteAddress: '10.0.0.2',
      });

    expect((await signup(1)).statusCode).toBe(200);
    expect((await signup(2)).statusCode).toBe(200);
    expect((await signup(3)).statusCode).toBe(200);
    const fourth = await signup(4);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // The client is told how long to wait, not left to guess.
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never limits the playground or /health, query string included', async () => {
    const { app } = await harness({ rateLimitPerMinute: 2 });
    for (let i = 0; i < 30; i += 1) {
      expect((await app.inject({ url: '/' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health?x=1' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/openapi.json?x=1' })).statusCode).toBe(200);
    }
  });

  // Being over budget must never trap someone in a session they cannot end.
  it('lets a limited account still sign out', async () => {
    const { app, auth } = await harness({ rateLimitPerMinute: 2 });
    const cookie = await signedInCookie(app, auth, { email: EMAIL, phone: PHONE });

    const hit = () =>
      app.inject({ url: '/v1/profile', query: { url: 'jane-doe' }, headers: { cookie } });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ status: 'signed_out' });
  });
});

describe('helmet', () => {
  it('sets a CSP that allows LinkedIn media', async () => {
    const { app } = await harness();
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain(
      "img-src 'self' https://media.licdn.com data:",
    );
  });

  it('still serves the docs UI', async () => {
    const { app } = await harness();
    const res = await app.inject({ url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
