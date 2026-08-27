import { describe, expect, it } from 'vitest';
import { activityIdToDate, normalizePosts } from '../../src/linkedin/voyager/normalize-posts.js';
import { PostsResponse } from '../../src/schema/post.js';
import { loadEntityFixture } from '../helpers/fixtures.js';

const bundle = {
  topCard: loadEntityFixture('posts', 'minimal', 'topcard.json'),
  posts: loadEntityFixture('posts', 'minimal', 'posts.json'),
};

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

  it('returns an empty list when the feed has no elements', () => {
    const empty = {
      ...bundle,
      posts: {
        data: { data: { feedDashProfileUpdatesByMemberShareFeed: { '*elements': [] } } },
        included: [],
      },
    };
    expect(normalizePosts(empty, 'jane-doe').posts).toEqual([]);
  });
});
