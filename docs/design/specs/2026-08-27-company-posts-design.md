# Design: `/v1/company` and `/v1/posts`

Date: 2026-08-27. Status: approved .

## Goal

Two new entities alongside `/v1/profile`, same envelope, same offline test-ability:

- `GET|POST /v1/company` – a LinkedIn company **or school** page, from `linkedin.com/company/<universalName>`, `linkedin.com/school/<name>` or a bare name.
- `GET|POST /v1/posts` – the newest posts **authored or reposted by a member** (`linkedin.com/in/<slug>/recent-activity/all/`), `count` 1–50, default 10, no pagination in v1. The operator's home feed (`linkedin.com/feed/`) is deliberately not exposed.

## What was observed live (2026-08-27, real `LI_AT`)

### Company
- `GET /voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=<name>` returns 200 normalized+json for `anthropicresearch` (company) and `iithyderabad` (school). An unknown name returns the same 403/404 the profile endpoint does.
- `data['*elements'] = ['urn:li:fs_normalized_company:<id>']`; `included[]` holds the target `Company` **plus its showcase pages** (also `Company`, `showcase: true`), so the root element must be used, never `ofType()[0]`.
- Entity types are the *legacy* (non-dash) family: `com.linkedin.voyager.organization.Company`, `com.linkedin.voyager.common.Industry` (`localizedName`), `com.linkedin.voyager.common.FollowingInfo` (`followerCount`), referenced from the company via `*companyIndustries` (list) and `*followingInfo`.
- Fields present: `name, universalName, url, companyPageUrl, description, tagline, staffCount, staffCountRange{start,end}, headquarter{country,geographicArea,city,postalCode,line1} | null, foundedOn{year} | null, specialities[], phone | null, companyType{localizedName,code} | null, school (URN or null), showcase (bool)`, `logo.image` and `backgroundCoverImage.image` are vector images (`rootUrl + artifacts[]`, i.e. **not** wrapped in `vectorImage`).
- The LinkedIn web app itself fetches the page via GraphQL `voyagerOrganizationDashCompanies.148b1aebfadd0a455f32806df656c3c1` with `variables=(universalName:<name>)`; the REST decoration is what this project uses because its ID has been stable for years. Not implemented: the GraphQL path.

### Posts
- Loading `/in/<slug>/recent-activity/all/` the web app calls `GET /voyager/api/graphql?includeWebMetadata=true&variables=(count:20,start:0,profileUrn:urn%3Ali%3Afsd_profile%3A<id>)&queryId=voyagerFeedDashProfileUpdates.20c70fe0314184158516a7ec004c0408`. The older hash `4af00b28d60ed0f1488018948daad822` also still works. Hashes rotate; `VOYAGER_POSTS_QUERY_ID` defaults to `20c70fe0314184158516a7ec004c0408`.
- Response: `data.data.feedDashProfileUpdatesByMemberShareFeed['*elements']` lists `urn:li:fsd_update:(urn:li:activity:<id>,MEMBER_SHARES,…)`. `paging.total` is `0` (unreliable); `metadata.paginationToken` exists (unused in v1).
- `Update` (`com.linkedin.voyager.dash.feed.Update`): `metadata.backendUrn = urn:li:activity:<id>`, `commentary.text.text`, `actor.name.text`, `actor.description.text` (headline), `actor.navigationContext.actionTarget` (profile URL with query noise), `content.<component>` where every component key is present and all but one are `null` (`imageComponent`, `celebrationComponent`, `articleComponent`, `linkedInVideoComponent`, …), `socialContent.shareUrl`, `*socialDetail`, `header.text.text`, `resharedUpdate`.
- Counts: `Update.*socialDetail → SocialDetail.*totalSocialActivityCounts → SocialActivityCounts{numLikes,numComments,numShares,reactionTypeCounts[{count,reactionType}]}`. The counts URN is keyed by `ugcPost`, not `activity`, so the graph must be followed, not string-matched.
- Reposts: a plain repost appears as the **original** post (actor = original author) with `header.text.text = "<member> reposted this"` and `resharedUpdate: null`. `resharedUpdate` (nested `Update`) is expected for "repost with your thoughts"; not present in the recorded sample, so the nested shape is treated as best-effort and labelled unverified in README.
- `content.imageComponent.images[].attributes[0].detailData.vectorImage` is a standard vector image (`rootUrl + artifacts`). `articleComponent` and `linkedInVideoComponent` were not present in the recorded sample; their parsing is defensive (`articleComponent.navigationContext.actionTarget`, `.title.text`) and labelled unverified.
- Timestamp: `activityId >> 22` is Unix ms (checked: `7390255662376824832 → 2025-11-…`, matches the "9mo" label on the page).

