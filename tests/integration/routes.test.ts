import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import type { ProfileService } from '../../src/linkedin/service.js';
import {
  ProfileNotFoundError,
  RateLimitedError,
  SessionExpiredError,
  InvalidUrlError,
} from '../../src/errors.js';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import { loadFixture } from '../helpers/fixtures.js';
import type { ProfileResponse } from '../../src/schema/profile.js';

const profile: ProfileResponse = {
  ...normalizeProfile({
    full: loadFixture('minimal', 'full.json'),
    topCard: loadFixture('minimal', 'topcard.json'),
  }),
  meta: {
    source: 'voyager',
    fetchedAt: '2026-08-27T00:00:00.000Z',
    cached: false,
    durationMs: 12,
    partial: false,
    warnings: [],
  },
};

describe('HTTP API', () => {
  let app: FastifyInstance;
  const getProfile = vi.fn<(url: string) => Promise<ProfileResponse>>();

  beforeAll(async () => {
    app = await buildApp({
      service: { getProfile } as unknown as ProfileService,
      rateLimitPerMinute: 1000,
    });
    await app.ready();
  });
  afterAll(() => app.close());

  it('GET / serves the playground UI', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('LinkedIn Profile API');
    expect(res.body).toContain('/v1/profile');
  });

  it('GET /health', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /v1/profile returns the profile', async () => {
    getProfile.mockResolvedValueOnce(profile);
    const res = await app.inject({
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
      method: 'POST',
      url: '/v1/profile',
      payload: { url: 'jane-doe' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProfileResponse>().publicIdentifier).toBe('jane-doe');
  });

  it('rejects a missing url with 400 INVALID_REQUEST', async () => {
    const res = await app.inject({ url: '/v1/profile' });
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
    const res = await app.inject({ url: '/v1/profile', query: { url: 'x' } });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code } });
    if (status === 500) expect(res.body).not.toContain('kaboom');
  });

  it('passes LinkedIn Retry-After through on 429', async () => {
    getProfile.mockRejectedValueOnce(new RateLimitedError(42));
    const res = await app.inject({ url: '/v1/profile', query: { url: 'x' } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
  });

  it('serves OpenAPI with the profile schema', async () => {
    const res = await app.inject({ url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/profile', '/health']));
  });
});

describe('rate limiting', () => {
  it('returns 429 with our error envelope once the per-IP limit is hit', async () => {
    const app = await buildApp({
      service: { getProfile: vi.fn().mockResolvedValue(profile) } as unknown as ProfileService,
      rateLimitPerMinute: 2,
    });
    const hit = () =>
      app.inject({ url: '/v1/profile', query: { url: 'jane-doe' }, remoteAddress: '10.0.0.1' });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const third = await hit();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(third.headers['retry-after']).toBeDefined();
    await app.close();
  });
});
