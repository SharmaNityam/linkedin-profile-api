# LinkedIn Profile API

A small HTTPS service that takes a LinkedIn profile URL and returns the profile as structured JSON — name, headline, location, about, experience, education, skills, certifications, languages, volunteering and images.

It works by talking to **Voyager**, the private JSON API LinkedIn's own web app uses, rather than parsing HTML. A headless-browser path is kept in reserve for the cases where raw HTTP stops working.

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

That's all that is required. On its first request the backend **bootstraps the rest of the session itself**: it loads `linkedin.com/feed/` with `li_at` alone — exactly what a browser does on a first visit — and keeps the `JSESSIONID`, `bcookie`, `bscookie` and `lidc` cookies LinkedIn issues in response, then uses them for every Voyager call.

Optionally, `LI_COOKIES` can be set to the browser's own `document.cookie` string (DevTools console → `copy(document.cookie)`) to reuse the browser's companion cookies instead of bootstrapping new ones.

The cookie normally lives for about a year. When it expires — or LinkedIn revokes it — the API starts returning `503 LINKEDIN_SESSION_EXPIRED`; paste a fresh value and restart.

> **Why the bootstrap exists.** During development, the first version sent `li_at` with a *fabricated* `JSESSIONID` and no other cookies. LinkedIn revoked the entire session within minutes — the browser it was copied from was logged out too. LinkedIn evidently checks that `li_at` travels with the companion cookies it was issued alongside. Acquiring those companions the way a browser does removed the problem; the same account has been stable since.

`.env` is git-ignored. Never commit it.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LI_AT` | — | LinkedIn session cookie (required) |
| `LI_COOKIES` | — | Optional: the browser's `document.cookie` for linkedin.com, used instead of bootstrapping companion cookies |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `RATE_LIMIT_PER_MINUTE` | `10` | Per-IP limit; protects the LinkedIn account behind the API |
| `CACHE_TTL_SECONDS` | `900` | In-memory cache for repeated lookups of the same profile |
| `MAX_CONCURRENT_UPSTREAM` | `2` | Concurrent requests to LinkedIn |
| `BROWSER_FALLBACK` | `false` | Enable the headless-Chromium fallback (needs ~1 GB RAM) |
| `BROWSER_CHANNEL` | — | e.g. `chrome` to use a locally installed Chrome for the fallback |
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
    "partial": false,
    "warnings": []
  }
}
```

Schema conventions:

- A field LinkedIn does not expose for that profile is `null`; a section the profile does not have is `[]`.
- Dates are `{ "year", "month"? }` — LinkedIn stores month precision, so no day is ever invented.
- `experience[].isCurrent` is `true` when a position has a start date and no end date.
- `meta.source` tells you which path produced the response (`voyager` = raw HTTP, `browser` = headless browser). `meta.partial` is `true` only for the last-resort DOM path, which returns top-card fields only.
- The full schema is in [`src/schema/profile.ts`](src/schema/profile.ts) and served at `/openapi.json`.

#### Errors

All errors share one envelope: `{ "error": { "code", "message", "details"? } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_URL` | Not a LinkedIn member-profile URL |
| 400 | `INVALID_REQUEST` | Missing/invalid `url` parameter |
| 404 | `PROFILE_NOT_FOUND` | LinkedIn says the profile "can't be accessed" — it doesn't exist or its visibility is restricted (LinkedIn does not distinguish the two) |
| 429 | `RATE_LIMITED` | This API's per-IP limit, or LinkedIn's own limit (with `Retry-After`) |
| 502 | `UPSTREAM_ERROR` / `SCHEMA_DRIFT` | LinkedIn returned something we couldn't use (and the fallbacks, if enabled, couldn't either) |
| 503 | `LINKEDIN_SESSION_EXPIRED` | The `LI_AT` cookie needs rotating |

### `GET /health`

`{ "status": "ok", "uptimeSeconds": 123 }` — used by the container health check and Render.

---

## Approach: reverse engineering Voyager

LinkedIn's web app is a client of an internal REST API at `https://www.linkedin.com/voyager/api/`. Every profile section is fetched from it as JSON, so the most faithful way to "scrape" a profile is to ask the same API the page asks.

### What the page does

Loading a profile with DevTools open shows the app calling `/voyager/api/identity/dash/profiles` and `/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.…`. The `dash/profiles` endpoint takes a **decoration ID** — Voyager's term for a projection that says which fields and nested entities to include — and the LinkedIn client ships with a catalogue of them. Probing the endpoint from the page's own context (so the request carried real cookies) established which ones return what:

| Decoration | Returns |
|---|---|
| `…profile.FullProfileWithEntities-101` | The whole profile graph: `Profile`, `PositionGroup`→`Position`, `Education`, `Skill` (first 20 only), `Certification`, `Language`, `VolunteerExperience`, `Project`, `Honor`, `Publication`, `Course`, plus the `Company`, `School`, `Industry` and `EmploymentType` entities they reference. ~115 KB. |
| `…profile.WebTopCardCore-16` | The top card. Needed because the full decoration only carries the location as a `urn:li:fsd_geo:…` reference; this one includes the `Geo` entity with its `defaultLocalizedName`. |
| `/identity/dash/profileSkills?q=viewee&profileUrn=…&start=20` | Pages through skills beyond the inline cap of 20. The inline collection's `paging.total` says whether this is needed. |

The older, widely-documented endpoints (`/identity/profiles/{slug}/profileView`, `/skills`, `/profileContactInfo`) now return **410 Gone**; this project does not use them.

### Authentication and headers

Two cookies and one header are all Voyager needs:

- `li_at` — the real session cookie, issued at login. Supplied via env.
- `JSESSIONID` + `csrf-token` — LinkedIn uses the *double-submit* CSRF pattern: the header must equal the cookie. The client uses the `JSESSIONID` LinkedIn issues during the session bootstrap (see [Getting `LI_AT`](#getting-li_at)); if the operator supplied `LI_COOKIES`, the browser's own value is used instead.
- `bcookie`, `bscookie`, `lidc` — companion cookies from the same bootstrap. Not needed for authorization, but their absence is the signal that gets a session revoked.
- `x-restli-protocol-version: 2.0.0` and `accept: application/vnd.linkedin.normalized+json+2.1` — these switch the response into Rest.li's *normalized* format, described next.

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

### Why a browser fallback, and why it's shaped this way

The raw-HTTP path is fast (≈1–2 s per profile, three requests) and cheap to host, but it presents a non-browser TLS fingerprint and hand-built headers, so it is the path LinkedIn is most likely to block (HTTP 999) or break by tweaking CSRF handling. The fallback therefore doesn't try to *parse the page* first — it re-issues **the same Voyager requests from inside a real, logged-in Chromium tab**, where LinkedIn sees its own cookies, its own headers and a genuine browser. Same endpoints, same normaliser, same output.

Only if that also fails does the service read the rendered DOM, and it deliberately limits itself to the **top card and About** (name, headline, location, about, photo). LinkedIn's profile page is now server-driven UI with build-hashed class names and lazily-loaded sections, so a class-selector scraper of experience/education would be brittle and dishonest; the DOM path instead keys off semantics (the section containing the name heading, the section titled "About") and returns `meta.partial: true` so callers know what they're getting.

Escalation is decided in [`ProfileService`](src/linkedin/service.ts) and is deliberately narrow: only *infrastructure* failures (`UPSTREAM_ERROR`, `SCHEMA_DRIFT`) escalate. A profile that doesn't exist, an expired cookie or a rate limit are terminal — the browser would get the same answer, so the service doesn't spend ten seconds finding out.

---

## Architecture

```
HTTP (Fastify + zod)          src/server.ts, src/routes/profile.ts
        │
        ▼
ProfileService                src/linkedin/service.ts
  cache → http Voyager → browser Voyager → DOM top card
        │                    │                 │
        ▼                    ▼                 ▼
HttpVoyagerClient   BrowserVoyagerClient   scrapeTopCard      src/linkedin/voyager/client.ts
        │                    │                                 src/linkedin/browser/scraper.ts
        └────────┬───────────┘
                 ▼
     fetchProfileBundle        src/linkedin/voyager/endpoints.ts   ← every URL & decoration ID lives here
                 ▼
     EntityGraph → normalizeProfile → ProfileData                 src/linkedin/voyager/{graph,normalize}.ts
                                              ▼
                                   zod ProfileResponse           src/schema/profile.ts  ← types + validation + OpenAPI
```

Design points worth calling out:

- **One schema, three uses.** `src/schema/profile.ts` is a zod schema. It gives the TypeScript types, validates every response before it leaves the service (a mismatch becomes a `meta.warnings` entry, not a 500), and generates the OpenAPI document served at `/docs`.
- **Transports are interchangeable.** `VoyagerTransport` is a one-method interface; HTTP and browser implementations share `interpretVoyagerResponse`, so LinkedIn's failure modes are mapped to typed errors in exactly one place.
- **Volatile knowledge is quarantined.** Decoration IDs and URLs live only in `endpoints.ts`; DOM heuristics only in `selectors.ts`. When LinkedIn changes something, there is one file to touch and a fixture test to tell you what moved.
- **The account is protected.** Per-IP rate limiting, a 15-minute cache, and a concurrency semaphore (default 2) keep request volume to LinkedIn low even under a burst of API traffic.
- **Secrets never touch logs.** Cookie headers are redacted by pino; config is logged with `LI_AT` masked.

---

## Testing

```bash
pnpm test          # unit + integration, offline, ~1 s
pnpm test:live     # hits LinkedIn for real; needs LI_AT in the environment
pnpm typecheck && pnpm lint
```

- **Unit:** URL parsing matrix, entity-graph resolution, the normaliser against a hand-written fixture that covers every branch (missing entities, capped skills, year-only dates, unknown enum values…), the HTTP client's error mapping with a mocked `fetch`, cache/semaphore, the DOM top-card parser, and the service's escalation table.
- **Recorded fixtures:** `pnpm record-fixture <slug>` saves real Voyager responses (tracking noise stripped) under `tests/fixtures/voyager/<slug>/`. `normalize.recorded.test.ts` runs the normaliser over every recorded profile and checks the output against the schema — this is the schema-drift alarm.
- **Integration:** the Fastify app via `app.inject` — routes, validation, error envelope, `Retry-After`, rate limiting, OpenAPI.
- **Live:** an env-gated smoke test for a real profile (all sections present, skills paged past 20, unknown slug → 404).

---

## Deployment

The service ships as a Docker image based on `mcr.microsoft.com/playwright`, so Chromium and its system libraries are present for the fallback.

```bash
docker build -t linkedin-profile-api .
docker run --rm -p 3000:3000 -e LI_AT="$LI_AT" -e BROWSER_FALLBACK=true linkedin-profile-api
```

### Render

`render.yaml` describes the service. Connect the repo in the Render dashboard, create a Blueprint, and set `LI_AT` as a secret environment variable (it is marked `sync: false`, so it is never read from the repo). Render provisions HTTPS automatically.

The blueprint targets the **free** plan, which is fine for the Voyager HTTP path. Two consequences: free instances (512 MB) cannot run Chromium, so `BROWSER_FALLBACK` is `false` there — switch to the starter plan and set it to `true` to enable the fallback; and free instances sleep after 15 minutes of inactivity, so the first request after a pause takes ~30–50 s while the container wakes.

---

## Known limitations

**Terms of service and account risk.** Accessing LinkedIn through its private API with a personal session violates LinkedIn's User Agreement. The account behind `LI_AT` can be rate-limited, challenged or restricted. This project exists as a technical exercise; the rate limit, cache and concurrency cap are there to keep volume low, but they don't make it sanctioned.

**Session lifetime and revocation.** `li_at` expires (roughly yearly) and LinkedIn revokes it outright if it decides the session is being replayed from another client — see the note in [Getting `LI_AT`](#getting-li_at). The cookie bootstrap mitigates this; it doesn't eliminate it. Rotation is manual; the API reports `503 LINKEDIN_SESSION_EXPIRED` until it's done.

**404 conflates "missing" and "private".** LinkedIn returns the same 403 `"This profile can't be accessed"` for a non-existent slug and for a profile the account is not allowed to see. The API reports both as `PROFILE_NOT_FOUND`.

**Data is what the viewer can see.** Results reflect the visibility the scraping account has: out-of-network profiles may show fewer details, and LinkedIn may serve a subset of a profile to accounts it considers suspicious.

**Not exposed by the decorations used:** skill endorsement counts, contact info (email/phone/websites), follower/connection counts, recommendations, featured posts and activity. Adding any of these means finding its decoration or GraphQL `queryId` and extending `endpoints.ts` + `normalize.ts`.

**Skills are capped at 200** (paged in 50s) to bound request count.

**Decoration IDs are undocumented and versioned.** LinkedIn can retire `FullProfileWithEntities-101` at any time; the symptom would be `SCHEMA_DRIFT` and failing recorded-fixture tests. The remedy is to capture the new ID from the web app and update one constant.

**The DOM fallback is intentionally partial.** It returns identity fields only and flags `meta.partial: true`; list sections are not scraped from HTML (see [Approach](#why-a-browser-fallback-and-why-its-shaped-this-way)).

**No persistence.** The cache is in-memory; a restart clears it. That's appropriate for this scope but means a multi-instance deployment would not share it.

---

## License

MIT
