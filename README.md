# LinkedIn Profile API

A small HTTPS service that takes a LinkedIn profile URL and returns the profile as structured JSON: name, headline, location, about, experience, education, skills, certifications, languages, volunteering and images.

It is a pure reverse-engineering of **Voyager**, the private JSON API that LinkedIn's own web app calls. Every request goes straight to LinkedIn's endpoints over HTTP; there is no browser, no HTML parsing and no third-party service involved.

```bash
curl "https://linkedin-profile-api-c925.onrender.com/v1/profile?url=https://www.linkedin.com/in/sharmanityam/"
```

- **Live docs:** `https://linkedin-profile-api-c925.onrender.com/docs` (Swagger UI, generated from the response schema)
- **OpenAPI:** `https://linkedin-profile-api-c925.onrender.com/openapi.json`

---

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Approach: reverse engineering Voyager](#approach-reverse-engineering-voyager)
- [Architecture](#architecture)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Quick start

Requirements: Node 22+, pnpm, and a LinkedIn account.

```bash
git clone https://github.com/SharmaNityam/linkedin-profile-api
cd linkedin-profile-api
pnpm install
cp .env.example .env        # then fill in LI_AT (see below)
pnpm dev                    # http://localhost:3000/docs
```

### Getting `LI_AT`

The service authenticates to LinkedIn with the `li_at` session cookie of a real account. No password is ever stored.

1. Log in to linkedin.com in a browser.
2. Open DevTools → **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copy the value of `li_at` into `.env` as `LI_AT=…`.

That's all that is required. On its first request the backend **bootstraps the rest of the session itself**: it loads `linkedin.com/feed/` with `li_at` alone, exactly what a browser does on a first visit, and keeps the `JSESSIONID`, `bcookie`, `bscookie` and `lidc` cookies LinkedIn issues in response, then uses them for every Voyager call.

Optionally, `LI_COOKIES` can be set to the browser's own `document.cookie` string (DevTools console → `copy(document.cookie)`) to reuse the browser's companion cookies instead of bootstrapping new ones.

The cookie normally lives for about a year. When it expires, or LinkedIn revokes it, the API starts returning `503 LINKEDIN_SESSION_EXPIRED`; paste a fresh value and restart.

> **Why the bootstrap exists.** During development, the first version sent `li_at` with a *fabricated* `JSESSIONID` and no other cookies. LinkedIn revoked the entire session within minutes, the browser it was copied from was logged out too. LinkedIn evidently checks that `li_at` travels with the companion cookies it was issued alongside. Acquiring those companions the way a browser does removed the problem; the same account has been stable since.

`.env` is git-ignored. Never commit it.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LI_AT` | - | LinkedIn session cookie (required) |
| `LI_COOKIES` | - | Optional: the browser's `document.cookie` for linkedin.com, used instead of bootstrapping companion cookies |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `RATE_LIMIT_PER_MINUTE` | `10` | Per-IP limit; protects the LinkedIn account behind the API |
| `CACHE_TTL_SECONDS` | `900` | In-memory cache for repeated lookups of the same profile |
| `MAX_CONCURRENT_UPSTREAM` | `2` | Concurrent requests to LinkedIn |
| `LOG_LEVEL` | `info` | pino log level |

---

## API

### `GET /v1/profile?url=<linkedin-url>`
### `POST /v1/profile` with body `{"url": "<linkedin-url>"}`

Accepted URL forms: `https://www.linkedin.com/in/<slug>/`, `linkedin.com/in/<slug>?…`, `in.linkedin.com/in/<slug>`, `linkedin.com/mwlite/in/<slug>`, or just the bare `<slug>`. Company, school and post URLs are rejected with `400`.

#### Response `200`

```jsonc
{
  "url": "https://www.linkedin.com/in/sharmanityam/",
  "publicIdentifier": "sharmanityam",
  "urn": "urn:li:fsd_profile:ACoAADWmn7EB…",
  "firstName": "Nityam",
  "lastName": "Sharma",
  "fullName": "Nityam Sharma",
  "pronouns": "He/Him",
  "headline": "Software Engineer Intern @Brackets | Ex-Intern @IIT Hyderabad | …",
  "about": "…",
  "location": { "name": "India", "countryCode": "IN" },
  "industry": "Computer Software",
  "isPremium": false,
  "profileImage": {
    "url": "https://media.licdn.com/dms/image/v2/…/profile-displayphoto-crop_800_800/…",
    "variants": [
      { "width": 100, "height": 100, "url": "…" },
      { "width": 200, "height": 200, "url": "…" },
      { "width": 400, "height": 400, "url": "…" },
      { "width": 800, "height": 800, "url": "…" }
    ]
  },
  "backgroundImage": { "url": "…", "variants": [ … ] },
  "experience": [
    {
      "title": "Flutter Developer Intern",
      "companyName": "Rhyno EV",
      "company": {
        "name": "Rhyno EV",
        "linkedinUrl": "https://www.linkedin.com/company/rhyno-wheels/",
        "logoUrl": "https://media.licdn.com/dms/image/v2/…/company-logo_200_200/…",
        "universalName": "rhyno-wheels"
      },
      "employmentType": "Internship",
      "location": null,
      "description": null,
      "startDate": { "year": 2024, "month": 6 },
      "endDate": { "year": 2024, "month": 9 },
      "isCurrent": false
    }
  ],
  "education": [
    {
      "schoolName": "SRM Institute of Science and Technology (SRMIST)",
      "school": { "name": "…", "linkedinUrl": "https://www.linkedin.com/school/…", "logoUrl": "…", "universalName": null },
      "degree": "Bachelor of Technology - BTech",
      "fieldOfStudy": "Computer Science",
      "grade": null,
      "activities": null,
      "description": null,
      "startDate": { "year": 2021 },
      "endDate": { "year": 2025 }
    }
  ],
  "skills": [ { "name": "Flutter" }, { "name": "TypeScript" } ],
  "certifications": [
    {
      "name": "…",
      "authority": "…",
      "organization": { "name": "…", "linkedinUrl": "…", "logoUrl": "…", "universalName": "…" },
      "licenseNumber": null,
      "url": "https://…",
      "issuedAt": { "year": 2024, "month": 1 },
      "expiresAt": null
    }
  ],
  "languages": [ { "name": "Hindi", "proficiency": "NATIVE_OR_BILINGUAL" } ],
  "volunteering": [
    { "role": "…", "organizationName": "…", "organization": null, "cause": "EDUCATION", "description": null, "startDate": { "year": 2023 }, "endDate": null }
  ],
  "projects": [], "honors": [], "publications": [], "courses": [],
  "meta": {
    "source": "voyager",
    "fetchedAt": "2026-08-27T10:12:33.120Z",
    "cached": false,
    "durationMs": 1320,
    "warnings": []
  }
}
```

Schema conventions:

- A field LinkedIn does not expose for that profile is `null`; a section the profile does not have is `[]`.
- Dates are `{ "year", "month"? }`: LinkedIn stores month precision, so no day is ever invented.
- `experience[].isCurrent` is `true` when a position has a start date and no end date.
- `meta.warnings` lists non-fatal problems, e.g. a skills page that could not be fetched.
- The full schema is in [`src/schema/profile.ts`](src/schema/profile.ts) and served at `/openapi.json`.

#### Errors

All errors share one envelope: `{ "error": { "code", "message", "details"? } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_URL` | Not a LinkedIn member-profile URL |
| 400 | `INVALID_REQUEST` | Missing/invalid `url` parameter |
| 404 | `PROFILE_NOT_FOUND` | LinkedIn says the profile "can't be accessed": it doesn't exist or its visibility is restricted (LinkedIn does not distinguish the two) |
| 429 | `RATE_LIMITED` | This API's per-IP limit, or LinkedIn's own limit (with `Retry-After`) |
| 502 | `UPSTREAM_ERROR` / `SCHEMA_DRIFT` | LinkedIn returned something we couldn't use (blocked request, 5xx, or a changed response shape) |
| 503 | `LINKEDIN_SESSION_EXPIRED` | The `LI_AT` cookie needs rotating |

### `GET /health`

`{ "status": "ok", "uptimeSeconds": 123 }`: used by the container health check and Render.

---

## Approach: reverse engineering Voyager

LinkedIn's web app is a client of an internal REST API at `https://www.linkedin.com/voyager/api/`. Every profile section is fetched from it as JSON, so the most faithful way to "scrape" a profile is to ask the same API the page asks.

### What the page does

Loading a profile with DevTools open shows the app calling `/voyager/api/identity/dash/profiles` and `/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.…`. The `dash/profiles` endpoint takes a **decoration ID**, Voyager's term for a projection that says which fields and nested entities to include, and the LinkedIn client ships with a catalogue of them. Probing the endpoint from the page's own context (so the request carried real cookies) established which ones return what:

| Decoration | Returns |
|---|---|
| `…profile.FullProfileWithEntities-101` | The whole profile graph: `Profile`, `PositionGroup`→`Position`, `Education`, `Skill` (first 20 only), `Certification`, `Language`, `VolunteerExperience`, `Project`, `Honor`, `Publication`, `Course`, plus the `Company`, `School`, `Industry` and `EmploymentType` entities they reference. ~115 KB. |
| `…profile.WebTopCardCore-16` | The top card. Needed because the full decoration only carries the location as a `urn:li:fsd_geo:…` reference; this one includes the `Geo` entity with its `defaultLocalizedName`. |
| `/identity/dash/profileSkills?q=viewee&profileUrn=…&start=20` | Pages through skills beyond the inline cap of 20. The inline collection's `paging.total` says whether this is needed. |

The older, widely-documented endpoints (`/identity/profiles/{slug}/profileView`, `/skills`, `/profileContactInfo`) now return **410 Gone**; this project does not use them.

### Authentication and headers

Two cookies and one header are all Voyager needs:

- `li_at`: the real session cookie, issued at login. Supplied via env.
- `JSESSIONID` + `csrf-token`: LinkedIn uses the *double-submit* CSRF pattern: the header must equal the cookie. The client uses the `JSESSIONID` LinkedIn issues during the session bootstrap (see [Getting `LI_AT`](#getting-li_at)); if the operator supplied `LI_COOKIES`, the browser's own value is used instead.
- `bcookie`, `bscookie`, `lidc`: companion cookies from the same bootstrap. Not needed for authorization, but their absence is the signal that gets a session revoked.
- `x-restli-protocol-version: 2.0.0` and `accept: application/vnd.linkedin.normalized+json+2.1`: these switch the response into Rest.li's *normalized* format, described next.

### The normalized entity graph

Responses are not nested documents. They come as a flat `included[]` list of typed entities keyed by URN, and any field whose name starts with `*` holds a URN (or list of URNs) pointing into that list:

```jsonc
{
  "data": { "*elements": ["urn:li:fsd_profile:ACoAAD…"] },
  "included": [
    { "entityUrn": "urn:li:fsd_profile:ACoAAD…", "$type": "…profile.Profile",
      "firstName": "Nityam", "*profilePositionGroups": "urn:li:collectionResponse:…", "*industry": "urn:li:fsd_industry:4" },
    { "entityUrn": "urn:li:collectionResponse:…", "paging": { "total": 7 }, "*elements": ["urn:li:fsd_profilePositionGroup:…"] },
    { "entityUrn": "urn:li:fsd_profilePositionGroup:…", "*company": "urn:li:fsd_company:26622256", "*profilePositionInPositionGroup": "…" },
    { "entityUrn": "urn:li:fsd_company:26622256", "$type": "…organization.Company", "name": "Rhyno EV", "logo": { "vectorImage": { … } } }
  ]
}
```

[`EntityGraph`](src/linkedin/voyager/graph.ts) indexes `included[]` by URN and exposes `ref()` / `collection()` to follow those pointers; a dangling reference yields `undefined` rather than an exception so one missing entity never fails the whole profile. [`normalizeProfile`](src/linkedin/voyager/normalize.ts) walks the graph from the root `Profile` and produces the public schema. It is a pure function, which is what makes it testable against recorded fixtures.

Images are assembled from `vectorImage.rootUrl + artifacts[].fileIdentifyingUrlPathSegment`, one URL per rendition.

### Failure handling

`interpretVoyagerResponse` maps every way LinkedIn can say no onto one typed error: a login redirect or HTML body means the session is dead (`503`), a 403 "can't be accessed" is a missing or restricted profile (`404`), 429 is passed through with `Retry-After`, 400 means the decoration ID is no longer recognised (`SCHEMA_DRIFT`), and 999 is LinkedIn's bot-detection status. Only network errors and 5xx are retried, once.

---

## Architecture

```
HTTP (Fastify + zod)          src/server.ts, src/routes/profile.ts
        │
        ▼
ProfileService                src/linkedin/service.ts
  cache → Voyager
        │
        ▼
HttpVoyagerClient             src/linkedin/voyager/client.ts   ← cookies, CSRF, error mapping
        │
        ▼
     fetchProfileBundle        src/linkedin/voyager/endpoints.ts   ← every URL & decoration ID lives here
                 ▼
     EntityGraph → normalizeProfile → ProfileData                 src/linkedin/voyager/{graph,normalize}.ts
                                              ▼
                                   zod ProfileResponse           src/schema/profile.ts  ← types + validation + OpenAPI
```

Design points worth calling out:

- **One schema, three uses.** `src/schema/profile.ts` is a zod schema. It gives the TypeScript types, validates every response before it leaves the service (a mismatch becomes a `meta.warnings` entry, not a 500), and generates the OpenAPI document served at `/docs`.
- **Failure mapping lives in one place.** `interpretVoyagerResponse` turns every LinkedIn response into either a parsed body or a typed error; the transport itself is a one-method interface so tests substitute a fake.
- **Volatile knowledge is quarantined.** Decoration IDs and URLs live only in `endpoints.ts`. When LinkedIn changes something, there is one file to touch and a fixture test to tell you what moved.
- **The account is protected.** Per-IP rate limiting, a 15-minute cache, and a concurrency semaphore (default 2) keep request volume to LinkedIn low even under a burst of API traffic.
- **Secrets never touch logs.** Cookie headers are redacted by pino; config is logged with `LI_AT` masked.

---

## Testing

```bash
pnpm test          # unit + integration, offline, ~1 s
pnpm test:live     # hits LinkedIn for real; needs LI_AT in the environment
pnpm typecheck && pnpm lint
```

- **Unit:** URL parsing matrix, entity-graph resolution, the normaliser against a hand-written fixture that covers every branch (missing entities, capped skills, year-only dates, unknown enum values…), the HTTP client's error mapping and session bootstrap with a mocked `fetch`, cache/semaphore, and the service (caching, error propagation).
- **Recorded fixtures:** `pnpm record-fixture <slug>` saves real Voyager responses (tracking noise stripped) under `tests/fixtures/voyager/<slug>/`. `normalize.recorded.test.ts` runs the normaliser over every recorded profile and checks the output against the schema, this is the schema-drift alarm.
- **Integration:** the Fastify app via `app.inject`: routes, validation, error envelope, `Retry-After`, rate limiting, OpenAPI.
- **Live:** an env-gated smoke test for a real profile (all sections present, skills paged past 20, unknown slug → 404).

---

## Deployment

The service ships as a small `node:22-slim` Docker image.

```bash
docker build -t linkedin-profile-api .
docker run --rm -p 3000:3000 -e LI_AT="$LI_AT" linkedin-profile-api
```

### Render

`render.yaml` describes the service. Connect the repo in the Render dashboard, create a Blueprint, and set `LI_AT` as a secret environment variable (it is marked `sync: false`, so it is never read from the repo). Render provisions HTTPS automatically.

The blueprint targets the **free** plan. Free instances sleep after 15 minutes of inactivity, so the first request after a pause takes ~30–50 s while the container wakes.

---

## Known limitations

**Terms of service and account risk.** Accessing LinkedIn through its private API with a personal session violates LinkedIn's User Agreement. The account behind `LI_AT` can be rate-limited, challenged or restricted. This project exists as a technical exercise; the rate limit, cache and concurrency cap are there to keep volume low, but they don't make it sanctioned.

**Session lifetime and revocation.** `li_at` expires (roughly yearly) and LinkedIn revokes it outright if it decides the session is being replayed from another client, see the note in [Getting `LI_AT`](#getting-li_at). The cookie bootstrap mitigates this; it doesn't eliminate it. Rotation is manual; the API reports `503 LINKEDIN_SESSION_EXPIRED` until it's done.

**404 conflates "missing" and "private".** LinkedIn returns the same 403 `"This profile can't be accessed"` for a non-existent slug and for a profile the account is not allowed to see. The API reports both as `PROFILE_NOT_FOUND`.

**Data is what the viewer can see.** Results reflect the visibility the scraping account has: out-of-network profiles may show fewer details, and LinkedIn may serve a subset of a profile to accounts it considers suspicious.

**Not exposed by the decorations used:** skill endorsement counts, contact info (email/phone/websites), follower/connection counts, recommendations, featured posts and activity. Adding any of these means finding its decoration or GraphQL `queryId` and extending `endpoints.ts` + `normalize.ts`.

**Skills are capped at 200** (paged in 50s) to bound request count.

**Decoration IDs are undocumented and versioned.** LinkedIn can retire `FullProfileWithEntities-101` at any time; the symptom would be `SCHEMA_DRIFT` and failing recorded-fixture tests. The remedy is to capture the new ID from the web app and update one constant.

**Bot detection.** Requests come from a plain HTTP client, not a browser. LinkedIn can respond with HTTP 999 if it decides the client looks automated; the API reports that as `502 UPSTREAM_ERROR`. Sending the session's companion cookies and a realistic user agent keeps this rare, but not impossible.

**Image URLs expire.** Every image URL LinkedIn returns is signed (`?e=<unix-expiry>&v=beta&t=<sig>`), typically valid for weeks. A response served from the cache after that point contains dead image URLs; the playground falls back to a placeholder instead of a broken image, and API consumers should treat `url`/`variants` as short-lived. Only `media.licdn.com` renditions are emitted; the cookie-gated `linkedin.com/dms/prv/` originals are never exposed.

**No persistence.** The cache is in-memory; a restart clears it. That's appropriate for this scope but means a multi-instance deployment would not share it.

---

## License

MIT
