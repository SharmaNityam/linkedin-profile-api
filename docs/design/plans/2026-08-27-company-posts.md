# Company and Posts Endpoints Implementation Plan


**Goal:** Add `GET|POST /v1/company` and `GET|POST /v1/posts` backed by LinkedIn Voyager, fully testable offline.

**Architecture:** Same pipeline as profile: `url.ts` parse → `LinkedInService` (cache + semaphore) → `endpoints.ts` fetch bundle → `normalize-*.ts` pure function → zod schema → route. Every Voyager literal lives in `endpoints.ts`; every normaliser is pure and tested against hand-written and recorded fixtures.

**Tech Stack:** Fastify 5, zod 4, fastify-type-provider-zod, Vitest, TypeScript NodeNext ESM (imports end in `.js`), pnpm.

## Global Constraints

- Spec: `docs/design/specs/2026-08-27-company-posts-design.md` — read it first; the "What was observed live" section is the source of truth for field paths.
- No new dependencies.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` must stay green after every task; `pnpm test` must never need the network.
- Commit after every task: subject line 6–7 words, no body.
- Do not touch `public/index.html` (another workstream owns it).
- Never assert anything about LinkedIn not observed in a recorded fixture; where the spec says "unverified", parse defensively and keep the README wording "unverified".
- Absent scalar → `null`; absent list → `[]`.

## File map

| File | Responsibility |
|---|---|
| `src/schema/common.ts` (new) | `Image`, `Meta`, `ErrorResponse` shared by all entities |
| `src/schema/profile.ts` | imports from common, re-exports for compatibility |
| `src/schema/company.ts` (new) | `CompanyResponse`, `CompanyData` |
| `src/schema/post.ts` (new) | `Post`, `PostsResponse`, `PostsData` |
| `src/errors.ts` | `COMPANY_NOT_FOUND`, `CompanyNotFoundError` |
| `src/linkedin/url.ts` | `parseCompanyUrl`; better message in `parseProfileUrl` |
| `src/linkedin/voyager/client.ts` | generalised `RequestContext` |
| `src/linkedin/voyager/types.ts` | new `TYPES` entries |
| `src/linkedin/voyager/endpoints.ts` | company + posts paths and bundle fetchers |
| `src/linkedin/voyager/normalize.ts` | export helpers |
| `src/linkedin/voyager/normalize-company.ts` (new) | `normalizeCompany` |
| `src/linkedin/voyager/normalize-posts.ts` (new) | `normalizePosts`, `activityIdToDate` |
| `src/linkedin/service.ts` | `LinkedInService` |
| `src/routes/company.ts`, `src/routes/posts.ts` (new) | HTTP routes |
| `src/server.ts`, `src/main.ts` | wire `services` |
| `src/config.ts` | `VOYAGER_POSTS_QUERY_ID` |
| `scripts/record-fixture.ts`, `tests/helpers/fixtures.ts` | company/posts fixtures |
| README | API, approach, limitations |

---

### Task 1: Shared schema module and error code

**Files:**
- Create: `src/schema/common.ts`
- Modify: `src/schema/profile.ts`, `src/errors.ts`, `src/server.ts` (import path only)
- Test: `tests/unit/errors.test.ts` (new)

**Interfaces:**
- Produces: `Image`, `Meta`, `ErrorResponse` (zod + types) from `src/schema/common.ts`; `CompanyNotFoundError(universalName)` with code `COMPANY_NOT_FOUND`, status 404.

- [ ] **Step 1: Write the failing test** `tests/unit/errors.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CompanyNotFoundError, ProfileNotFoundError } from '../../src/errors.js';

