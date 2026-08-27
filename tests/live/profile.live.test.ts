import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HttpVoyagerClient } from '../../src/linkedin/voyager/client.js';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';
import { ProfileService } from '../../src/linkedin/service.js';
import { ProfileNotFoundError } from '../../src/errors.js';
import type { ProfileResponse } from '../../src/schema/profile.js';

/**
 * Hits LinkedIn for real. Skipped unless LI_AT is set:
 *   LI_AT=… pnpm test:live
 */
const liAt = process.env.LI_AT;

describe.skipIf(!liAt)('live: LinkedIn Voyager', () => {
  const config = loadConfig({ ...process.env, LI_AT: liAt ?? 'x' });
  const service = new ProfileService({
    http: new HttpVoyagerClient({
      liAt: config.LI_AT,
      companionCookies: config.LI_COOKIES,
      userAgent: config.USER_AGENT,
    }),
    cache: new TtlCache<ProfileResponse>(0),
    semaphore: new Semaphore(2),
  });

  it('fetches sharmanityam with every section populated', async () => {
    const p = await service.getProfile('https://www.linkedin.com/in/sharmanityam/');
    expect(p.fullName).toBe('Nityam Sharma');
    expect(p.pronouns).toBe('He/Him');
    expect(p.headline).toContain('Brackets');
    expect(p.location).toEqual({ name: 'India', countryCode: 'IN' });
    expect(p.industry).toBe('Computer Software');
    expect(p.profileImage?.url).toContain('profile-displayphoto');
    expect(p.backgroundImage?.url).toContain('profile-displaybackgroundimage');
    expect(p.experience.length).toBeGreaterThanOrEqual(7);
    expect(p.experience.map((e) => e.title)).toContain('Flutter Developer Intern');
    expect(p.education.length).toBeGreaterThanOrEqual(3);
    expect(p.skills.length).toBeGreaterThan(20); // proves paging past the inline cap
    expect(p.certifications.length).toBeGreaterThanOrEqual(2);
    expect(p.languages.length).toBeGreaterThanOrEqual(4);
    expect(p.volunteering.length).toBeGreaterThanOrEqual(3);
    expect(p.meta).toMatchObject({
      source: 'voyager',
      cached: false,
      partial: false,
      warnings: [],
    });
  });

  it('fetches a third-party profile', async () => {
    const p = await service.getProfile('williamhgates');
    expect(p.firstName).toBe('Bill');
    expect(p.about).toBeTruthy();
    expect(p.experience.length).toBeGreaterThan(0);
  });

  it('maps an unknown slug to PROFILE_NOT_FOUND', async () => {
    await expect(service.getProfile('this-slug-does-not-exist-xyz123')).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
  });
});
