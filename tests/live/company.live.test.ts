import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HttpVoyagerClient } from '../../src/linkedin/voyager/client.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import { LinkedInService } from '../../src/linkedin/service.js';
import { CompanyNotFoundError } from '../../src/errors.js';

/**
 * Hits LinkedIn for real. Skipped unless LI_AT is set:
 *   LI_AT=… pnpm test:live
 */
const liAt = process.env.LI_AT;

describe.skipIf(!liAt)('live: LinkedIn company pages', () => {
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

  it('fetches a company page', async () => {
    const c = await service.getCompany('https://www.linkedin.com/company/anthropicresearch/');
    expect(c.name).toBe('Anthropic');
    expect(c.kind).toBe('company');
    expect(c.universalName).toBe('anthropicresearch');
    expect(c.industries.length).toBeGreaterThan(0);
    expect(c.followerCount).toBeGreaterThan(0);
    expect(c.logo?.url).toContain('media.licdn.com');
    expect(c.meta).toMatchObject({ source: 'voyager', cached: false, warnings: [] });
  });

  it('marks a university page as a school', async () => {
    const c = await service.getCompany('iithyderabad');
    expect(c.kind).toBe('school');
    expect(c.url).toBe('https://www.linkedin.com/school/iithyderabad/');
    expect(c.name).toBeTruthy();
  });

  it('maps an unknown name to COMPANY_NOT_FOUND', async () => {
    await expect(service.getCompany('this-company-does-not-exist-xyz')).rejects.toBeInstanceOf(
      CompanyNotFoundError,
    );
  });
});