describe('errors', () => {
  it('CompanyNotFoundError is a 404 with its own code', () => {
    const err = new CompanyNotFoundError('acme');
    expect(err.status).toBe(404);
    expect(err.code).toBe('COMPANY_NOT_FOUND');
    expect(err.message).toContain('acme');
    expect(err.details).toEqual({ universalName: 'acme' });
  });
  it('ProfileNotFoundError keeps its code', () => {
    expect(new ProfileNotFoundError('x').code).toBe('PROFILE_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/errors.test.ts` → FAIL (no export `CompanyNotFoundError`).

- [ ] **Step 3: Implement.** In `src/errors.ts` add `| 'COMPANY_NOT_FOUND'` to `ErrorCode`, `COMPANY_NOT_FOUND: 404` to `STATUS`, and:

```ts
export class CompanyNotFoundError extends AppError {
  constructor(universalName: string) {
    super(
      'COMPANY_NOT_FOUND',
      `LinkedIn reports that company "${universalName}" can't be accessed. It may not exist, or the name may be wrong.`,
      { universalName },
    );
  }
}
```

Create `src/schema/common.ts` by moving `Image`, `Meta`, `ErrorResponse` (and their `type` exports) out of `profile.ts` verbatim. In `profile.ts` replace them with `import { Image, Meta } from './common.js'; export { Image, Meta, ErrorResponse } from './common.js'; export type { Image, ErrorResponse } from './common.js';` and keep everything else. `src/server.ts` keeps importing `ErrorResponse` from `./schema/profile.js` (re-export) — no change needed unless lint complains.

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → all green.
- [ ] **Step 5:** `git add -A src tests && git commit -m "Share schema primitives, add company error"`

---

### Task 2: `parseCompanyUrl`

**Files:**
- Modify: `src/linkedin/url.ts`
- Test: `tests/unit/url.test.ts` (append)

**Interfaces:**
- Produces: `parseCompanyUrl(input: string): ParsedCompanyUrl` where `ParsedCompanyUrl = { universalName: string; kind: 'company' | 'school'; canonicalUrl: string }`.

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/url.test.ts`, importing `parseCompanyUrl`)

```ts
describe('parseCompanyUrl', () => {
  it.each([
    ['https://www.linkedin.com/company/anthropicresearch/', 'anthropicresearch', 'company'],
    ['linkedin.com/company/anthropicresearch/about/?x=1', 'anthropicresearch', 'company'],
    ['https://in.linkedin.com/school/iithyderabad/', 'iithyderabad', 'school'],
    ['https://www.linkedin.com/school/s.r.m.-institute-of-science-&-technology-chennai/', 's.r.m.-institute-of-science-&-technology-chennai', 'school'],
    ['anthropicresearch', 'anthropicresearch', 'company'],
  ])('%s → %s (%s)', (input, universalName, kind) => {
    const r = parseCompanyUrl(input);
    expect(r.universalName).toBe(universalName);
    expect(r.kind).toBe(kind);
    expect(r.canonicalUrl).toBe(`https://www.linkedin.com/${kind}/${encodeURIComponent(universalName)}/`);
  });
  it.each([
    ['', /empty/],
    ['https://www.linkedin.com/in/jane-doe/', /\/v1\/profile/],
    ['https://example.com/company/x', /not linkedin\.com/],
    ['https://www.linkedin.com/jobs/view/1', /company/],
    ['https://www.linkedin.com/company/', /company/],
  ])('rejects %s', (input, msg) => {
    expect(() => parseCompanyUrl(input)).toThrow(msg);
  });
  it('profile parser points company URLs at /v1/company', () => {
    expect(() => parseProfileUrl('https://www.linkedin.com/company/acme')).toThrow(/\/v1\/company/);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run tests/unit/url.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `src/linkedin/url.ts`:

```ts
export interface ParsedCompanyUrl {
  universalName: string;
  kind: 'company' | 'school';
  canonicalUrl: string;
}

// Universal names allow '&' and '.' (e.g. schools migrated from old vanity names).
const COMPANY_SLUG = /^[\p{L}\p{N}\-_%.&]{1,120}$/u;

export function parseCompanyUrl(input: string): ParsedCompanyUrl {
  const raw = input.trim();
  if (!raw) throw new InvalidUrlError('Company URL is empty');
  if (!raw.includes('/') && !raw.includes('.')) return fromCompanySlug(raw, 'company');
  const url = toUrl(raw, input);
  if (!LINKEDIN_HOST.test(url.hostname)) throw new InvalidUrlError(`Host "${url.hostname}" is not linkedin.com`);
  const match = /^\/(company|school)\/([^/]+)/.exec(url.pathname);
  if (!match?.[2]) {
    if (/^\/(?:mwlite\/)?in\//.test(url.pathname))
      throw new InvalidUrlError(`"${url.pathname}" is a member profile URL; use /v1/profile`);
    throw new InvalidUrlError('Expected a company URL of the form https://www.linkedin.com/company/<name> or /school/<name>');
  }
  return fromCompanySlug(match[2], match[1] as 'company' | 'school');
}
```

Extract the `new URL(...)` try/catch from `parseProfileUrl` into `function toUrl(raw: string, original: string): URL` and use it in both. `fromCompanySlug` mirrors `fromSlug` (decode, test `COMPANY_SLUG`, build `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}/`). In `parseProfileUrl`'s rejection, change the message for `company|school` to `` `"${url.pathname}" is a ${kind} URL, not a member profile; use /v1/company` `` (keep the existing wording for `pub|posts|jobs`).

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → green (`service.test.ts` expects `/company URL/` — still matches).
- [ ] **Step 5:** `git commit -am "Parse company and school URLs"`

---

### Task 3: Generalise `RequestContext`

**Files:**
- Modify: `src/linkedin/voyager/client.ts`, `src/linkedin/voyager/endpoints.ts` (`{ kind: 'profile', identifier: publicIdentifier }`), `scripts/record-fixture.ts` if it builds a context, tests using `{ publicIdentifier }`.
- Test: `tests/unit/client.test.ts` (extend)

**Interfaces:**
- Produces: `export type EntityKind = 'profile' | 'company' | 'posts'; export interface RequestContext { kind: EntityKind; identifier: string }`.

- [ ] **Step 1: Test** — in `client.test.ts` find the existing 403 "can't be accessed" → `ProfileNotFoundError` test and add beside it:

```ts
it('maps 403 to CompanyNotFoundError for company requests', () => {
  expect(() =>
    interpretVoyagerResponse(
      { status: 403, contentType: 'application/json', retryAfter: null, text: JSON.stringify({ data: { message: "This company can't be accessed" } }) },
      { kind: 'company', identifier: 'acme' },
      'u',
    ),
  ).toThrow(CompanyNotFoundError);
});
it('maps 404 to ProfileNotFoundError for posts requests', () => {
  expect(() =>
    interpretVoyagerResponse({ status: 404, contentType: 'application/json', retryAfter: null, text: '{}' }, { kind: 'posts', identifier: 'jane' }, 'u'),
  ).toThrow(ProfileNotFoundError);
});
```

- [ ] **Step 2:** run → FAIL (type error / wrong class).
- [ ] **Step 3: Implement** — replace the `ProfileNotFoundError` throw with:

```ts
throw context.kind === 'company'
  ? new CompanyNotFoundError(context.identifier)
  : new ProfileNotFoundError(context.identifier);
```

Update every `{ publicIdentifier }` context in `src/`, `scripts/`, `tests/` to the new shape.

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** `git commit -am "Generalise Voyager request context by entity"`

---

### Task 4: Company schema and normaliser

**Files:**
- Create: `src/schema/company.ts`, `src/linkedin/voyager/normalize-company.ts`, `tests/fixtures/voyager/company/minimal/company.json`, `tests/unit/normalize-company.test.ts`
- Modify: `src/linkedin/voyager/types.ts`, `src/linkedin/voyager/normalize.ts` (export `image`, `str`, `asRecord`)

**Interfaces:**
- Produces: `CompanyResponse` (zod), `CompanyData = Omit<CompanyResponse,'meta'>`, `CompanyBundle = { company: VoyagerResponse }`, `normalizeCompany(bundle: CompanyBundle): CompanyData`.
- `TYPES.legacyCompany = 'com.linkedin.voyager.organization.Company'`, `TYPES.legacyIndustry = 'com.linkedin.voyager.common.Industry'`, `TYPES.followingInfo = 'com.linkedin.voyager.common.FollowingInfo'`.

- [ ] **Step 1: Schema** `src/schema/company.ts`

```ts
import { z } from 'zod';
import { Image, Meta } from './common.js';

export const CompanyResponse = z.object({
  url: z.string().url().describe('Canonical page URL'),
  universalName: z.string(),
  urn: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['company', 'school']),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  industries: z.array(z.string()),
  companyType: z.string().nullable().describe('e.g. "Privately Held"'),
  staffCount: z.number().int().nullable().describe('Members who list this company'),
  staffCountRange: z.object({ start: z.number().int(), end: z.number().int().nullable() }).nullable(),
  followerCount: z.number().int().nullable(),
  headquarters: z
    .object({
      city: z.string().nullable(),
      region: z.string().nullable(),
      country: z.string().nullable(),
      postalCode: z.string().nullable(),
      line1: z.string().nullable(),
    })
    .nullable(),
  foundedYear: z.number().int().nullable(),
  specialities: z.array(z.string()),
  phone: z.string().nullable(),
  logo: Image.nullable(),
  backgroundImage: Image.nullable(),
  meta: Meta,
});
export type CompanyResponse = z.infer<typeof CompanyResponse>;
export type CompanyData = Omit<CompanyResponse, 'meta'>;
```

- [ ] **Step 2: Minimal fixture** `tests/fixtures/voyager/company/minimal/company.json` — hand-written, covering: root element pointing at the real company, one showcase sibling listed first in `included`, one industry resolved and one dangling, following info present, `headquarter`, `foundedOn`, `specialities`, `logo.image` with two artifacts (larger first, to prove sorting), `backgroundCoverImage: null`, `school: null`:

```json
{
  "data": { "entityUrn": "urn:li:collectionResponse:x", "paging": { "count": 10, "start": 0 }, "*elements": ["urn:li:fs_normalized_company:1"], "$type": "com.linkedin.restli.common.CollectionResponse" },
  "included": [
    { "entityUrn": "urn:li:fs_normalized_company:2", "$type": "com.linkedin.voyager.organization.Company", "name": "Acme Showcase", "universalName": "acme-showcase", "showcase": true, "url": "https://www.linkedin.com/showcase/acme-showcase/" },
    { "entityUrn": "urn:li:fs_industry:4", "$type": "com.linkedin.voyager.common.Industry", "localizedName": "Software Development" },
    { "entityUrn": "urn:li:fs_followingInfo:urn:li:company:1", "$type": "com.linkedin.voyager.common.FollowingInfo", "followerCount": 1234, "following": false },
    {
      "entityUrn": "urn:li:fs_normalized_company:1", "$type": "com.linkedin.voyager.organization.Company",
      "name": "Acme", "universalName": "acme", "url": "https://www.linkedin.com/company/acme", "companyPageUrl": "https://acme.example/",
      "tagline": "We make things", "description": "  Long description  ", "staffCount": 42,
      "staffCountRange": { "start": 11, "end": 50 }, "headquarter": { "country": "IN", "geographicArea": "Telangana", "city": "Hyderabad", "postalCode": "500001", "line1": "1 Main St" },
      "foundedOn": { "year": 2008 }, "specialities": ["AI", "Robots"], "phone": null,
      "companyType": { "localizedName": "Privately Held", "code": "PRIVATELY_HELD" }, "school": null, "showcase": false,
      "*followingInfo": "urn:li:fs_followingInfo:urn:li:company:1", "*companyIndustries": ["urn:li:fs_industry:4", "urn:li:fs_industry:999"],
      "logo": { "image": { "rootUrl": "https://media.licdn.com/dms/image/v2/X/company-logo_", "artifacts": [
        { "width": 400, "height": 400, "fileIdentifyingUrlPathSegment": "400_400/a?e=1&v=beta&t=s" },
        { "width": 100, "height": 100, "fileIdentifyingUrlPathSegment": "100_100/a?e=1&v=beta&t=s" } ] } },
      "backgroundCoverImage": null
    }
  ]
}
```

- [ ] **Step 3: Test** `tests/unit/normalize-company.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { normalizeCompany } from '../../src/linkedin/voyager/normalize-company.js';
import { CompanyResponse } from '../../src/schema/company.js';
import { loadEntityFixture } from '../helpers/fixtures.js';
import { SchemaDriftError } from '../../src/errors.js';

const company = loadEntityFixture('company', 'minimal', 'company.json');

describe('normalizeCompany', () => {
  const c = normalizeCompany({ company });
  it('picks the root company, not the showcase sibling', () => {
    expect(c.name).toBe('Acme');
    expect(c.universalName).toBe('acme');
    expect(c.urn).toBe('urn:li:fs_normalized_company:1');
    expect(c.kind).toBe('company');
    expect(c.url).toBe('https://www.linkedin.com/company/acme/');
  });
  it('resolves referenced entities and drops dangling ones', () => {
    expect(c.industries).toEqual(['Software Development']);
    expect(c.followerCount).toBe(1234);
  });
  it('maps scalars, trimming and nulling', () => {
    expect(c).toMatchObject({
      tagline: 'We make things', description: 'Long description', websiteUrl: 'https://acme.example/',
      companyType: 'Privately Held', staffCount: 42, staffCountRange: { start: 11, end: 50 },
      headquarters: { city: 'Hyderabad', region: 'Telangana', country: 'IN', postalCode: '500001', line1: '1 Main St' },
      foundedYear: 2008, specialities: ['AI', 'Robots'], phone: null, backgroundImage: null,
    });
  });
  it('sorts logo variants ascending and picks the largest', () => {
    expect(c.logo?.variants.map((v) => v.width)).toEqual([100, 400]);
    expect(c.logo?.url).toContain('400_400');
  });
  it('validates against the schema', () => {
    const meta = { source: 'voyager', fetchedAt: '2026-08-27T00:00:00.000Z', cached: false, durationMs: 0, warnings: [] };
    expect(CompanyResponse.safeParse({ ...c, meta }).success).toBe(true);
  });
  it('reports school pages as kind=school with a /school/ URL', () => {
    const school = structuredClone(company);
    const root = school.included!.find((e) => e.entityUrn === 'urn:li:fs_normalized_company:1')!;
    root.school = 'urn:li:fs_normalized_school:9';
    root.url = 'https://www.linkedin.com/school/acme/';
    const s = normalizeCompany({ company: school });
    expect(s.kind).toBe('school');
    expect(s.url).toBe('https://www.linkedin.com/school/acme/');
  });
  it('throws SchemaDriftError without a root company', () => {
    expect(() => normalizeCompany({ company: { data: {}, included: [] } })).toThrow(SchemaDriftError);
  });
});
```

Add to `tests/helpers/fixtures.ts`:

```ts
export type FixtureKind = 'profile' | 'company' | 'posts';
export function entityFixturePath(kind: FixtureKind, slug: string, file = ''): string {
  return kind === 'profile' ? fixturePath(slug, file) : join(ROOT, kind, slug, file);
}
export function loadEntityFixture(kind: FixtureKind, slug: string, file: string): VoyagerResponse {
  return JSON.parse(readFileSync(entityFixturePath(kind, slug, file), 'utf8')) as VoyagerResponse;
}
export function listEntityFixtures(kind: 'company' | 'posts'): string[] {
  const dir = join(ROOT, kind);
  return existsSync(dir) ? readdirSync(dir).filter((d) => d !== 'minimal') : [];
}
```

Note: profile fixtures stay at `tests/fixtures/voyager/<slug>/`; `normalize.recorded.test.ts` must skip the `company` and `posts` directories (`hasFixture` already requires `full.json`, so they are skipped naturally — verify).

- [ ] **Step 4:** run → FAIL.
- [ ] **Step 5: Implement** — in `types.ts` add the three `TYPES` entries. In `normalize.ts` add `export` to `image`, `str`, `asRecord` (and keep `pictureOf` private). Create `normalize-company.ts`:

```ts
import { SchemaDriftError } from '../../errors.js';
import type { CompanyData } from '../../schema/company.js';
import { EntityGraph } from './graph.js';
import { asRecord, image, str } from './normalize.js';
import { TYPES, type VectorImage, type VoyagerResponse } from './types.js';

export interface CompanyBundle {
  company: VoyagerResponse;
}

export function normalizeCompany(bundle: CompanyBundle): CompanyData {
  const graph = new EntityGraph(bundle.company);
  const company = graph.rootElements().find((e) => e.$type === TYPES.legacyCompany);
  if (!company) {
    throw new SchemaDriftError('Voyager response did not contain a root Company entity', {
      rootElements: graph.rootElements().map((e) => e.$type), entityCount: graph.size,
    });
  }
  const universalName = str(company.universalName);
  const name = str(company.name);
  if (!universalName || !name) throw new SchemaDriftError('Company entity has no universalName/name');
  const kind = company.school ? 'school' : 'company';
  const hq = asRecord(company.headquarter);
  const range = asRecord(company.staffCountRange);
  return {
    url: `https://www.linkedin.com/${kind}/${encodeURIComponent(universalName)}/`,
    universalName,
    urn: str(company.entityUrn),
    name,
    kind,
    tagline: str(company.tagline),
    description: str(company.description),
    websiteUrl: str(company.companyPageUrl),
    industries: graph.refs(company, 'companyIndustries').map((i) => str(i.localizedName)).filter((s): s is string => s !== null),
    companyType: str(asRecord(company.companyType)?.localizedName),
    staffCount: num(company.staffCount),
    staffCountRange: range && typeof range.start === 'number' ? { start: range.start, end: num(range.end) } : null,
    followerCount: num(graph.ref(company, 'followingInfo')?.followerCount),
    headquarters: hq ? { city: str(hq.city), region: str(hq.geographicArea), country: str(hq.country), postalCode: str(hq.postalCode), line1: str(hq.line1) } : null,
    foundedYear: num(asRecord(company.foundedOn)?.year),
    specialities: Array.isArray(company.specialities) ? company.specialities.map(str).filter((s): s is string => s !== null) : [],
    phone: str(company.phone),
    logo: image(asRecord(company.logo)?.image as VectorImage | undefined),
    backgroundImage: image(asRecord(company.backgroundCoverImage)?.image as VectorImage | undefined),
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
```

- [ ] **Step 6:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 7:** `git add -A && git commit -m "Normalise company pages into schema"`

---

### Task 5: Posts schema and normaliser

**Files:**
- Create: `src/schema/post.ts`, `src/linkedin/voyager/normalize-posts.ts`, `tests/fixtures/voyager/posts/minimal/{topcard,posts}.json`, `tests/unit/normalize-posts.test.ts`
- Modify: `src/linkedin/voyager/types.ts`

**Interfaces:**
- Produces: `Post`, `PostsResponse`, `PostsData`; `PostsBundle = { topCard: VoyagerResponse; posts: VoyagerResponse }`; `normalizePosts(bundle, publicIdentifier): PostsData`; `activityIdToDate(id: string): Date`.
- `TYPES.update = 'com.linkedin.voyager.dash.feed.Update'`, `TYPES.socialDetail = 'com.linkedin.voyager.dash.social.SocialDetail'`, `TYPES.socialActivityCounts = 'com.linkedin.voyager.dash.feed.SocialActivityCounts'`.

- [ ] **Step 1: Schema** `src/schema/post.ts`

```ts
import { z } from 'zod';
import { Image, Meta } from './common.js';

const Author = z.object({ name: z.string(), headline: z.string().nullable(), linkedinUrl: z.string().url().nullable() });
const Stats = z.object({
  likes: z.number().int(), comments: z.number().int(), shares: z.number().int(),
  reactions: z.record(z.string(), z.number().int()).describe('reactionType → count, e.g. LIKE, PRAISE, EMPATHY'),
});
const PostBase = z.object({
  urn: z.string().describe('urn:li:activity:<id>'),
  url: z.string().url().nullable(),
  createdAt: z.string().datetime().describe('Derived from the activity id (Snowflake-style timestamp)'),
  text: z.string().nullable(),
  author: Author,
  isReshare: z.boolean(),
  images: z.array(Image),
  article: z.object({ url: z.string().nullable(), title: z.string().nullable() }).nullable(),
  video: z.boolean(),
  stats: Stats.nullable(),
});
export const Post = PostBase.extend({ reshared: PostBase.nullable() });
export const PostsResponse = z.object({
  url: z.string().url().describe('The member activity URL'),
  publicIdentifier: z.string(),
  count: z.number().int().describe('Requested count'),
  posts: z.array(Post).describe('Newest first, as LinkedIn orders them'),
  meta: Meta,
});
export type Post = z.infer<typeof Post>;
export type PostsResponse = z.infer<typeof PostsResponse>;
export type PostsData = Omit<PostsResponse, 'meta'>;
```

- [ ] **Step 2: Fixtures.** `posts/minimal/topcard.json`: copy `tests/fixtures/voyager/minimal/topcard.json` (it has the profile URN). `posts/minimal/posts.json`: hand-written with three updates in `data.data.feedDashProfileUpdatesByMemberShareFeed['*elements']` order:
  1. Own post with `commentary`, `imageComponent` with one image (two artifacts), `*socialDetail` → SocialDetail → `*totalSocialActivityCounts` → counts `{numLikes: 5, numComments: 1, numShares: 0, reactionTypeCounts: [{count:4, reactionType:'LIKE'},{count:1, reactionType:'PRAISE'}]}`, `socialContent.shareUrl` with `?utm_…` noise, `actor.navigationContext.actionTarget` `https://www.linkedin.com/in/jane-doe?miniProfileUrn=…`.
  2. Plain repost: actor is "Other Person", `header.text.text = "Jane Doe reposted this"`, `resharedUpdate: null`, no `*socialDetail`, `content` all null.
  3. Reshare with thoughts: `commentary` "My take", `resharedUpdate` is a nested update object (same shape as 1, different activity id, `articleComponent: { navigationContext: { actionTarget: 'https://example.com/a' }, title: { text: 'An article' } }`), no counts.
  Use activity ids `7390255662376824832`, `7193517581419380736`, `7358006675577978882`. Every update must carry `metadata.backendUrn` and `$type: com.linkedin.voyager.dash.feed.Update`. Mirror the real key shape from the spec (`commentary.text.text`, `actor.name.text`, `actor.description.text`, `content.imageComponent.images[].attributes[0].detailData.vectorImage`).

- [ ] **Step 3: Test** `tests/unit/normalize-posts.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { activityIdToDate, normalizePosts } from '../../src/linkedin/voyager/normalize-posts.js';
import { PostsResponse } from '../../src/schema/post.js';
import { loadEntityFixture } from '../helpers/fixtures.js';

const bundle = { topCard: loadEntityFixture('posts', 'minimal', 'topcard.json'), posts: loadEntityFixture('posts', 'minimal', 'posts.json') };

describe('activityIdToDate', () => {
  it('extracts the Unix-ms timestamp from the activity id', () => {
    expect(activityIdToDate('7390255662376824832').toISOString()).toBe('2025-11-01T11:38:07.395Z');
  });
});

describe('normalizePosts', () => {
  const r = normalizePosts(bundle, 'jane-doe');
  it('keeps LinkedIn order and derives identity from the slug', () => {
    expect(r.publicIdentifier).toBe('jane-doe');
    expect(r.url).toBe('https://www.linkedin.com/in/jane-doe/recent-activity/all/');
    expect(r.posts.map((p) => p.urn)).toEqual(['urn:li:activity:7390255662376824832', 'urn:li:activity:7193517581419380736', 'urn:li:activity:7358006675577978882']);
  });
  it('maps an own post with image and stats', () => {
    const p = r.posts[0]!;
    expect(p.author).toEqual({ name: 'Jane Doe', headline: 'Engineer', linkedinUrl: 'https://www.linkedin.com/in/jane-doe' });
    expect(p.url).toBe('https://www.linkedin.com/posts/activity-7390255662376824832-abcd');
    expect(p.isReshare).toBe(false);
    expect(p.images).toHaveLength(1);
    expect(p.images[0]!.variants.map((v) => v.width)).toEqual([800, 1179]);
    expect(p.stats).toEqual({ likes: 5, comments: 1, shares: 0, reactions: { LIKE: 4, PRAISE: 1 } });
    expect(p.createdAt).toBe('2025-11-01T11:38:07.395Z');
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
    const meta = { source: 'voyager', fetchedAt: '2026-08-27T00:00:00.000Z', cached: false, durationMs: 0, warnings: [] };
    const result = PostsResponse.safeParse({ ...r, meta });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
  it('returns an empty list when the feed has no elements', () => {
    const empty = { ...bundle, posts: { data: { data: { feedDashProfileUpdatesByMemberShareFeed: { '*elements': [] } } }, included: [] } };
    expect(normalizePosts(empty, 'jane-doe').posts).toEqual([]);
  });
});
```

(Compute the expected ISO string with `new Date(Number(7390255662376824832n >> 22n)).toISOString()` in Node and paste the real value into both places; the value above must be replaced by the computed one.)

- [ ] **Step 4:** run → FAIL.
- [ ] **Step 5: Implement** `normalize-posts.ts`:

```ts
import type { Post, PostsData } from '../../schema/post.js';
import type { Image } from '../../schema/common.js';
import { EntityGraph } from './graph.js';
import { asRecord, image, str } from './normalize.js';
import { TYPES, type VectorImage, type VoyagerEntity, type VoyagerResponse } from './types.js';

export interface PostsBundle {
  topCard: VoyagerResponse;
  posts: VoyagerResponse;
}

/** LinkedIn activity ids are Snowflake-style: the top bits are Unix milliseconds. */
export function activityIdToDate(id: string): Date {
  return new Date(Number(BigInt(id) >> 22n));
}

export function normalizePosts(bundle: PostsBundle, publicIdentifier: string): PostsData {
  const graph = new EntityGraph(bundle.posts, bundle.topCard);
  const feed = asRecord(asRecord(bundle.posts.data)?.data)?.feedDashProfileUpdatesByMemberShareFeed;
  const updates = graph.refs(asRecord(feed), 'elements').filter((u) => u.$type === TYPES.update);
  return {
    url: `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier)}/recent-activity/all/`,
    publicIdentifier,
    count: updates.length,
    posts: updates.map((u) => post(graph, u)).filter((p): p is Post => p !== null),
  };
}

function post(graph: EntityGraph, u: VoyagerEntity): Post | null {
  const base = postBase(graph, u);
  if (!base) return null;
  const nested = asRecord(u.resharedUpdate);
  const reshared = nested ? postBase(graph, nested) : null;
  const header = str(asRecord(asRecord(u.header)?.text)?.text);
  return { ...base, isReshare: reshared !== null || /reposted/i.test(header ?? ''), reshared };
}

function postBase(graph: EntityGraph, u: VoyagerEntity): Omit<Post, 'reshared'> | null {
  const urn = str(asRecord(u.metadata)?.backendUrn);
  const id = urn?.match(/^urn:li:activity:(\d+)$/)?.[1];
  if (!urn || !id) return null;
  const actor = asRecord(u.actor);
  const content = asRecord(u.content);
  const article = asRecord(content?.articleComponent);
  const counts = graph.ref(graph.ref(u, 'socialDetail'), 'totalSocialActivityCounts');
  const shareUrl = str(asRecord(u.socialContent)?.shareUrl);
  return {
    urn,
    url: shareUrl ? stripQuery(shareUrl) : null,
    createdAt: activityIdToDate(id).toISOString(),
    text: str(asRecord(asRecord(u.commentary)?.text)?.text),
    author: {
      name: str(asRecord(actor?.name)?.text) ?? '',
      headline: str(asRecord(actor?.description)?.text),
      linkedinUrl: stripQuery(str(asRecord(actor?.navigationContext)?.actionTarget)),
    },
    isReshare: false,
    images: images(content),
    article: article ? { url: stripQuery(str(asRecord(article.navigationContext)?.actionTarget)), title: str(asRecord(article.title)?.text) } : null,
    video: asRecord(content?.linkedInVideoComponent) !== undefined,
    stats: counts ? stats(counts) : null,
  };
}

function images(content: VoyagerEntity | undefined): Image[] {
  const list = asRecord(content?.imageComponent)?.images;
  if (!Array.isArray(list)) return [];
  return list
    .map((img) => {
      const attr = Array.isArray(asRecord(img)?.attributes) ? asRecord((asRecord(img)!.attributes as unknown[])[0]) : undefined;
      return image(asRecord(attr?.detailData)?.vectorImage as VectorImage | undefined);
    })
    .filter((i): i is Image => i !== null);
}

function stats(c: VoyagerEntity): Post['stats'] {
  const reactions: Record<string, number> = {};
  for (const r of Array.isArray(c.reactionTypeCounts) ? c.reactionTypeCounts : []) {
    const rec = asRecord(r);
    const type = str(rec?.reactionType);
    if (type && typeof rec?.count === 'number') reactions[type] = rec.count;
  }
  return { likes: n(c.numLikes), comments: n(c.numComments), shares: n(c.numShares), reactions };
}

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

function stripQuery(url: string | null): string | null {
  if (!url) return null;
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}
```

