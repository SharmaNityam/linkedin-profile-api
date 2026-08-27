import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HttpVoyagerClient } from '../../src/linkedin/voyager/client.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import { LinkedInService } from '../../src/linkedin/service.js';

/**
 * Hits LinkedIn for real. Skipped unless LI_AT is set:
 *   LI_AT=… pnpm test:live
 */
const liAt = process.env.LI_AT;

describe.skipIf(!liAt)('live: LinkedIn member posts', () => {
  const config = loadConfig({ ...process.env, LI_AT: liAt ?? 'x' });
  const service = new LinkedInService({
    voyager: new HttpVoyagerClient({
      liAt: config.LI_AT,
      companionCookies: config.LI_COOKIES,
      userAgent: config.USER_AGENT,
    }),
    cache: new TtlCache<unknown>(0),
    semaphore: new Semaphore(2),
    postsQueryId: config.VOYAGER_POSTS_QUERY_ID,
  });

  it('fetches the most recent posts of a member', async () => {
    const r = await service.getPosts('https://www.linkedin.com/in/sharmanityam/', 5);

    expect(r.publicIdentifier).toBe('sharmanityam');
    expect(r.count).toBe(5);
    expect(r.posts.length).toBeGreaterThanOrEqual(1);
    expect(r.posts.length).toBeLessThanOrEqual(5);
    expect(r.meta).toMatchObject({ source: 'voyager', cached: false, warnings: [] });

    for (const p of r.posts) {
      expect(p.urn).toMatch(/^urn:li:activity:\d+$/);
      expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false);
      expect(p.author.name).toBeTruthy();
    }

    // An own post carries its social counts.
    expect(r.posts.some((p) => !p.isReshare && p.stats !== null)).toBe(true);
  });

  // The one repost on this profile is the eighth update (see the recorded
  // fixture), so the reshare flag needs the full default page to show up.
  it('flags a repost as a reshare', async () => {
    const r = await service.getPosts('sharmanityam', 10);
    expect(r.posts.length).toBeGreaterThan(5);
    expect(r.posts.some((p) => p.isReshare)).toBe(true);
  });
});
