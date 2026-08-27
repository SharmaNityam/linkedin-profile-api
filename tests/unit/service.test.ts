import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from '../../src/linkedin/service.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import type { VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import { ProfileNotFoundError, SchemaDriftError } from '../../src/errors.js';
import type { ProfileResponse } from '../../src/schema/profile.js';
import { loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');

function transport(impl: (path: string) => Promise<unknown>) {
  const get = vi.fn(impl);
  return { voyager: { name: 'http', get } as unknown as VoyagerTransport, get };
}
const good = async (path: string) =>
  path.includes('WebTopCardCore') ? topCard : path.includes('profileSkills') ? skillsPage : full;

function build(voyager: VoyagerTransport, ttl = 60_000) {
  return new ProfileService({
    voyager,
    cache: new TtlCache<ProfileResponse>(ttl),
    semaphore: new Semaphore(2),
  });
}

describe('ProfileService', () => {
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