Note `stripQuery` on `null` returns `null`; the author `linkedinUrl` must be a valid URL or null (zod `url()`), so if the stripped value does not start with `https://`, return null.

- [ ] **Step 6:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 7:** `git add -A && git commit -m "Normalise member posts into schema"`

---

### Task 6: Endpoints — `fetchCompanyBundle`, `fetchPostsBundle`, config

**Files:**
- Modify: `src/linkedin/voyager/endpoints.ts`, `src/config.ts`, `tests/unit/endpoints.test.ts`, `tests/unit/config.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `DECORATION.company = 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12'`
  - `export const DEFAULT_POSTS_QUERY_ID = '20c70fe0314184158516a7ec004c0408'`
  - `companyPath(universalName: string): string`
  - `postsPath(profileUrn: string, count: number, queryId: string): string` → `/graphql?includeWebMetadata=true&variables=(count:${count},start:0,profileUrn:${encodeURIComponent(profileUrn)})&queryId=voyagerFeedDashProfileUpdates.${queryId}`
  - `fetchCompanyBundle(client, universalName): Promise<{ bundle: CompanyBundle; warnings: string[] }>`
  - `fetchPostsBundle(client, publicIdentifier, count, queryId): Promise<{ bundle: PostsBundle; warnings: string[] }>`
  - `Config.VOYAGER_POSTS_QUERY_ID: string` (default `DEFAULT_POSTS_QUERY_ID`)

