import { describe, expect, it, vi } from 'vitest';
import { LinkedInService } from '../../src/linkedin/service.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import type { VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import { ProfileNotFoundError, SchemaDriftError } from '../../src/errors.js';
import { loadEntityFixture, loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');
const companyFixture = loadEntityFixture('company', 'minimal', 'company.json');
const postsFixture = loadEntityFixture('posts', 'minimal', 'posts.json');

function transport(impl: (path: string) => Promise<unknown>) {
  const get = vi.fn(impl);
  return { voyager: { name: 'http', get } as unknown as VoyagerTransport, get };
}
const good = async (path: string) =>
  path.includes('WebTopCardCore') ? topCard : path.includes('profileSkills') ? skillsPage : full;

function build(voyager: VoyagerTransport, ttl = 60_000) {
  return new LinkedInService({
    voyager,
    cache: new TtlCache<unknown>(ttl),
    semaphore: new Semaphore(2),
    postsQueryId: 'test-id',
  });
}

describe('LinkedInService.getProfile', () => {
  it('returns a full profile with meta', async () => {
    const res = await build(transport(good).voyager).getProfile(
      'https://www.linkedin.com/in/jane-doe/',
    );
    expect(res.fullName).toBe('Jane Doe');
    expect(res.skills).toHaveLength(3);
    expect(res.meta).toMatchObject({ source: 'voyager', cached: false, warnings: [] });
    expect(res.meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serves the second request from cache', async () => {
    const { voyager, get } = transport(good);
    const service = build(voyager);
    await service.getProfile('jane-doe');
    const second = await service.getProfile('https://linkedin.com/in/jane-doe');
    expect(second.meta.cached).toBe(true);
    expect(get).toHaveBeenCalledTimes(3); // full + topcard + one skills page, once
  });

  it('rejects invalid URLs before touching the network', async () => {
    const { voyager, get } = transport(good);
    await expect(
      build(voyager).getProfile('https://www.linkedin.com/company/acme'),
    ).rejects.toThrow(/company URL/);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['not found', new ProfileNotFoundError('jane-doe')],
    ['schema drift', new SchemaDriftError('deco gone')],
  ])('propagates %s from the transport', async (_n, err) => {
    const { voyager } = transport(async () => {
      throw err;
    });
    await expect(build(voyager).getProfile('jane-doe')).rejects.toBe(err);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const { voyager } = transport(async (path) => {
      if (calls++ === 0) throw new SchemaDriftError('x');
      return good(path);
    });
    const service = build(voyager);
    await expect(service.getProfile('jane-doe')).rejects.toBeInstanceOf(SchemaDriftError);
    await expect(service.getProfile('jane-doe')).resolves.toMatchObject({ fullName: 'Jane Doe' });
  });
});

describe('LinkedInService.getCompany', () => {
  it('returns a company with meta and caches by name', async () => {
    const { voyager, get } = transport(async () => companyFixture);
    const s = build(voyager);
    const first = await s.getCompany('https://www.linkedin.com/company/acme/');
    expect(first.name).toBe('Acme');
    expect(first.meta.cached).toBe(false);
    expect((await s.getCompany('acme')).meta.cached).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not collide with the profile cache', async () => {
    const { voyager } = transport(async (p) =>
      p.includes('organization') ? companyFixture : good(p),
    );
    const s = build(voyager);
    await s.getProfile('acme');
    const c = await s.getCompany('acme');
    expect(c.meta.cached).toBe(false);
  });
});

describe('LinkedInService.getPosts', () => {
  it('fetches, clamps count and caches per count', async () => {
    const { voyager, get } = transport(async (p) =>
      p.includes('graphql') ? postsFixture : topCard,
    );
    const s = build(voyager);
    const r = await s.getPosts('jane-doe', 500);
    expect(get.mock.calls[1]![0]).toContain('count:50');
    expect(r.count).toBeGreaterThan(0);
    expect((await s.getPosts('jane-doe', 500)).meta.cached).toBe(true);
    expect((await s.getPosts('jane-doe', 5)).meta.cached).toBe(false);
  });

  it('uses the configured query id', async () => {
    const { voyager, get } = transport(async (p) =>
      p.includes('graphql') ? postsFixture : topCard,
    );
    await build(voyager).getPosts('jane-doe');
    expect(get.mock.calls[1]![0]).toContain('voyagerFeedDashProfileUpdates.test-id');
  });
});
