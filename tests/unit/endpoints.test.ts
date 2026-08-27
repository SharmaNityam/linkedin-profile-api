import { describe, expect, it, vi } from 'vitest';
import {
  fetchProfileBundle,
  profilePath,
  skillsPath,
} from '../../src/linkedin/voyager/endpoints.js';
import type { VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import { UpstreamError } from '../../src/errors.js';
import { loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');

function fakeClient(handler: (path: string) => Promise<unknown>) {
  const get = vi.fn((path: string) => handler(path));
  return { client: { get } as unknown as VoyagerTransport, get };
}

describe('paths', () => {
  it('encodes the identifier and pins the decoration', () => {
    expect(profilePath('张三', 'DECO')).toBe(
      '/identity/dash/profiles?q=memberIdentity&memberIdentity=%E5%BC%A0%E4%B8%89&decorationId=DECO',
    );
    expect(skillsPath('urn:li:fsd_profile:A', 20)).toBe(
      '/identity/dash/profileSkills?q=viewee&profileUrn=urn%3Ali%3Afsd_profile%3AA&start=20&count=50',
    );
  });
});

describe('fetchProfileBundle', () => {
  it('fetches full + top card in parallel and pages the remaining skills', async () => {
    const { client, get } = fakeClient(async (path) => {
      if (path.includes('FullProfileWithEntities')) return full;
      if (path.includes('WebTopCardCore')) return topCard;
      if (path.includes('profileSkills')) return skillsPage;
      throw new Error(`unexpected ${path}`);
    });
    const { bundle, warnings } = await fetchProfileBundle(client, 'jane-doe');
    expect(bundle.full).toBe(full);
    expect(bundle.topCard).toBe(topCard);
    expect(bundle.skillPages).toEqual([skillsPage]);
    expect(warnings).toEqual([]);
    expect(get.mock.calls.map((c) => c[0])).toContainEqual(
      expect.stringContaining('start=2&count=50'),
    );
  });

  it('degrades to a warning when only the top card fails', async () => {
    const { client } = fakeClient(async (path) => {
      if (path.includes('WebTopCardCore')) throw new UpstreamError('boom');
      if (path.includes('profileSkills')) return skillsPage;
      return full;
    });
    const { bundle, warnings } = await fetchProfileBundle(client, 'jane-doe');
    expect(bundle.topCard).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/location name unavailable: boom/)]);
  });

  it('warns instead of failing when skills paging breaks', async () => {
    const { client } = fakeClient(async (path) => {
      if (path.includes('profileSkills')) throw new UpstreamError('nope');
      return path.includes('WebTopCardCore') ? topCard : full;
    });
    const { bundle, warnings } = await fetchProfileBundle(client, 'jane-doe');
    expect(bundle.skillPages).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/skills truncated at 2 of 3/)]);
  });

  it('propagates failure of the main request', async () => {
    const { client } = fakeClient(async () => {
      throw new UpstreamError('down');
    });
    await expect(fetchProfileBundle(client, 'jane-doe')).rejects.toThrow('down');
  });
});