- [ ] **Step 1: Tests** (append to `endpoints.test.ts`, reuse its fake-transport helper):

```ts
describe('fetchCompanyBundle', () => {
  it('requests the company decoration with the universal name', async () => {
    const { client, calls } = fake(async () => company);
    const { bundle, warnings } = await fetchCompanyBundle(client, 'acme');
    expect(calls[0]).toContain('/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=acme');
    expect(bundle.company).toBe(company);
    expect(warnings).toEqual([]);
  });
  it('passes the company context so 404s map to COMPANY_NOT_FOUND', async () => {
    const { client, contexts } = fake(async () => company);
    await fetchCompanyBundle(client, 'acme');
    expect(contexts[0]).toEqual({ kind: 'company', identifier: 'acme' });
  });
});

describe('fetchPostsBundle', () => {
  it('fetches the top card for the URN, then the GraphQL feed', async () => {
    const { client, calls } = fake(async (p) => (p.includes('WebTopCardCore') ? topCard : posts));
    const { bundle } = await fetchPostsBundle(client, 'jane-doe', 7, 'abc123');
    expect(calls[0]).toContain('WebTopCardCore');
    expect(calls[1]).toBe('/graphql?includeWebMetadata=true&variables=(count:7,start:0,profileUrn:urn%3Ali%3Afsd_profile%3AACoAAtest)&queryId=voyagerFeedDashProfileUpdates.abc123');
    expect(bundle.topCard).toBe(topCard);
    expect(bundle.posts).toBe(posts);
  });
  it('maps a rejected queryId to SCHEMA_DRIFT naming the env var', async () => {
    const { client } = fake(async (p) => { if (p.includes('graphql')) throw new SchemaDriftError('LinkedIn rejected the request: bad request'); return topCard; });
    await expect(fetchPostsBundle(client, 'jane-doe', 10, 'stale')).rejects.toThrow(/VOYAGER_POSTS_QUERY_ID/);
  });
  it('throws SCHEMA_DRIFT when the top card has no profile URN', async () => {
    const { client } = fake(async () => ({ data: {}, included: [] }));
    await expect(fetchPostsBundle(client, 'jane-doe', 10, 'x')).rejects.toBeInstanceOf(SchemaDriftError);
  });
});
```

