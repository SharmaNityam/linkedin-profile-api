import { describe, expect, it } from 'vitest';
import { activityIdToDate, normalizePosts } from '../../src/linkedin/voyager/normalize-posts.js';
import { SchemaDriftError } from '../../src/errors.js';
import { PostsResponse } from '../../src/schema/post.js';
import type { VoyagerEntity, VoyagerResponse } from '../../src/linkedin/voyager/types.js';
import { loadEntityFixture } from '../helpers/fixtures.js';

const bundle = {
  topCard: loadEntityFixture('posts', 'minimal', 'topcard.json'),
  posts: loadEntityFixture('posts', 'minimal', 'posts.json'),
};

const testMeta = {
  source: 'voyager',
  fetchedAt: '2026-08-27T00:00:00.000Z',
  cached: false,
  durationMs: 0,
  warnings: [],
};

/** Normalises a drifted `posts` response and returns the drift error it raised. */
function driftOf(posts: unknown): SchemaDriftError {
  try {
    normalizePosts({ ...bundle, posts: posts as VoyagerResponse }, 'jane-doe');
  } catch (err) {
    if (err instanceof SchemaDriftError) return err;
    throw err;
  }
  throw new Error('expected normalizePosts to throw a SchemaDriftError');
}

function findIncluded(posts: typeof bundle.posts, entityUrn: string): VoyagerEntity {
  const included = posts.included ?? [];
  const entity = included.find((e) => e.entityUrn === entityUrn);
  if (!entity) throw new Error(`fixture entity not found: ${entityUrn}`);
  return entity;
}

describe('activityIdToDate', () => {
  it('extracts the Unix-ms timestamp from the activity id', () => {
    expect(activityIdToDate('7390255662376824832').toISOString()).toBe('2025-11-01T05:17:34.221Z');
  });
});

