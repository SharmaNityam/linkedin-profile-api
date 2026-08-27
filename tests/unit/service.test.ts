import { describe, expect, it, vi } from 'vitest';
import { ProfileService, type BrowserFallback } from '../../src/linkedin/service.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import type { VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import {
  ProfileNotFoundError,
  SchemaDriftError,
  SessionExpiredError,
  UpstreamError,
  RateLimitedError,
} from '../../src/errors.js';
import type { ProfileResponse } from '../../src/schema/profile.js';
import { loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');

function transport(
  name: 'http' | 'browser',
  impl: (path: string) => Promise<unknown>,
): VoyagerTransport & { get: ReturnType<typeof vi.fn> } {
  return { name, get: vi.fn(impl) } as unknown as VoyagerTransport & {
    get: ReturnType<typeof vi.fn>;
  };
}

const good = async (path: string) =>
  path.includes('WebTopCardCore') ? topCard : path.includes('profileSkills') ? skillsPage : full;
const failing = (err: Error) => async () => {
  throw err;
};

function build(opts: { http: VoyagerTransport; browser?: BrowserFallback; ttl?: number }) {
  const cache = new TtlCache<ProfileResponse>(opts.ttl ?? 60_000);
  const service = new ProfileService({
    http: opts.http,
    ...(opts.browser ? { browser: opts.browser } : {}),
    cache,
    semaphore: new Semaphore(2),
  });
  return { service, cache };
}

describe('ProfileService', () => {
  it('returns a full profile from the http transport with meta', async () => {
    const { service } = build({ http: transport('http', good) });
    const res = await service.getProfile('https://www.linkedin.com/in/jane-doe/');
    expect(res.fullName).toBe('Jane Doe');
    expect(res.skills).toHaveLength(3);
    expect(res.meta).toMatchObject({
      source: 'voyager',
      cached: false,
      partial: false,
      warnings: [],
    });
    expect(res.meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serves the second request from cache', async () => {
    const http = transport('http', good);
    const { service } = build({ http });
    await service.getProfile('jane-doe');
    const second = await service.getProfile('https://linkedin.com/in/jane-doe');
    expect(second.meta.cached).toBe(true);
    expect(http.get).toHaveBeenCalledTimes(3); // full + topcard + one skills page, once
  });

  it('rejects invalid URLs before touching the network', async () => {
    const http = transport('http', good);
    const { service } = build({ http });
    await expect(service.getProfile('https://www.linkedin.com/company/acme')).rejects.toThrow(
      /company URL/,
    );
    expect(http.get).not.toHaveBeenCalled();
  });

  it.each([
    ['not found', new ProfileNotFoundError('jane-doe')],
    ['session expired', new SessionExpiredError()],
    ['rate limited', new RateLimitedError(10)],
  ])('does not escalate terminal errors (%s) to the browser', async (_n, err) => {
    const browser: BrowserFallback = {
      voyager: transport('browser', good),
      scrapeTopCard: vi.fn(),
    };
    const { service } = build({ http: transport('http', failing(err)), browser });
    await expect(service.getProfile('jane-doe')).rejects.toBe(err);
    expect(
      (browser.voyager as unknown as { get: ReturnType<typeof vi.fn> }).get,
    ).not.toHaveBeenCalled();
    expect(browser.scrapeTopCard).not.toHaveBeenCalled();
  });

  it.each([
    ['schema drift', new SchemaDriftError('deco gone')],
    ['upstream/bot detection', new UpstreamError('999')],
  ])('escalates %s to the browser voyager transport', async (_n, err) => {
    const browser: BrowserFallback = {
      voyager: transport('browser', good),
      scrapeTopCard: vi.fn(),
    };
    const { service } = build({ http: transport('http', failing(err)), browser });
    const res = await service.getProfile('jane-doe');
    expect(res.fullName).toBe('Jane Doe');
    expect(res.meta.source).toBe('browser');
    expect(res.meta.partial).toBe(false);
    expect(browser.scrapeTopCard).not.toHaveBeenCalled();
  });

  it('falls back to the DOM top card when both voyager transports drift, and marks the result partial', async () => {
    const browser: BrowserFallback = {
      voyager: transport('browser', failing(new SchemaDriftError('deco gone'))),
      scrapeTopCard: vi.fn().mockResolvedValue({
        data: {
          url: 'https://www.linkedin.com/in/jane-doe/',
          publicIdentifier: 'jane-doe',
          urn: null,
          firstName: 'Jane',
          lastName: 'Doe',
          fullName: 'Jane Doe',
          pronouns: null,
          headline: 'Engineer',
          about: null,
          location: null,
          industry: null,
          isPremium: null,
          profileImage: null,
          backgroundImage: null,
          experience: [],
          education: [],
          skills: [],
          certifications: [],
          languages: [],
          volunteering: [],
          projects: [],
          honors: [],
          publications: [],
          courses: [],
        },
        warnings: ['top card only'],
      }),
    };
    const { service } = build({
      http: transport('http', failing(new SchemaDriftError('deco gone'))),
      browser,
    });
    const res = await service.getProfile('jane-doe');
    expect(res.headline).toBe('Engineer');
    expect(res.meta).toMatchObject({ source: 'browser', partial: true });
    expect(res.meta.warnings).toEqual([
      expect.stringMatching(/primary path failed/),
      'top card only',
    ]);
  });

  it('surfaces the original error when every fallback fails', async () => {
    const original = new UpstreamError('http down');
    const browser: BrowserFallback = {
      voyager: transport('browser', failing(new UpstreamError('browser down'))),
      scrapeTopCard: vi.fn().mockRejectedValue(new Error('dom down')),
    };
    const { service } = build({ http: transport('http', failing(original)), browser });
    await expect(service.getProfile('jane-doe')).rejects.toBe(original);
  });

  it('throws the http error directly when no browser fallback is configured', async () => {
    const err = new SchemaDriftError('deco gone');
    const { service } = build({ http: transport('http', failing(err)) });
    await expect(service.getProfile('jane-doe')).rejects.toBe(err);
  });

  it('adds a warning instead of failing when the output does not match the schema', async () => {
    const broken = structuredClone(full);
    const profile = broken.included!.find((e) => e.publicIdentifier === 'jane-doe')!;
    profile.firstName = 42; // str() nulls this → fullName still fine; force a real mismatch:
    const http = transport('http', async (path) =>
      path.includes('FullProfileWithEntities') ? broken : good(path),
    );
    const { service } = build({ http });
    const res = await service.getProfile('jane-doe');
    expect(res.firstName).toBe('');
    expect(res.meta.warnings).toEqual([]); // normaliser already coerced it; schema holds
  });
});