`fake()` must record `calls: string[]` and `contexts: RequestContext[]`; extend the existing helper. The `minimal` posts topcard fixture's profile URN must be `urn:li:fsd_profile:ACoAAtest` — set it when writing that fixture in Task 5 (or adjust the expectation to the real value in `tests/fixtures/voyager/minimal/topcard.json`).

Config test:

```ts
it('defaults the posts query id and accepts an override', () => {
  expect(loadConfig({ LI_AT: 'x' }).VOYAGER_POSTS_QUERY_ID).toBe(DEFAULT_POSTS_QUERY_ID);
  expect(loadConfig({ LI_AT: 'x', VOYAGER_POSTS_QUERY_ID: 'abc' }).VOYAGER_POSTS_QUERY_ID).toBe('abc');
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** In `endpoints.ts`:

```ts
export function companyPath(universalName: string): string {
  return `/organization/companies?decorationId=${DECORATION.company}&q=universalName&universalName=${encodeURIComponent(universalName)}`;
}

export async function fetchCompanyBundle(client: VoyagerTransport, universalName: string): Promise<{ bundle: CompanyBundle; warnings: string[] }> {
  const company = await client.get(companyPath(universalName), { kind: 'company', identifier: universalName });
  return { bundle: { company }, warnings: [] };
}