## HTTP surface

| Route | Input | Output |
|---|---|---|
| `GET /v1/company?url=` / `POST /v1/company {url}` | company/school URL or bare universal name | `CompanyResponse` |
| `GET /v1/posts?url=&count=` / `POST /v1/posts {url, count?}` | any profile URL `parseProfileUrl` accepts; `count` int 1–50 default 10 | `PostsResponse` |

Errors: same envelope. New `COMPANY_NOT_FOUND` (404). Posts on a missing profile → `PROFILE_NOT_FOUND`. Stale posts hash → `SCHEMA_DRIFT` whose message names `VOYAGER_POSTS_QUERY_ID`. `/v1/profile` given a company URL → `INVALID_URL` "…use /v1/company"; `/v1/company` given `/in/` → `INVALID_URL` "…use /v1/profile".

## Schemas (`src/schema/`)

`common.ts`: `Image`, `Meta`, `ErrorResponse` (moved out of `profile.ts`, which re-exports them).

`company.ts` – `CompanyResponse`:
```
url, universalName, urn, name, kind: 'company'|'school', tagline, description,
websiteUrl, industries: string[], companyType, staffCount, staffCountRange: {start,end}|null,
followerCount, headquarters: {city, region, country, postalCode, line1}|null, foundedYear,
specialities: string[], phone, logo: Image|null, backgroundImage: Image|null, meta
```
`post.ts` – `Post` and `PostsResponse { url, publicIdentifier, count, posts: Post[], meta }`:
```
Post { urn, url, createdAt (ISO), text, author: {name, headline, linkedinUrl}, isReshare,
       reshared: Post|null (one level, no nested reshared), images: Image[],
       article: {url, title}|null, video: boolean,
       stats: {likes, comments, shares, reactions: Record<string,number>}|null }
```
`null` for absent scalars, `[]` for absent lists, as in `profile.ts`.

## Code layout

- `src/linkedin/url.ts`: `parseCompanyUrl(input) → { universalName, kind, canonicalUrl }`.
- `src/linkedin/voyager/client.ts`: `RequestContext = { kind: 'profile'|'company'|'posts'; identifier }`; not-found mapping by `kind`.
- `src/linkedin/voyager/endpoints.ts`: `DECORATION.company`, `companyPath()`, `postsPath(profileUrn, count, queryId)`, `fetchCompanyBundle()`, `fetchPostsBundle()` (top card for the URN → GraphQL, both through the caller's semaphore). GraphQL 400/404 → `SchemaDriftError` naming the env var.
- `src/linkedin/voyager/normalize-company.ts`, `normalize-posts.ts`; `normalize.ts` exports `image()`, `pictureOf()`, `str()`, `asRecord()`.
- `src/linkedin/voyager/types.ts`: `TYPES.legacyCompany`, `legacyIndustry`, `followingInfo`, `update`, `socialDetail`, `socialActivityCounts`.
- `src/linkedin/service.ts`: `LinkedInService { getProfile, getCompany, getPosts }`, one `TtlCache<unknown>` with namespaced keys (`profile:`, `company:`, `posts:<slug>:<count>`), one `Semaphore`. `ProfileService` name removed; `BuildAppOptions.service` becomes `services`.
- `src/routes/company.ts`, `src/routes/posts.ts`; swagger tags `company`, `posts`.
- `src/config.ts`: `VOYAGER_POSTS_QUERY_ID` (default above).
- `scripts/record-fixture.ts`: `pnpm record-fixture <slug>` (profile, unchanged), `pnpm record-fixture company <name>`, `pnpm record-fixture posts <slug>`; fixtures at `tests/fixtures/voyager/company/<name>/company.json`, `tests/fixtures/voyager/posts/<slug>/{topcard,posts}.json`. Same `strip()`.

## Testing

Unit: `parseCompanyUrl` matrix; `normalizeCompany`/`normalizePosts` against hand-written `minimal` fixtures (missing industry/followingInfo, showcase sibling, a repost via `header`, a reshare via `resharedUpdate`, missing counts); `activityIdToDate`; `fetchCompanyBundle`/`fetchPostsBundle` warning + stale-hash paths; client not-found mapping by kind. Recorded: `normalize.recorded.test.ts` extended to `company/*` and `posts/*`. Integration: routes, `count` 0/51 → 400, per-entity 404. Live: `anthropicresearch`, `iithyderabad`, `sharmanityam` posts.
