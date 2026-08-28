import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import type { LinkedInService } from '../../src/linkedin/service.js';
import {
  CompanyNotFoundError,
  ProfileNotFoundError,
  RateLimitedError,
  SessionExpiredError,
  InvalidUrlError,
} from '../../src/errors.js';
import { normalizeCompany } from '../../src/linkedin/voyager/normalize-company.js';
import { normalizePosts } from '../../src/linkedin/voyager/normalize-posts.js';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import { loadEntityFixture, loadFixture } from '../helpers/fixtures.js';
import {
  buildTestAuth,
  signedInCookie,
  TEST_ORIGIN,
  TEST_SESSION_KEY,
  type TestAuth,
} from '../helpers/auth.js';
import type { CompanyResponse } from '../../src/schema/company.js';
import type { Meta } from '../../src/schema/common.js';
import type { PostsResponse } from '../../src/schema/post.js';
import type { ProfileResponse } from '../../src/schema/profile.js';

const meta: Meta = {
  source: 'voyager',
  fetchedAt: '2026-08-27T00:00:00.000Z',
  cached: false,
  durationMs: 12,
  warnings: [],
};

const profile: ProfileResponse = {
  ...normalizeProfile({
    full: loadFixture('minimal', 'full.json'),
    topCard: loadFixture('minimal', 'topcard.json'),
  }),
  meta,
};

const company: CompanyResponse = {
  ...normalizeCompany({ company: loadEntityFixture('company', 'minimal', 'company.json') }),
  meta,
};

const posts: PostsResponse = {
  ...normalizePosts(
    {
      posts: loadEntityFixture('posts', 'minimal', 'posts.json'),
      topCard: loadEntityFixture('posts', 'minimal', 'topcard.json'),
    },
    'jane-doe',
  ),
  meta,
};

