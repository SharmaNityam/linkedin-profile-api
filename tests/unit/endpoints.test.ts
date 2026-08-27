import { describe, expect, it, vi } from 'vitest';
import {
  DECORATION,
  companyPath,
  fetchCompanyBundle,
  fetchPostsBundle,
  fetchProfileBundle,
  postsPath,
  profilePath,
  skillsPath,
} from '../../src/linkedin/voyager/endpoints.js';
import type { RequestContext, VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import { ProfileNotFoundError, SchemaDriftError, UpstreamError } from '../../src/errors.js';
import { loadEntityFixture, loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');
const company = loadEntityFixture('company', 'minimal', 'company.json');
const postsTopCard = loadEntityFixture('posts', 'minimal', 'topcard.json');
const posts = loadEntityFixture('posts', 'minimal', 'posts.json');

function fake(handler: (path: string) => Promise<unknown>) {
  const calls: string[] = [];
  const contexts: RequestContext[] = [];
  const get = vi.fn((path: string, context: RequestContext) => {
    calls.push(path);
    contexts.push(context);
    return handler(path);
  });
  return { client: { get } as unknown as VoyagerTransport, get, calls, contexts };
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

  it('builds the GraphQL posts path with an unquoted variables tuple', () => {
    expect(postsPath('urn:li:fsd_profile:A', 10, 'hash')).toBe(
      '/graphql?includeWebMetadata=true&variables=(count:10,start:0,profileUrn:urn%3Ali%3Afsd_profile%3AA)&queryId=voyagerFeedDashProfileUpdates.hash',
    );
  });
});

describe('fetchProfileBundle', () => {
  it('fetches full + top card in parallel and pages the remaining skills', async () => {
    const { client, get } = fake(async (path) => {
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
    const { client } = fake(async (path) => {
      if (path.includes('WebTopCardCore')) throw new UpstreamError('boom');
      if (path.includes('profileSkills')) return skillsPage;
      return full;
    });
    const { bundle, warnings } = await fetchProfileBundle(client, 'jane-doe');
    expect(bundle.topCard).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/location name unavailable: boom/)]);
  });

  it('warns instead of failing when skills paging breaks', async () => {
    const { client } = fake(async (path) => {
      if (path.includes('profileSkills')) throw new UpstreamError('nope');
      return path.includes('WebTopCardCore') ? topCard : full;
    });
    const { bundle, warnings } = await fetchProfileBundle(client, 'jane-doe');
    expect(bundle.skillPages).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/skills truncated at 2 of 3/)]);
  });

  it('propagates failure of the main request', async () => {
    const { client } = fake(async () => {
      throw new UpstreamError('down');
    });
    await expect(fetchProfileBundle(client, 'jane-doe')).rejects.toThrow('down');
  });
});

describe('fetchCompanyBundle', () => {
  it('requests the company decoration with the universal name', async () => {
    const { client, calls } = fake(async () => company);
    const { bundle, warnings } = await fetchCompanyBundle(client, 'acme');
    expect(calls[0]).toContain(
      '/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=acme',
    );
    expect(bundle.company).toBe(company);
    expect(warnings).toEqual([]);
  });

  it('passes the company context so 404s map to COMPANY_NOT_FOUND', async () => {
    const { client, contexts } = fake(async () => company);
    await fetchCompanyBundle(client, 'acme');
    expect(contexts[0]).toEqual({ kind: 'company', identifier: 'acme' });
  });

  it('encodes the universal name', () => {
    expect(companyPath('a b/c')).toBe(
      `/organization/companies?decorationId=${DECORATION.company}&q=universalName&universalName=a%20b%2Fc`,
    );
  });
});

describe('fetchPostsBundle', () => {
  it('fetches the top card for the URN, then the GraphQL feed', async () => {
    const { client, calls } = fake(async (p) =>
      p.includes('WebTopCardCore') ? postsTopCard : posts,
    );
    const { bundle, warnings } = await fetchPostsBundle(client, 'jane-doe', 7, 'abc123');
    expect(calls[0]).toContain('WebTopCardCore');
    expect(calls[1]).toBe(
      '/graphql?includeWebMetadata=true&variables=(count:7,start:0,profileUrn:urn%3Ali%3Afsd_profile%3AACoAAtest)&queryId=voyagerFeedDashProfileUpdates.abc123',
    );
    expect(bundle.topCard).toBe(postsTopCard);
    expect(bundle.posts).toBe(posts);
    expect(warnings).toEqual([]);
  });

  it('uses the posts context for both calls', async () => {
    const { client, contexts } = fake(async (p) =>
      p.includes('WebTopCardCore') ? postsTopCard : posts,
    );
    await fetchPostsBundle(client, 'jane-doe', 7, 'abc123');
    expect(contexts).toEqual([
      { kind: 'posts', identifier: 'jane-doe' },
      { kind: 'posts', identifier: 'jane-doe' },
    ]);
  });

  it('maps a rejected queryId to SCHEMA_DRIFT naming the env var', async () => {
    const { client } = fake(async (p) => {
      if (p.includes('graphql')) {
        throw new SchemaDriftError('LinkedIn rejected the request: bad request', { status: 400 });
      }
      return postsTopCard;
    });
    await expect(fetchPostsBundle(client, 'jane-doe', 10, 'stale')).rejects.toThrow(
      /VOYAGER_POSTS_QUERY_ID/,
    );
  });

  it('maps a GraphQL 404 to the same stale-queryId SCHEMA_DRIFT', async () => {
    const { client } = fake(async (p) => {
      if (p.includes('graphql')) throw new ProfileNotFoundError('jane-doe');
      return postsTopCard;
    });
    const err = await fetchPostsBundle(client, 'jane-doe', 10, 'stale').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).details).toMatchObject({
      queryId: 'stale',
      publicIdentifier: 'jane-doe',
    });
  });

  it('propagates other upstream failures unchanged', async () => {
    const { client } = fake(async (p) => {
      if (p.includes('graphql')) throw new UpstreamError('down');
      return postsTopCard;
    });
    await expect(fetchPostsBundle(client, 'jane-doe', 10, 'x')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('throws SCHEMA_DRIFT when the top card has no profile URN', async () => {
    const { client } = fake(async () => ({ data: {}, included: [] }));
    await expect(fetchPostsBundle(client, 'jane-doe', 10, 'x')).rejects.toBeInstanceOf(
      SchemaDriftError,
    );
  });
});