describe('normalizePosts', () => {
  const r = normalizePosts(bundle, 'jane-doe');

  it('keeps LinkedIn order and derives identity from the slug', () => {
    expect(r.publicIdentifier).toBe('jane-doe');
    expect(r.url).toBe('https://www.linkedin.com/in/jane-doe/recent-activity/all/');
    expect(r.posts.map((p) => p.urn)).toEqual([
      'urn:li:activity:7390255662376824832',
      'urn:li:activity:7193517581419380736',
      'urn:li:activity:7358006675577978882',
    ]);
  });

  it('maps an own post with image and stats', () => {
    const p = r.posts[0]!;
    expect(p.author).toEqual({
      name: 'Jane Doe',
      headline: 'Engineer',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(p.url).toBe('https://www.linkedin.com/posts/activity-7390255662376824832-abcd');
    expect(p.isReshare).toBe(false);
    expect(p.images).toHaveLength(1);
    expect(p.images[0]!.variants.map((v) => v.width)).toEqual([800, 1179]);
    expect(p.stats).toEqual({
      likes: 5,
      comments: 1,
      shares: 0,
      reactions: { LIKE: 4, PRAISE: 1 },
    });
    expect(p.createdAt).toBe('2025-11-01T05:17:34.221Z');
  });

  it('flags a plain repost via the header and keeps the original author', () => {
    const p = r.posts[1]!;
    expect(p.isReshare).toBe(true);
    expect(p.reshared).toBeNull();
    expect(p.author.name).toBe('Other Person');
    expect(p.stats).toBeNull();
    expect(p.images).toEqual([]);
  });

  it('nests a reshare-with-thoughts one level', () => {
    const p = r.posts[2]!;
    expect(p.isReshare).toBe(true);
    expect(p.text).toBe('My take');
    expect(p.reshared?.article).toEqual({ url: 'https://example.com/a', title: 'An article' });
    expect(p.reshared).not.toHaveProperty('reshared');
  });

  it('validates against the schema', () => {
    const meta = {
      source: 'voyager',
      fetchedAt: '2026-08-27T00:00:00.000Z',
      cached: false,
      durationMs: 0,
      warnings: [],
    };
    const result = PostsResponse.safeParse({ ...r, meta });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each([
    ['an empty *elements list', { '*elements': [] }],
    ['a feed with no *elements at all', { paging: { count: 10, start: 0, total: 0 } }],
  ])('returns an empty list for %s', (_label, feed) => {
    const empty = {
      ...bundle,
      posts: {
        data: { data: { feedDashProfileUpdatesByMemberShareFeed: feed } },
        included: [],
      },
    };
    expect(normalizePosts(empty, 'jane-doe').posts).toEqual([]);
    expect(normalizePosts(empty, 'jane-doe').count).toBe(0);
  });

  it('raises schema drift when the feed key is missing', () => {
    const err = driftOf({ data: { data: { someOtherFeed: {} } }, included: [] });
    expect(err.message).toContain('feedDashProfileUpdatesByMemberShareFeed');
    expect(err.details).toMatchObject({
      publicIdentifier: 'jane-doe',
      dataKeys: ['someOtherFeed'],
    });
  });

  it('raises schema drift when the feed key is not an object', () => {
    const err = driftOf({
      data: { data: { feedDashProfileUpdatesByMemberShareFeed: null } },
      included: [],
    });
    expect(err.message).toContain('feedDashProfileUpdatesByMemberShareFeed');
  });

  it('raises schema drift when no element resolves to a feed Update', () => {
    const err = driftOf({
      data: {
        data: {
          feedDashProfileUpdatesByMemberShareFeed: { '*elements': ['urn:li:fsd_update:(1)'] },
        },
      },
      included: [
        { entityUrn: 'urn:li:fsd_update:(1)', $type: 'com.linkedin.voyager.dash.feed.Widget' },
      ],
    });
    expect(err.message).toBe('Posts feed elements were not feed Updates');
    expect(err.details).toMatchObject({
      publicIdentifier: 'jane-doe',
      types: ['com.linkedin.voyager.dash.feed.Widget'],
    });
  });

  it('raises schema drift when GraphQL reports a field-level error under a 200', () => {
    const err = driftOf({
      data: { data: null, errors: [{ message: 'Unknown persisted query' }] },
      included: [],
    });
    expect(err.message).toContain('Unknown persisted query');
    expect(err.message).toContain('VOYAGER_POSTS_QUERY_ID');
  });

  it('nulls url for a non-https or relative shareUrl instead of failing the schema', () => {
    const posts = structuredClone(bundle.posts);
    findIncluded(
      posts,
      'urn:li:fsd_update:(urn:li:activity:7390255662376824832,MEMBER_SHARES,EMPTY,DEFAULT,false)',
    ).socialContent = { shareUrl: '/posts/relative' };
    findIncluded(
      posts,
      'urn:li:fsd_update:(urn:li:activity:7193517581419380736,MEMBER_SHARES,EMPTY,DEFAULT,false)',
    ).socialContent = { shareUrl: 'http://example.com/x' };

    const withBad = { ...bundle, posts };
    const r = normalizePosts(withBad, 'jane-doe');
    expect(r.posts[0]!.url).toBeNull();
    expect(r.posts[1]!.url).toBeNull();

    const result = PostsResponse.safeParse({ ...r, meta: testMeta });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('flags a reshare from resharedUpdate presence even when its metadata is missing', () => {
    const posts = structuredClone(bundle.posts);
    const outer = findIncluded(
      posts,
      'urn:li:fsd_update:(urn:li:activity:7358006675577978882,MEMBER_SHARES,EMPTY,DEFAULT,false)',
    );
    const nested = outer.resharedUpdate as VoyagerEntity;
    delete nested.metadata;

    const r = normalizePosts({ ...bundle, posts }, 'jane-doe');
    const p = r.posts[2]!;
    expect(p.isReshare).toBe(true);
    expect(p.reshared).toBeNull();
  });
});