describe('HTTP API', () => {
  let app: FastifyInstance;
  let auth: TestAuth;
  /** Every /v1 call is made as this signed-in, phone-verified account. */
  let cookie: string;
  const getProfile = vi.fn<(url: string) => Promise<ProfileResponse>>();
  const getCompany = vi.fn<(url: string) => Promise<CompanyResponse>>();
  const getPosts = vi.fn<(url: string, count?: number) => Promise<PostsResponse>>();

  beforeAll(async () => {
    auth = buildTestAuth();
    app = await buildApp({
      services: { getProfile, getCompany, getPosts } as unknown as LinkedInService,
      auth: auth.auth,
      sessionKey: TEST_SESSION_KEY,
      appOrigin: TEST_ORIGIN,
      secureCookies: false,
      rateLimitPerMinute: 1000,
      authRateLimitPerHour: 1000,
    });
    await app.ready();
    cookie = await signedInCookie(app, auth, {
      email: 'jane@gmail.com',
      phone: '+91 98765 43210',
    });
  });
  afterAll(() => app.close());

  it('GET / serves the playground UI', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('LinkedIn Profile API');
    expect(res.body).toContain('/v1/profile');
    expect(res.body).toContain('/auth/me');
    expect(res.body).toContain('bindImages');
  });

  it('GET /health', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /v1/profile returns the profile', async () => {
    getProfile.mockResolvedValueOnce(profile);
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/profile',
      query: { url: 'https://www.linkedin.com/in/jane-doe/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(profile);
    expect(getProfile).toHaveBeenCalledWith('https://www.linkedin.com/in/jane-doe/');
  });

  it('POST /v1/profile accepts a JSON body', async () => {
    getProfile.mockResolvedValueOnce(profile);
    const res = await app.inject({
      headers: { cookie },
      method: 'POST',
      url: '/v1/profile',
      payload: { url: 'jane-doe' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProfileResponse>().publicIdentifier).toBe('jane-doe');
  });

  it('rejects a missing url with 400 INVALID_REQUEST', async () => {
    const res = await app.inject({ headers: { cookie }, url: '/v1/profile' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it.each([
    [new InvalidUrlError('bad'), 400, 'INVALID_URL'],
    [new ProfileNotFoundError('nobody'), 404, 'PROFILE_NOT_FOUND'],
    [new SessionExpiredError(), 503, 'LINKEDIN_SESSION_EXPIRED'],
    [new Error('kaboom'), 500, 'INTERNAL_ERROR'],
  ])('maps %s to %i %s', async (err, status, code) => {
    getProfile.mockRejectedValueOnce(err);
    const res = await app.inject({ headers: { cookie }, url: '/v1/profile', query: { url: 'x' } });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code } });
    if (status === 500) expect(res.body).not.toContain('kaboom');
  });

  it('passes LinkedIn Retry-After through on 429', async () => {
    getProfile.mockRejectedValueOnce(new RateLimitedError(42));
    const res = await app.inject({ headers: { cookie }, url: '/v1/profile', query: { url: 'x' } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
  });

  it('GET /v1/company returns the company', async () => {
    getCompany.mockResolvedValueOnce(company);
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/company',
      query: { url: 'https://www.linkedin.com/company/acme/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(company);
    expect(getCompany).toHaveBeenCalledWith('https://www.linkedin.com/company/acme/');
  });

  it('POST /v1/company accepts a JSON body', async () => {
    getCompany.mockResolvedValueOnce(company);
    const res = await app.inject({
      headers: { cookie },
      method: 'POST',
      url: '/v1/company',
      payload: { url: 'acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CompanyResponse>().universalName).toBe(company.universalName);
    expect(getCompany).toHaveBeenCalledWith('acme');
  });

  it('rejects a company request with no url with 400 INVALID_REQUEST', async () => {
    const res = await app.inject({ headers: { cookie }, url: '/v1/company' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('maps CompanyNotFoundError to 404 COMPANY_NOT_FOUND', async () => {
    getCompany.mockRejectedValueOnce(new CompanyNotFoundError('acme'));
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/company',
      query: { url: 'acme' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'COMPANY_NOT_FOUND' } });
  });

  it('GET /v1/posts passes count through', async () => {
    getPosts.mockResolvedValueOnce(posts);
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/posts',
      query: { url: 'jane-doe', count: '5' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(posts);
    expect(getPosts).toHaveBeenCalledWith('jane-doe', 5);
  });

  it('GET /v1/posts defaults count to 10', async () => {
    getPosts.mockResolvedValueOnce(posts);
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/posts',
      query: { url: 'jane-doe' },
    });
    expect(res.statusCode).toBe(200);
    expect(getPosts).toHaveBeenCalledWith('jane-doe', 10);
  });

  it.each(['0', '51', 'abc', '2.5'])('rejects count=%s with 400', async (count) => {
    const res = await app.inject({
      headers: { cookie },
      url: '/v1/posts',
      query: { url: 'jane-doe', count },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('POST /v1/posts accepts {url, count}', async () => {
    getPosts.mockResolvedValueOnce(posts);
    const res = await app.inject({
      headers: { cookie },
      method: 'POST',
      url: '/v1/posts',
      payload: { url: 'jane-doe', count: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<PostsResponse>().publicIdentifier).toBe('jane-doe');
    expect(getPosts).toHaveBeenCalledWith('jane-doe', 3);
  });

  it.each([
    ['GET', '/nope'],
    ['POST', '/nope'],
    ['GET', '/v1/nope'],
    ['GET', '/auth/nope'],
  ])('answers %s %s with the error envelope', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { cookie } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: `Route ${method} ${url} not found` },
    });
  });

  it('keeps the query string out of the not-found message', async () => {
    const res = await app.inject({ url: '/nope', query: { q: '<script>' } });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'Route GET /nope not found',
    );
  });

  it('OpenAPI lists every route', async () => {
    const res = await app.inject({ url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/profile', '/v1/company', '/v1/posts', '/health']),
    );
  });
});

describe('rate limiting', () => {
  it('returns 429 with our error envelope once the limit is hit', async () => {
    const auth = buildTestAuth();
    const app = await buildApp({
      services: {
        getProfile: vi.fn().mockResolvedValue(profile),
        getCompany: vi.fn().mockResolvedValue(company),
        getPosts: vi.fn().mockResolvedValue(posts),
      } as unknown as LinkedInService,
      auth: auth.auth,
      sessionKey: TEST_SESSION_KEY,
      appOrigin: TEST_ORIGIN,
      secureCookies: false,
      rateLimitPerMinute: 2,
      authRateLimitPerHour: 1000,
    });
    const cookie = await signedInCookie(app, auth, {
      email: 'jane@gmail.com',
      phone: '+91 98765 43210',
    });
    const hit = () =>
      app.inject({
        headers: { cookie },
        url: '/v1/profile',
        query: { url: 'jane-doe' },
        remoteAddress: '10.0.0.1',
      });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const third = await hit();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(third.headers['retry-after']).toBeDefined();
    await app.close();
  });

  // Otherwise 404s are the one response an attacker can generate without
  // limit, which is exactly what guessing at URLs needs.
  it('counts unknown routes against the budget too', async () => {
    const auth = buildTestAuth();
    const app = await buildApp({
      services: {} as unknown as LinkedInService,
      auth: auth.auth,
      sessionKey: TEST_SESSION_KEY,
      appOrigin: TEST_ORIGIN,
      secureCookies: false,
      rateLimitPerMinute: 2,
      authRateLimitPerHour: 1000,
    });
    await app.ready();
    const probe = (n: number) => app.inject({ url: `/guess-${n}`, remoteAddress: '10.0.0.9' });

    expect((await probe(1)).statusCode).toBe(404);
    expect((await probe(2)).statusCode).toBe(404);
    const third = await probe(3);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    await app.close();
  });
});