export async function fetchPostsBundle(client: VoyagerTransport, publicIdentifier: string, count: number, queryId: string): Promise<{ bundle: PostsBundle; warnings: string[] }> {
  const context = { kind: 'posts', identifier: publicIdentifier } as const;
  const topCard = await client.get(profilePath(publicIdentifier, DECORATION.topCard), context);
  const profile = new EntityGraph(topCard).rootElements().find((e) => e.$type === TYPES.profile);
  const profileUrn = typeof profile?.entityUrn === 'string' ? profile.entityUrn : undefined;
  if (!profileUrn) throw new SchemaDriftError('Top card response did not contain a profile URN');
  let posts: VoyagerResponse;
  try {
    posts = await client.get(postsPath(profileUrn, count, queryId), context);
  } catch (err) {
    if (err instanceof SchemaDriftError) {
      throw new SchemaDriftError(
        `LinkedIn rejected the posts query. The GraphQL queryId "${queryId}" is probably stale; capture the current voyagerFeedDashProfileUpdates hash and set VOYAGER_POSTS_QUERY_ID.`,
        { ...err.details, queryId },
      );
    }
    throw err;
  }
  return { bundle: { topCard, posts }, warnings: [] };
}
```

Also: a GraphQL 404 for a stale hash arrives as `ProfileNotFoundError` from `interpretVoyagerResponse`; in `fetchPostsBundle` distinguish it — since the top card already succeeded, a 404 on the GraphQL call means the query, not the profile, is unknown, so rethrow it as the same `SchemaDriftError`. Handle `err instanceof ProfileNotFoundError` in the same catch.

In `config.ts` add `VOYAGER_POSTS_QUERY_ID: z.string().min(8).default(DEFAULT_POSTS_QUERY_ID)` importing the constant from `endpoints.ts` (check for import cycles: `endpoints.ts` must not import `config.ts`).

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** `git add -A && git commit -m "Fetch company and posts bundles from Voyager"`

---

### Task 7: `LinkedInService`

**Files:**
- Modify: `src/linkedin/service.ts` (rename class), `src/main.ts`, `src/server.ts`, `tests/unit/service.test.ts`, `tests/integration/routes.test.ts` (type only), `tests/live/profile.live.test.ts`, `scripts/record-fixture.ts` if it imports the class.

**Interfaces:**
- Produces:

```ts
export interface LinkedInServiceDeps {
  voyager: VoyagerTransport;
  cache: TtlCache<unknown>;
  semaphore: Semaphore;
  postsQueryId: string;
  log?: LogFn;
  now?: () => Date;
}
export class LinkedInService {
  getProfile(inputUrl: string): Promise<ProfileResponse>;
  getCompany(inputUrl: string): Promise<CompanyResponse>;
  getPosts(inputUrl: string, count?: number): Promise<PostsResponse>; // count clamped to [1, 50], default 10
}
export const POSTS_DEFAULT_COUNT = 10; export const POSTS_MAX_COUNT = 50;
```
- `BuildAppOptions.service` → `services: LinkedInService`.

- [ ] **Step 1: Tests** — rename in `service.test.ts` and add:

```ts
describe('LinkedInService.getCompany', () => {
  it('returns a company with meta and caches by name', async () => {
    const { voyager, get } = transport(async () => companyFixture);
    const s = build(voyager);
    const first = await s.getCompany('https://www.linkedin.com/company/acme/');
    expect(first.name).toBe('Acme');
    expect(first.meta.cached).toBe(false);
    expect((await s.getCompany('acme')).meta.cached).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('does not collide with the profile cache', async () => {
    const { voyager } = transport(async (p) => (p.includes('organization') ? companyFixture : good(p)));
    const s = build(voyager);
    await s.getProfile('acme');
    const c = await s.getCompany('acme');
    expect(c.meta.cached).toBe(false);
  });
});
describe('LinkedInService.getPosts', () => {
  it('fetches, clamps count and caches per count', async () => {
    const { voyager, get } = transport(async (p) => (p.includes('graphql') ? postsFixture : topCard));
    const s = build(voyager);
    const r = await s.getPosts('jane-doe', 500);
    expect(get.mock.calls[1]![0]).toContain('count:50');
    expect(r.count).toBeGreaterThan(0);
    expect((await s.getPosts('jane-doe', 500)).meta.cached).toBe(true);
    expect((await s.getPosts('jane-doe', 5)).meta.cached).toBe(false);
  });
  it('uses the configured query id', async () => {
    const { voyager, get } = transport(async (p) => (p.includes('graphql') ? postsFixture : topCard));
    await build(voyager).getPosts('jane-doe');
    expect(get.mock.calls[1]![0]).toContain('voyagerFeedDashProfileUpdates.test-id');
  });
});
```

`build()` passes `postsQueryId: 'test-id'` and `cache: new TtlCache<unknown>(ttl)`. Fixtures: `companyFixture = loadEntityFixture('company','minimal','company.json')`, `postsFixture = loadEntityFixture('posts','minimal','posts.json')`.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** — restructure `service.ts` around a private generic:

```ts
private async cached<T extends { meta: Meta }>(key: string, schema: z.ZodType<T>, fetch: () => Promise<{ data: Omit<T, 'meta'>; warnings: string[] }>): Promise<T>
```
that does what `getProfile` does today (cache lookup, semaphore, meta, `safeParse` warning, cache set) with `key` = `profile:<id>`, `company:<name>`, `posts:<id>:<count>`. `getPosts` computes `const n = Math.min(POSTS_MAX_COUNT, Math.max(1, Math.trunc(count ?? POSTS_DEFAULT_COUNT)))` and passes `{ ...normalizePosts(bundle, publicIdentifier), count: n }`. Update `main.ts` (`new LinkedInService({ …, postsQueryId: config.VOYAGER_POSTS_QUERY_ID })`, `buildApp({ services, … })`), `server.ts` (`services` field passed to `profileRoutes`), and the live/integration tests' type names.

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** `git add -A && git commit -m "Generalise service to company and posts"`

---

### Task 8: Routes, OpenAPI, integration tests

**Files:**
- Create: `src/routes/company.ts`, `src/routes/posts.ts`
- Modify: `src/server.ts` (register, tags `company`, `posts`), `tests/integration/routes.test.ts`

- [ ] **Step 1: Tests** (append to `routes.test.ts`; the stub becomes `{ getProfile, getCompany, getPosts } as unknown as LinkedInService`):

```ts
it('GET /v1/company returns the company', async () => {
  getCompany.mockResolvedValueOnce(company);
  const res = await app.inject({ url: '/v1/company', query: { url: 'https://www.linkedin.com/company/acme/' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(company);
});
it('POST /v1/company accepts a JSON body', async () => { /* same shape as profile POST test */ });
it('maps CompanyNotFoundError to 404 COMPANY_NOT_FOUND', async () => {
  getCompany.mockRejectedValueOnce(new CompanyNotFoundError('acme'));
  const res = await app.inject({ url: '/v1/company', query: { url: 'acme' } });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: { code: 'COMPANY_NOT_FOUND' } });
});
it('GET /v1/posts passes count through', async () => {
  getPosts.mockResolvedValueOnce(posts);
  const res = await app.inject({ url: '/v1/posts', query: { url: 'jane-doe', count: '5' } });
  expect(res.statusCode).toBe(200);
  expect(getPosts).toHaveBeenCalledWith('jane-doe', 5);
});
it('GET /v1/posts defaults count to 10', async () => { /* expect getPosts called with ('jane-doe', 10) */ });
it.each(['0', '51', 'abc', '2.5'])('rejects count=%s with 400', async (count) => {
  const res = await app.inject({ url: '/v1/posts', query: { url: 'jane-doe', count } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
});
it('POST /v1/posts accepts {url, count}', async () => { /* payload { url: 'jane-doe', count: 3 } → getPosts('jane-doe', 3) */ });
it('OpenAPI lists every route', async () => {
  const doc = (await app.inject({ url: '/openapi.json' })).json<{ paths: Record<string, unknown> }>();
  expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/profile', '/v1/company', '/v1/posts', '/health']));
});
```

Build `company`/`posts` response objects from the minimal fixtures plus the same `meta` used for `profile`.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `src/routes/company.ts` (mirror `profile.ts`: `UrlInput` described as "LinkedIn company or school URL, e.g. https://www.linkedin.com/company/anthropicresearch/", tags `['company']`, 404 description "LinkedIn reports the company can't be accessed") and `src/routes/posts.ts`:

```ts
const CountInput = z.coerce.number().int().min(1).max(POSTS_MAX_COUNT).default(POSTS_DEFAULT_COUNT)
  .describe('How many of the newest posts to return (1–50)');
app.get('/v1/posts', { schema: { tags: ['posts'], summary: "Fetch a member's newest posts", querystring: z.object({ url: UrlInput, count: CountInput }), response: { 200: PostsResponse, ...errorResponses } } }, async (req) => services.getPosts(req.query.url, req.query.count));
app.post('/v1/posts', { schema: { tags: ['posts'], summary: "Fetch a member's newest posts (JSON body)", body: z.object({ url: UrlInput, count: CountInput }), response: { 200: PostsResponse, ...errorResponses } } }, async (req) => services.getPosts(req.body.url, req.body.count));
```

Register both in `server.ts` after `profileRoutes`; add `{ name: 'company' }, { name: 'posts' }` to swagger tags. Update the swagger `info.description` to mention companies and posts.

- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** `git add -A && git commit -m "Expose company and posts routes"`

---

### Task 9: Fixture recorder, recorded-fixture test, live tests

**Files:**
- Modify: `scripts/record-fixture.ts`, `tests/unit/normalize.recorded.test.ts`
- Create: `tests/live/company.live.test.ts`, `tests/live/posts.live.test.ts`, recorded fixtures `tests/fixtures/voyager/company/anthropicresearch/company.json`, `tests/fixtures/voyager/company/iithyderabad/company.json`, `tests/fixtures/voyager/posts/sharmanityam/{topcard,posts}.json`

- [ ] **Step 1: Recorder.** Parse `process.argv`: `[slug]` → profile (unchanged), `['company', name]`, `['posts', slug]`. Company writes `tests/fixtures/voyager/company/<name>/company.json`; posts writes `tests/fixtures/voyager/posts/<slug>/topcard.json` and `posts.json` (count 10, `loadConfig().VOYAGER_POSTS_QUERY_ID`). Same `strip()`. Print a one-line summary per kind (`name · industries · followers` / `N posts, M reshares`). Update the usage string.
- [ ] **Step 2: Record** (needs `.env` with `LI_AT`): `pnpm record-fixture company anthropicresearch && pnpm record-fixture company iithyderabad && pnpm record-fixture posts sharmanityam`. Inspect the files: no `$anti_abuse_metadata`, `trackingId`, `multiLocale*`; no cookie values.
- [ ] **Step 3: Recorded test** — extend `normalize.recorded.test.ts` with two more `describe.each` blocks using `listEntityFixtures('company')` / `('posts')`: schema parse succeeds; company `universalName === slug`, `name` truthy, `logo.url` starts with `https://media.licdn.com/`; posts `posts.length > 0`, every post has `urn`, `createdAt` parseable, `author.name`, and at least one post with `stats !== null`; no image URL in either matches `^https://www\.linkedin\.com/dms/prv/`.
- [ ] **Step 4: Live tests** (`describe.skipIf(!liAt)`), mirroring `profile.live.test.ts` with `LinkedInService`: company `anthropicresearch` → `name === 'Anthropic'`, `kind === 'company'`, `industries.length > 0`, `followerCount > 0`; school `iithyderabad` → `kind === 'school'`; unknown name `this-company-does-not-exist-xyz` → `CompanyNotFoundError`; posts `sharmanityam` count 5 → `posts.length` between 1 and 5, one `isReshare === true` (the profile has a repost), `stats` on an own post.
- [ ] **Step 5:** `pnpm test && pnpm typecheck && pnpm lint`, then `pnpm test:live` (report output honestly).
- [ ] **Step 6:** `git add -A && git commit -m "Record company and posts fixtures, live tests"`

---

### Task 10: README and `.env.example`

**Files:** `README.md`, `.env.example`

- [ ] **Step 1:** README changes: intro sentence mentions companies and posts; Contents; **API** section gains `GET|POST /v1/company` and `GET|POST /v1/posts` with a trimmed real example each (from the recorded fixtures), the `count` rule, "newest only, no pagination", the "no home feed by design" note; error table adds `COMPANY_NOT_FOUND`; **Approach** gains "Company pages" and "Member posts" subsections written from the spec's "What was observed live" (REST decoration vs the web app's GraphQL, legacy entity types, counts reached via `SocialDetail`, repost `header`), plus a "Re-capturing the posts queryId" how-to (DevTools → Network → filter `graphql?queryId=voyagerFeedDashProfileUpdates` on `/in/<slug>/recent-activity/all/` → set `VOYAGER_POSTS_QUERY_ID`); **Configuration** table adds `VOYAGER_POSTS_QUERY_ID`; **Architecture** diagram lists the new normalisers; **Testing** mentions `pnpm record-fixture company|posts`; **Known limitations** adds: queryId rotation (weekly-ish), posts limited to 50 newest, `resharedUpdate`/article/video shapes **unverified** (not in recorded sample), school resolution verified for one school only.
- [ ] **Step 2:** `.env.example` gains a commented `VOYAGER_POSTS_QUERY_ID=` line.
- [ ] **Step 3:** `git add -A && git commit -m "Document company and posts endpoints"`
