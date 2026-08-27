import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import { EntityGraph } from '../../src/linkedin/voyager/graph.js';
import { TYPES } from '../../src/linkedin/voyager/types.js';
import { ProfileResponse } from '../../src/schema/profile.js';
import { fixturePath, hasFixture, loadFixture, loadOptionalFixture } from '../helpers/fixtures.js';

/**
 * Runs the normaliser over every *recorded* fixture (real LinkedIn responses
 * captured with `pnpm record-fixture`). Guards against schema drift: if
 * LinkedIn changes a decoration, re-record and these assertions tell you what
 * moved.
 */
const RECORDED = readdirSync(fixturePath('', '')).filter((d) => d !== 'minimal' && hasFixture(d));

describe.each(RECORDED)('recorded fixture: %s', (slug) => {
  const full = loadFixture(slug, 'full.json');
  const topCard = loadOptionalFixture(slug, 'topcard.json');
  const skillPages = readdirSync(fixturePath(slug, ''))
    .filter((f) => f.startsWith('skills-'))
    .sort()
    .map((f) => loadFixture(slug, f));

  const profile = normalizeProfile({ full, ...(topCard ? { topCard } : {}), skillPages });
  const meta = {
    source: 'voyager',
    fetchedAt: '2026-08-27T00:00:00.000Z',
    cached: false,
    durationMs: 0,
    warnings: [],
  };

  it('matches the public schema exactly', () => {
    const result = ProfileResponse.safeParse({ ...profile, meta });
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('has the identity fields every real profile has', () => {
    expect(profile.publicIdentifier).toBe(slug);
    expect(profile.fullName.length).toBeGreaterThan(0);
    expect(profile.headline).toBeTruthy();
    expect(profile.profileImage?.url).toMatch(/^https:\/\/media\.licdn\.com\//);
    if (topCard) expect(profile.location?.name).toBeTruthy();
  });

  it('never emits cookie-gated /dms/prv/ image URLs', () => {
    const orgs = [
      ...profile.experience.map((e) => e.company),
      ...profile.education.map((e) => e.school),
      ...profile.certifications.map((c) => c.organization),
      ...profile.volunteering.map((v) => v.organization),
    ];
    const urls = [
      ...[profile.profileImage, profile.backgroundImage].flatMap((i) =>
        i ? [i.url, ...i.variants.map((v) => v.url)] : [],
      ),
      ...orgs.map((o) => o?.logoUrl),
    ].filter((u): u is string => typeof u === 'string');
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toMatch(/^https:\/\/www\.linkedin\.com\/dms\/prv\//);
  });

  it('resolves every position to a title and a start date', () => {
    for (const p of profile.experience) {
      expect(p.title).toBeTruthy();
      expect(p.startDate).not.toBeNull();
    }
  });

  it('returns all skills when the inline collection was capped', () => {
    const graph = new EntityGraph(full);
    const root = graph.rootElements().find((e) => e.$type === TYPES.profile);
    const total = graph.collection(root, 'profileSkills').collection?.paging?.total;
    expect(total).toBeDefined();
    expect(profile.skills.length).toBe(total);
  });
});

if (RECORDED.length === 0) {
  it.skip('no recorded fixtures yet, run `pnpm record-fixture <slug>`', () => undefined);
}
