import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import { normalizeCompany } from '../../src/linkedin/voyager/normalize-company.js';
import { normalizePosts } from '../../src/linkedin/voyager/normalize-posts.js';
import { EntityGraph } from '../../src/linkedin/voyager/graph.js';
import { TYPES } from '../../src/linkedin/voyager/types.js';
import type { Image } from '../../src/schema/common.js';
import { CompanyResponse } from '../../src/schema/company.js';
import { PostsResponse } from '../../src/schema/post.js';
import { ProfileResponse } from '../../src/schema/profile.js';
import {
  fixturePath,
  hasFixture,
  listEntityFixtures,
  loadEntityFixture,
  loadFixture,
  loadOptionalFixture,
} from '../helpers/fixtures.js';

/**
 * Runs the normalisers over every *recorded* fixture (real LinkedIn responses
 * captured with `pnpm record-fixture`). Guards against schema drift: if
 * LinkedIn changes a decoration, re-record and these assertions tell you what
 * moved.
 */
const RECORDED = readdirSync(fixturePath('', '')).filter((d) => d !== 'minimal' && hasFixture(d));
const COMPANIES = listEntityFixtures('company');
const POSTS = listEntityFixtures('posts');

/** Cookie-gated image URLs are useless to callers, so none may ever escape. */
const PRIVATE_IMAGE = /^https:\/\/www\.linkedin\.com\/dms\/prv\//;

const META = {
  source: 'voyager',
  fetchedAt: '2026-08-27T00:00:00.000Z',
  cached: false,
  durationMs: 0,
  warnings: [],
};

const imageUrls = (image: Image | null | undefined): string[] =>
  image ? [image.url, ...image.variants.map((v) => v.url)] : [];

describe.each(RECORDED)('recorded fixture: %s', (slug) => {
  const full = loadFixture(slug, 'full.json');
  const topCard = loadOptionalFixture(slug, 'topcard.json');
  const skillPages = readdirSync(fixturePath(slug, ''))
    .filter((f) => f.startsWith('skills-'))
    .sort()
    .map((f) => loadFixture(slug, f));

  const profile = normalizeProfile({ full, ...(topCard ? { topCard } : {}), skillPages });

  it('matches the public schema exactly', () => {
    const result = ProfileResponse.safeParse({ ...profile, meta: META });
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
      ...[profile.profileImage, profile.backgroundImage].flatMap(imageUrls),
      ...orgs.map((o) => o?.logoUrl),
    ].filter((u): u is string => typeof u === 'string');
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toMatch(PRIVATE_IMAGE);
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

describe.each(COMPANIES)('recorded company fixture: %s', (slug) => {
  const company = normalizeCompany({ company: loadEntityFixture('company', slug, 'company.json') });

  it('matches the public schema exactly', () => {
    const result = CompanyResponse.safeParse({ ...company, meta: META });
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('has the identity fields every real page has', () => {
    expect(company.universalName).toBe(slug);
    expect(company.name.length).toBeGreaterThan(0);
    expect(company.logo?.url).toMatch(/^https:\/\/media\.licdn\.com\//);
  });

  it('never emits cookie-gated /dms/prv/ image URLs', () => {
    const urls = [company.logo, company.backgroundImage].flatMap(imageUrls);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toMatch(PRIVATE_IMAGE);
  });
});

describe.each(POSTS)('recorded posts fixture: %s', (slug) => {
  const { posts } = normalizePosts(
    {
      topCard: loadEntityFixture('posts', slug, 'topcard.json'),
      posts: loadEntityFixture('posts', slug, 'posts.json'),
    },
    slug,
  );
  const all = posts.flatMap((p) => (p.reshared ? [p, p.reshared] : [p]));

  it('matches the public schema exactly', () => {
    const result = PostsResponse.safeParse({
      url: `https://www.linkedin.com/in/${slug}/recent-activity/all/`,
      publicIdentifier: slug,
      count: posts.length,
      posts,
      meta: META,
    });
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('resolves every post to an activity, a date and an author', () => {
    expect(posts.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.urn).toMatch(/^urn:li:activity:\d+$/);
      expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false);
      expect(p.author.name.length).toBeGreaterThan(0);
    }
  });

  it('carries social counts on at least one post', () => {
    expect(posts.some((p) => p.stats !== null)).toBe(true);
  });

  it('never emits cookie-gated /dms/prv/ image URLs', () => {
    for (const u of all.flatMap((p) => p.images.flatMap(imageUrls))) {
      expect(u).not.toMatch(PRIVATE_IMAGE);
    }
  });
});

if (RECORDED.length === 0) {
  it.skip('no recorded profile fixtures yet, run `pnpm record-fixture <slug>`', () => undefined);
}
if (COMPANIES.length === 0) {
  it.skip('no recorded company fixtures yet, run `pnpm record-fixture company <name>`', () =>
    undefined);
}
if (POSTS.length === 0) {
  it.skip('no recorded posts fixtures yet, run `pnpm record-fixture posts <slug>`', () =>
    undefined);
}
