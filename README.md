# LinkedIn Profile API

[![CI](https://github.com/SharmaNityam/linkedin-profile-api/actions/workflows/ci.yml/badge.svg)](https://github.com/SharmaNityam/linkedin-profile-api/actions/workflows/ci.yml)

A small HTTPS service that takes a LinkedIn URL and returns structured JSON. Three entities: a **member profile** (name, headline, location, about, experience, education, skills, certifications, languages, volunteering and images), a **company or school page**, and a **member's newest posts**.

It is a pure reverse-engineering of **Voyager**, the private JSON API that LinkedIn's own web app calls. Every request goes straight to LinkedIn's endpoints over HTTP; there is no browser, no HTML parsing and no third-party service involved.

```bash
# Prove you control an inbox: request a code, then verify it to get a cookie.
curl -X POST https://linkedin-profile-api-c925.onrender.com/auth/request-code \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -X POST https://linkedin-profile-api-c925.onrender.com/auth/verify \
  -H 'content-type: application/json' -d '{"email":"you@example.com","code":"123456"}' \
  -c cookies.txt

curl -b cookies.txt "https://linkedin-profile-api-c925.onrender.com/v1/profile?url=https://www.linkedin.com/in/sharmanityam/"
curl -b cookies.txt "https://linkedin-profile-api-c925.onrender.com/v1/company?url=https://www.linkedin.com/company/anthropicresearch/"
curl -b cookies.txt "https://linkedin-profile-api-c925.onrender.com/v1/posts?url=https://www.linkedin.com/in/sharmanityam/&count=5"
```

There is no sign-up, no password and no third-party login: proving you control an inbox is enough. `/v1/*` sits behind an email one-time-code gate (see [Access](#access)); past that, a per-IP-or-per-email rate limit is the only thing standing between a caller and LinkedIn.

- **Live docs:** `https://linkedin-profile-api-c925.onrender.com/docs` (Swagger UI, generated from the response schema)
- **OpenAPI:** `https://linkedin-profile-api-c925.onrender.com/openapi.json`

**Share a result:** append `?url=<linkedin-url>` to the playground URL and it pre-fills and runs the lookup, e.g. `https://linkedin-profile-api-c925.onrender.com/?url=https://www.linkedin.com/in/sharmanityam/`.

---

## Contents

- [Quick start](#quick-start)
- [Access](#access)
- [API](#api)
  - [`GET|POST /v1/profile`](#getpost-v1profile)
  - [`GET|POST /v1/company`](#getpost-v1company)
  - [`GET|POST /v1/posts`](#getpost-v1posts)
  - [Errors](#errors)
- [Approach: reverse engineering Voyager](#approach-reverse-engineering-voyager)
  - [Company pages](#company-pages)
  - [Member posts](#member-posts)
  - [Re-capturing the posts `queryId`](#re-capturing-the-posts-queryid)
- [Architecture](#architecture)
- [Testing](#testing)
  - [CI](#ci)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Quick start

Requirements: Node 22+, pnpm, and a LinkedIn account.

```bash
git clone https://github.com/SharmaNityam/linkedin-profile-api
cd linkedin-profile-api
pnpm install
cp .env.example .env    # then fill in LI_AT (see below)
pnpm dev                # http://localhost:3000/docs
```

### Getting `LI_AT`

The service authenticates to LinkedIn with the `li_at` session cookie of a real account. No password is ever stored.

1. Log in to linkedin.com in a browser.
2. Open DevTools → **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copy the value of `li_at` into `.env` as `LI_AT=…`.

That's all that is required. On its first request the backend **bootstraps the rest of the session itself**: it loads `linkedin.com/feed/` with `li_at` alone, exactly what a browser does on a first visit, and keeps the `JSESSIONID`, `bcookie`, `bscookie` and `lidc` cookies LinkedIn issues in response, then uses them for every Voyager call.

Optionally, `LI_COOKIES` can be set to the browser's own `document.cookie` string (DevTools console → `copy(document.cookie)`) to reuse the browser's companion cookies instead of bootstrapping new ones.

The cookie normally lives for about a year. When it expires, or LinkedIn revokes it, the API starts returning `503 LINKEDIN_SESSION_EXPIRED`; paste a fresh value and restart.

> **Why the bootstrap exists.** During development, the first version sent `li_at` with a _fabricated_ `JSESSIONID` and no other cookies. LinkedIn revoked the entire session within minutes, the browser it was copied from was logged out too. LinkedIn evidently checks that `li_at` travels with the companion cookies it was issued alongside. Acquiring those companions the way a browser does removed the problem; the same account has been stable since.

`.env` is git-ignored. Never commit it.

### Configuration

Everything the service reads is declared and validated in [`src/config.ts`](src/config.ts); an invalid environment fails the process at startup rather than at the first request.

| Variable                  | Default                            | Purpose                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LI_AT`                   | -                                  | LinkedIn session cookie (required)                                                                                                                                                                                                         |
| `LI_COOKIES`              | -                                  | Optional: the browser's `document.cookie` for linkedin.com, used instead of bootstrapping companion cookies                                                                                                                                |
| `PORT` / `HOST`           | `3000` / `0.0.0.0`                 | Listen address                                                                                                                                                                                                                             |
| `RATE_LIMIT_PER_MINUTE`   | `10`                               | Requests per minute per IP; protects the LinkedIn account behind the API                                                                                                                                                                   |
| `CACHE_TTL_SECONDS`       | `900`                              | In-memory cache for repeated lookups of the same entity                                                                                                                                                                                    |
| `MAX_CONCURRENT_UPSTREAM` | `2`                                | Concurrent requests to LinkedIn                                                                                                                                                                                                            |
| `VOYAGER_POSTS_QUERY_ID`  | `20c70fe0314184158516a7ec004c0408` | The `voyagerFeedDashProfileUpdates` persisted-query hash used by `/v1/posts`. LinkedIn rotates these; see [Re-capturing the posts `queryId`](#re-capturing-the-posts-queryid)                                                              |
| `LOG_LEVEL`               | `info`                             | pino log level                                                                                                                                                                                                                             |
| `SESSION_KEY`             | -                                  | 64 hex chars (32 bytes), required. Encrypts and signs the `sid` cookie; generate with `openssl rand -hex 32`. Rotating it signs every caller out                                                                                           |
| `SMTP_USER` / `SMTP_PASS` | -                                  | Gmail account and app password used to mail codes over SMTP. Required when `NODE_ENV=production` unless `BREVO_API_KEY` is set; in development, an unset pair falls back to logging the code instead of mailing it (see [Access](#access)) |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `465`           | SMTP endpoint for outgoing mail                                                                                                                                                                                                            |
| `BREVO_API_KEY`           | -                                  | Brevo transactional-email API key. When set, mail is sent over HTTPS via Brevo instead of SMTP, and takes priority over `SMTP_USER`/`SMTP_PASS`; required on hosts that block outbound SMTP (see [Sending codes](#sending-codes))          |
| `EMAIL_FROM`              | `SMTP_USER`                        | Sender address on the code email (Brevo's `sender.email`, or SMTP's `From`). Required when `BREVO_API_KEY` is set and `SMTP_USER` isn't                                                                                                    |
| `APP_ORIGIN`              | `http://localhost:3000`            | The only `Origin` a mutating request may declare; anything else is rejected (CSRF defence for the cookie)                                                                                                                                  |
| `OTP_RATE_LIMIT_PER_HOUR` | `10`                               | Per-IP budget for `/auth/request-code` and `/auth/verify`                                                                                                                                                                                  |
| `OTP_PER_EMAIL_PER_HOUR`  | `5`                                | Per-address budget for code issuance, independent of IP                                                                                                                                                                                    |

Secrets never reach the log: `redactConfig` masks `LI_AT`, `SESSION_KEY`, `SMTP_PASS` and `BREVO_API_KEY` by length and reports only the length of `LI_COOKIES`.

---

## Access

`/v1/*` is behind an email one-time-code gate: no password, no phone number, no database. Proving control of an inbox is the only credential.

1. `GET /auth/config` reports the gate this deployment uses (`{"gate":"email"}`), unlimited — a client probes this before deciding whether to show a sign-in step.
2. `POST /auth/request-code {"email"}` mails a 6-digit code to that address and always answers `200 {"status":"code_sent"}` (except when the per-address rate limit is hit, see below — the response never otherwise reveals whether the address has been seen before).
3. `POST /auth/verify {"email","code"}` checks the code and, on success, sets a signed and encrypted `sid` cookie (`httpOnly`, `sameSite=lax`, 30-day expiry, and `Secure` when `NODE_ENV=production` — off in development, where there's no TLS) and returns `{"email"}`.
4. Every `/v1/*` request needs that cookie; a request without one, or with an expired/invalid one, gets `401 UNAUTHENTICATED`.
5. `GET /auth/me` reports the signed-in address or `401`; it counts against the global `RATE_LIMIT_PER_MINUTE` budget like a `/v1/*` call, not the per-hour OTP limits. `POST /auth/logout` clears the cookie and is unlimited.

Codes are 6 digits, expire in 10 minutes, allow 5 attempts, and are single-use. They live in memory only: a server restart invalidates every _pending_ code (an in-flight sign-in has to start over), but it does **not** invalidate already-issued cookies — a session survives a restart. The only way to revoke every session at once is to rotate `SESSION_KEY`, which invalidates every cookie in existence.

### Sending codes

Two ways to mail the code, picked automatically at startup: `BrevoMailer` wins when `BREVO_API_KEY` is set, otherwise `SmtpMailer` runs when `SMTP_USER`/`SMTP_PASS` are set, otherwise codes are only logged (`LogMailer`, dev only).

**Option A: Brevo (recommended on hosts that block outbound SMTP, e.g. Render's free tier)**

Render's free tier blocks outbound SMTP ports, so `SmtpMailer` sends there time out. Brevo's transactional API is plain HTTPS and isn't affected.

1. Sign up at [brevo.com](https://www.brevo.com).
2. Go to **Senders & IP** → add a sender using the Gmail address that will appear as the sender → confirm it via the mail Brevo sends to that address.
3. Go to **SMTP & API** → **API Keys** → create a key.
4. Set `BREVO_API_KEY` to that key and `EMAIL_FROM` to the Gmail address you verified.

Free tier: 300 mails/day.

**Option B: Gmail over SMTP**

1. Turn on 2-Step Verification on the Gmail account that will send codes.
2. Create an [App Password](https://myaccount.google.com/apppasswords) for it (a 16-character code, not the account password).
3. Set `SMTP_USER` to the Gmail address and `SMTP_PASS` to the app password. `SMTP_HOST`/`SMTP_PORT` default to Gmail's `smtp.gmail.com:465` and don't need to change for Gmail.

In development, leaving all of the above unset is fine: the server logs the code at `warn` level instead of mailing it, so local sign-in works without any setup. In production (`NODE_ENV=production`), `BREVO_API_KEY` or the `SMTP_USER`/`SMTP_PASS` pair is required and the process refuses to start without one of them.

### Limits, and what this does and doesn't prove

- **Per-IP**: `OTP_RATE_LIMIT_PER_HOUR` (default 10) on `/auth/request-code` and `/auth/verify`.
- **Per-address**: `OTP_PER_EMAIL_PER_HOUR` (default 5) on code issuance, independent of IP, so one address can't be hammered from many IPs. The cap applies to the _canonical_ address (see [`canonicalEmail`](src/auth/email.ts)): Gmail addresses fold dots and a trailing `+tag` (`j.o.h.n+promo@gmail.com` and `john@googlemail.com` share one budget with `john@gmail.com`), but a `+tag` on any other provider counts as a distinct address (`john+work@outlook.com` has its own budget, separate from `john@outlook.com`).
- **Gmail's own cap**: a personal Gmail account can send roughly 500 messages a day; this service does not track that separately, so a burst of sign-ins can exhaust it.
- **CSRF**: a mutating request whose `Origin` header is present and doesn't match `APP_ORIGIN` is rejected with `403 FORBIDDEN_ORIGIN`; a mutating request with a body must declare `application/json`.
- **What it proves**: the caller can read mail sent to the address they typed. **What it doesn't prove**: identity, that the address is theirs long-term, or anything beyond that one inbox at that one moment. It keeps casual, anonymous use off the LinkedIn-backed endpoints; it is not account security.
- The playground at `/` has the same flow inline: enter an email, type the code, then fetch; the cookie it sets is the one `curl` callers get from `/auth/verify`.

---

## API

`GET /`, `GET /docs`, `GET /openapi.json`, `GET /health`, `GET /auth/config` and `POST /auth/logout` are exempt from the rate limit entirely; `POST /auth/request-code` and `POST /auth/verify` are budgeted separately per `OTP_RATE_LIMIT_PER_HOUR`/`OTP_PER_EMAIL_PER_HOUR` (see [Access](#access)). Everything else — every `/v1/*` request and `GET /auth/me` — needs the session cookie where applicable and is counted against `RATE_LIMIT_PER_MINUTE` (default 10) — per verified email once signed in, per IP otherwise — and answers `429 RATE_LIMITED` with `Retry-After` once it is spent. Every request to a path that matches no route is counted against the same budget too.

Every endpoint is in the Swagger UI at `/docs`, generated from the same zod schemas that validate the responses, with example values on every URL, count, email and code input and a lock icon on the `/v1/*` routes that need the `sid` cookie. Sign in once at `/` (or via `POST /auth/verify`) and Swagger UI's "Try it out" works directly against those routes, since the session cookie is scoped to this origin.

### `GET|POST /v1/profile`

`GET /v1/profile?url=<linkedin-url>`, or `POST /v1/profile` with body `{"url": "<linkedin-url>"}`.

Accepted URL forms: `https://www.linkedin.com/in/<slug>/`, `linkedin.com/in/<slug>?…`, `in.linkedin.com/in/<slug>`, `linkedin.com/mwlite/in/<slug>`, or just the bare `<slug>`. Company and school URLs are rejected with `400 INVALID_URL` and a message pointing at `/v1/company`; other non-profile URLs are rejected with `400` too.

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
  "experienceGroups": [
    {
      "key": "rhyno-wheels",
      "name": "Rhyno EV",
      "company": {
        "name": "Rhyno EV",
        "linkedinUrl": "https://www.linkedin.com/company/rhyno-wheels/",
        "logoUrl": "https://media.licdn.com/dms/image/v2/…/company-logo_200_200/…",
        "universalName": "rhyno-wheels"
      },
      "employmentType": "Internship",
      "location": null,
      "startDate": { "year": 2024, "month": 6 },
      "endDate": { "year": 2024, "month": 9 },
      "isCurrent": false,
      "totalMonths": 4,
      "roles": [ /* the one Experience entry above */ ]
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
- `experienceGroups` collapses consecutive same-company roles into one entry each, LinkedIn-style; `employmentType` and `location` are only set when identical across every role in the group, otherwise `null`.
- `meta.warnings` lists non-fatal problems, e.g. a skills page that could not be fetched.
- The full schema is in [`src/schema/profile.ts`](src/schema/profile.ts) and served at `/openapi.json`.

### `GET|POST /v1/company`

`GET /v1/company?url=<company-or-school-url>`, or `POST /v1/company` with body `{"url": "<company-or-school-url>"}`.

Accepted URL forms: `https://www.linkedin.com/company/<name>/`, `https://www.linkedin.com/school/<name>/`, the same without scheme or trailing slash, or just the bare `<name>` (assumed to be a company). A `/in/` URL is rejected with `400 INVALID_URL` and a message pointing at `/v1/profile`.

Companies and schools are the same entity to LinkedIn and are served by the same endpoint; the response distinguishes them with `kind`.

#### Response `200`

Real output for `https://www.linkedin.com/company/anthropicresearch/`, with the long description and the signed image URLs trimmed:

```jsonc
{
  "url": "https://www.linkedin.com/company/anthropicresearch/",
  "universalName": "anthropicresearch",
  "urn": "urn:li:fs_normalized_company:74126343",
  "name": "Anthropic",
  "kind": "company",
  "tagline": "Anthropic is an AI safety and research company working to build reliable, interpretable, and steerable AI systems.",
  "description": "We're an AI research company that builds reliable, interpretable, and steerable AI systems. …",
  "websiteUrl": "https://www.anthropic.com/",
  "industries": ["Research Services"],
  "companyType": "Privately Held",
  "staffCount": 5826,
  "staffCountRange": { "start": 501, "end": 1000 },
  "followerCount": 4646925,
  "headquarters": null,
  "foundedYear": null,
  "specialities": [],
  "phone": null,
  "logo": {
    "url": "https://media.licdn.com/dms/image/v2/…/company-logo_400_400/…",
    "variants": [
      { "width": 100, "height": 100, "url": "…" },
      { "width": 200, "height": 200, "url": "…" },
      { "width": 400, "height": 400, "url": "…" },
    ],
  },
  "backgroundImage": {
    "url": "https://media.licdn.com/dms/image/v2/…/image-scale_191_1128/…",
    "variants": [
      { "width": 108, "height": 18, "url": "…" },
      { "width": 749, "height": 127, "url": "…" },
      { "width": 1128, "height": 191, "url": "…" },
    ],
  },
  "meta": {
    "source": "voyager",
    "fetchedAt": "…",
    "cached": false,
    "durationMs": 640,
    "warnings": [],
  },
}
```

A school differs only in the values. For `https://www.linkedin.com/school/iithyderabad/`: `"kind": "school"`, `"companyType": "Educational Institution"`, `"foundedYear": 2008`, and a populated `headquarters` (`{ "city": "Sangareddy", "region": "Telangana", "country": "IN", "postalCode": "502285", "line1": "NH65, Kandi," }`).

Schema conventions:

- Absent scalars are `null`, absent lists are `[]`, exactly as for profiles. Anthropic's page above genuinely has no `headquarter`, `foundedOn` or `specialities` set.
- `staffCount` and `staffCountRange` are both reported by LinkedIn and can disagree (5826 vs 501 to 1000 for Anthropic in the recorded sample); what each one counts is not documented, so treat `staffCountRange` as the band shown on the page and `staffCount` as a larger, separately computed figure.
- `websiteUrl` is the company's own site, not the LinkedIn page (that is `url`).
- The full schema is in [`src/schema/company.ts`](src/schema/company.ts).

### `GET|POST /v1/posts`

`GET /v1/posts?url=<profile-url>&count=<n>`, or `POST /v1/posts` with body `{"url": "<profile-url>", "count": <n>}`.

`url` takes the same forms `/v1/profile` accepts. `count` is an integer, **1 to 50, default 10**; out-of-range values are rejected with `400`. There is no pagination in v1: the response is the newest `count` posts, in the order LinkedIn returns them (newest first), and 50 is the ceiling. LinkedIn may return fewer than asked.

The operator's own home feed (`linkedin.com/feed/`) is deliberately **not** exposed. This API answers questions about a named member, not about whatever LinkedIn decided to show the account behind `LI_AT`.

#### Response `200`

Real output for `https://www.linkedin.com/in/sharmanityam/` at the default `count`, showing the newest post and the one repost in the sample; the other seven posts, the long bodies and the middle image renditions are elided:

```jsonc
{
  "url": "https://www.linkedin.com/in/sharmanityam/recent-activity/all/",
  "publicIdentifier": "sharmanityam",
  "count": 10,
  "posts": [
    {
      "urn": "urn:li:activity:7390255662376824832",
      "url": "https://www.linkedin.com/posts/activity-7390255662376824832-jfKf",
      "createdAt": "2025-11-01T05:17:34.221Z",
      "text": "I’m happy to share that I’m starting a new position as Software Engineer Intern at Brackets!",
      "author": {
        "name": "Nityam Sharma",
        "headline": "Software Engineer Intern @Brackets | Ex-Intern @IIT Hyderabad | …",
        "linkedinUrl": "https://www.linkedin.com/in/sharmanityam",
      },
      "isReshare": false,
      "reshared": null,
      "images": [],
      "article": null,
      "video": false,
      "stats": {
        "likes": 66,
        "comments": 31,
        "shares": 2,
        "reactions": { "LIKE": 53, "PRAISE": 8, "EMPATHY": 5 },
      },
    },
    {
      "urn": "urn:li:activity:7193517581419380736",
      "url": "https://www.linkedin.com/posts/shinjanpatra_working-on-something-interesting-…",
      "createdAt": "2024-05-07T07:50:40.504Z",
      "text": "Working on something interesting, will share once done. …",
      "author": {
        "name": "Shinjan P",
        "headline": "writing code",
        "linkedinUrl": "https://www.linkedin.com/in/shinjanpatra",
      },
      "isReshare": true,
      "reshared": null,
      "images": [
        {
          "url": "https://media.licdn.com/dms/image/v2/…/feedshare-shrink_1280/…",
          "variants": [
            { "width": 20, "height": 8, "url": "…" },
            { "width": 480, "height": 208, "url": "…" },
            { "width": 1179, "height": 513, "url": "…" },
          ],
        },
      ],
      "article": null,
      "video": false,
      "stats": {
        "likes": 69,
        "comments": 5,
        "shares": 3,
        "reactions": { "LIKE": 65, "APPRECIATION": 3, "INTEREST": 1 },
      },
    },
  ],
  "meta": {
    "source": "voyager",
    "fetchedAt": "…",
    "cached": false,
    "durationMs": 1810,
    "warnings": [],
  },
}
```

Note the second entry. It is a **plain repost**, and LinkedIn does not model it as a wrapper: the update it returns _is_ the original post. So `author` is the **original** author (Shinjan P, not the member whose activity was requested), `isReshare` is `true`, and `reshared` is `null`. The reposting member is not surfaced as a separate field; the fact that they reposted it is what `isReshare` records. `reshared` is populated only for a repost that adds its own commentary, where LinkedIn nests the original, and that shape is **unverified** (see [Known limitations](#known-limitations)).

Schema conventions:

- `count` echoes what was asked for, not how many came back; `posts.length` is the real number.
- `createdAt` is derived from the activity id, not from a field LinkedIn sends. See [Member posts](#member-posts).
- `stats` is `null` when the counts entity is missing; `stats.reactions` maps LinkedIn's reaction types (`LIKE`, `PRAISE`, `EMPATHY`, `APPRECIATION`, `INTEREST`, …) to counts.
- `reshared` never carries its own `reshared`: nesting stops at one level.
- The full schema is in [`src/schema/post.ts`](src/schema/post.ts).

### Errors

All errors share one envelope: `{ "error": { "code", "message", "details"? } }`.

| Status | `code`                            | When                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `INVALID_URL`                     | Wrong kind of LinkedIn URL for the endpoint. A company URL on `/v1/profile` says "use /v1/company"; an `/in/` URL on `/v1/company` says "use /v1/profile"                                                                                                                |
| 400    | `INVALID_REQUEST`                 | Missing/invalid `url` parameter, a `count` outside 1 to 50, or a body this API cannot accept (wrong `content-type`, malformed JSON, too large)                                                                                                                           |
| 404    | `NOT_FOUND`                       | No route matches that method and path. The message names them; the query string is not echoed back. Counted against the same budget as everything else, so 404s cannot be used to guess at URLs for free                                                                 |
| 404    | `PROFILE_NOT_FOUND`               | LinkedIn says the profile "can't be accessed": it doesn't exist or its visibility is restricted (LinkedIn does not distinguish the two). Also returned by `/v1/posts` for a member it cannot resolve                                                                     |
| 404    | `COMPANY_NOT_FOUND`               | Same, for a company or school page                                                                                                                                                                                                                                       |
| 429    | `RATE_LIMITED`                    | This API's per-IP limit, or LinkedIn's own. The local limiter **always** sets `Retry-After`, because it knows exactly when the window resets. When the 429 came from LinkedIn it is only passed through if LinkedIn sent one, so that case can arrive without the header |
| 400    | `INVALID_CODE`                    | The OTP code is wrong, expired, or its 5-attempt budget is spent (`/auth/verify`)                                                                                                                                                                                        |
| 401    | `UNAUTHENTICATED`                 | No valid `sid` cookie on a `/v1/*` or `/auth/me` request                                                                                                                                                                                                                 |
| 403    | `FORBIDDEN_ORIGIN`                | A mutating request's `Origin` header didn't match `APP_ORIGIN`                                                                                                                                                                                                           |
| 500    | `INTERNAL_ERROR`                  | An unhandled failure. Deliberately opaque; the diagnosis is in the log                                                                                                                                                                                                   |
| 502    | `UPSTREAM_ERROR` / `SCHEMA_DRIFT` | LinkedIn returned something we couldn't use (blocked request, 5xx, or a changed response shape). On `/v1/posts` a stale persisted-query hash surfaces here, with a message naming `VOYAGER_POSTS_QUERY_ID`                                                               |
| 502    | `MAIL_FAILED`                     | The code could not be mailed (SMTP error); the cause is logged, never returned                                                                                                                                                                                           |
| 503    | `LINKEDIN_SESSION_EXPIRED`        | The `LI_AT` cookie needs rotating                                                                                                                                                                                                                                        |

### `GET /health`

`{ "status": "ok", "uptimeSeconds": 123 }`: used by the container health check and Render.

---

## Approach: reverse engineering Voyager

LinkedIn's web app is a client of an internal REST API at `https://www.linkedin.com/voyager/api/`. Every profile section is fetched from it as JSON, so the most faithful way to "scrape" a profile is to ask the same API the page asks.

### What the page does

Loading a profile with DevTools open shows the app calling `/voyager/api/identity/dash/profiles` and `/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.…`. The `dash/profiles` endpoint takes a **decoration ID**, Voyager's term for a projection that says which fields and nested entities to include, and the LinkedIn client ships with a catalogue of them. Probing the endpoint from the page's own context (so the request carried real cookies) established which ones return what:

| Decoration                                                    | Returns                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `…profile.FullProfileWithEntities-101`                        | The whole profile graph: `Profile`, `PositionGroup`→`Position`, `Education`, `Skill` (first 20 only), `Certification`, `Language`, `VolunteerExperience`, `Project`, `Honor`, `Publication`, `Course`, plus the `Company`, `School`, `Industry` and `EmploymentType` entities they reference. ~115 KB. |
| `…profile.WebTopCardCore-16`                                  | The top card. Needed because the full decoration only carries the location as a `urn:li:fsd_geo:…` reference; this one includes the `Geo` entity with its `defaultLocalizedName`.                                                                                                                      |
| `/identity/dash/profileSkills?q=viewee&profileUrn=…&start=20` | Pages through skills beyond the inline cap of 20. The inline collection's `paging.total` says whether this is needed.                                                                                                                                                                                  |

The older, widely-documented endpoints (`/identity/profiles/{slug}/profileView`, `/skills`, `/profileContactInfo`) now return **410 Gone**; this project does not use them.

### Authentication and headers

Two cookies and one header are all Voyager needs:

- `li_at`: the real session cookie, issued at login. Supplied via env.
- `JSESSIONID` + `csrf-token`: LinkedIn uses the _double-submit_ CSRF pattern: the header must equal the cookie. The client uses the `JSESSIONID` LinkedIn issues during the session bootstrap (see [Getting `LI_AT`](#getting-li_at)); if the operator supplied `LI_COOKIES`, the browser's own value is used instead.
- `bcookie`, `bscookie`, `lidc`: companion cookies from the same bootstrap. Not needed for authorization, but their absence is the signal that gets a session revoked.
- `x-restli-protocol-version: 2.0.0` and `accept: application/vnd.linkedin.normalized+json+2.1`: these switch the response into Rest.li's _normalized_ format, described next.

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

### Company pages

Company pages are the one place this project deliberately does _not_ follow the web app. Loading `linkedin.com/company/anthropicresearch/` shows the app calling GraphQL `voyagerOrganizationDashCompanies.148b1aebfadd0a455f32806df656c3c1` with `variables=(universalName:anthropicresearch)`. This service uses the older REST decoration instead:

```
GET /voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=<name>
```

The trade is deliberate. A persisted-query hash is a build artifact of LinkedIn's front end and rotates with it; a decoration ID is a versioned server-side projection and this one has been stable for years. The GraphQL path is not implemented.

Two consequences of using the older endpoint:

- **The entity types are the legacy, non-`dash` family.** `com.linkedin.voyager.organization.Company` rather than a `…dash.organization.Company`, with `com.linkedin.voyager.common.Industry` (`localizedName`) reached through `*companyIndustries` and `com.linkedin.voyager.common.FollowingInfo` (`followerCount`) through `*followingInfo`. The rest of the codebase talks to `dash` types; `TYPES.legacyCompany` and friends in `types.ts` mark the boundary.
- **Images are shaped slightly differently.** `logo.image` and `backgroundCoverImage.image` are vector images directly, not wrapped in a `vectorImage` key the way profile images are. The same `image()` helper builds the renditions once it is handed the right object.

One trap: `included[]` carries the page's **showcase pages** as well, with the same `$type` and `showcase: true`. Taking the first entity of that type returns a showcase page rather than the company itself, so `normalizeCompany` resolves the target through `data['*elements']` and nothing else.

Schools use the same endpoint and the same entity type. `kind` is reported as `school` when the entity carries a `school` URN. This was verified against one school (`iithyderabad`); other schools are assumed to behave the same way, and that assumption is **unverified**.

### Member posts

Loading `/in/<slug>/recent-activity/all/` shows a single GraphQL call:

```
GET /voyager/api/graphql?includeWebMetadata=true&variables=(count:20,start:0,profileUrn:urn%3Ali%3Afsd_profile%3A<id>)&queryId=voyagerFeedDashProfileUpdates.20c70fe0314184158516a7ec004c0408
```

`variables` uses Rest.li's unquoted tuple syntax, so it is assembled by hand rather than by `URLSearchParams`. It wants the member's internal `profileUrn`, not the public slug, so `/v1/posts` first fetches the same `WebTopCardCore` decoration the profile route uses and reads the URN off it: two upstream requests per uncached call.

The response is a normalized graph like any other. `data.data.feedDashProfileUpdatesByMemberShareFeed['*elements']` lists `urn:li:fsd_update:(urn:li:activity:<id>,MEMBER_SHARES,…)`, and each `Update` carries `commentary.text.text` (the body), `actor.name.text` and `actor.description.text` (author name and headline), `actor.navigationContext.actionTarget` (the author's profile URL, with query noise this API strips), `socialContent.shareUrl`, `header.text.text`, and a `content` object in which every component key is present and all but one is `null`: `imageComponent`, `celebrationComponent`, `articleComponent`, `linkedInVideoComponent` and so on. `paging.total` on the collection is `0` and is ignored.

Three details cost more time than the rest:

- **The timestamp is inside the id.** No `Update` field carries a date. LinkedIn activity ids are Snowflake-style, so `activityId >> 22` is Unix milliseconds: `7390255662376824832` decodes to 2025-11-01, which matches the "9mo" label the page rendered next to it.
- **The counts hang off a different URN.** Likes, comments and shares live at `Update.*socialDetail` → `SocialDetail.*totalSocialActivityCounts` → `SocialActivityCounts{numLikes,numComments,numShares,reactionTypeCounts[]}`, and that last URN is keyed by `ugcPost` rather than `activity`. The graph has to be followed; rewriting the URN string does not work.
- **A plain repost is the original post.** LinkedIn does not wrap it in anything. The update _is_ the original author's post, marked only by `header.text.text = "<member> reposted this"`, with `resharedUpdate: null`. That is why a repost comes back with the original author in `author`, `isReshare: true` and `reshared: null`.

`resharedUpdate` (a nested `Update`) is what a repost _with added commentary_ is expected to use, and it is what `reshared` is built from, but no such post was present in the recorded sample: that path is **unverified**. `articleComponent` and `linkedInVideoComponent` were likewise absent, so `article` and `video` are parsed defensively (`articleComponent.navigationContext.actionTarget`, `.title.text`) and are **unverified** too.

### Re-capturing the posts `queryId`

Persisted-query hashes are the one volatile constant in the project: LinkedIn rotates them whenever the underlying query changes. A stale one comes back as a 400 or a 404, which `/v1/posts` reports as `502 SCHEMA_DRIFT` with a message naming the environment variable. Recovering takes a minute and no code change:

1. Open `https://www.linkedin.com/in/<any-slug>/recent-activity/all/` in a logged-in browser with DevTools on the **Network** tab.
2. Filter for `graphql?queryId=voyagerFeedDashProfileUpdates`.
3. The request URL ends in `voyagerFeedDashProfileUpdates.<hash>`. Copy the hash.
4. Set `VOYAGER_POSTS_QUERY_ID=<hash>` and restart.

The default is `20c70fe0314184158516a7ec004c0408`. The older hash `4af00b28d60ed0f1488018948daad822` was still accepted when this was captured, so LinkedIn evidently keeps retired hashes alive for a while.

### Failure handling

`interpretVoyagerResponse` maps every way LinkedIn can say no onto one typed error: a login redirect or HTML body means the session is dead (`503`), a 403 "can't be accessed" is a missing or restricted entity (`404`), 429 is passed through, carrying `Retry-After` only when LinkedIn itself sent one, 400 means the decoration ID or persisted query is no longer recognised (`SCHEMA_DRIFT`), and 999 is LinkedIn's bot-detection status. Only network errors and 5xx are retried, once.

Every request carries a small `RequestContext` (`{ kind: 'profile' | 'company' | 'posts', identifier }`), which is what lets the same 403 become `PROFILE_NOT_FOUND` or `COMPANY_NOT_FOUND` depending on what was being fetched. Recognising a stale posts hash is a separate mechanism: `fetchPostsBundle` wraps the feed request in a try/catch and rewrites a rejection as schema drift, because by then the top-card request has already proved the member exists.

---

## Architecture

```
HTTP (Fastify + zod)          src/server.ts, src/routes/{profile,company,posts}.ts
        │
        ▼
LinkedInService               src/linkedin/service.ts
  getProfile / getCompany / getPosts, one cache with namespaced keys, one semaphore
        │
        ▼
HttpVoyagerClient             src/linkedin/voyager/client.ts   ← cookies, CSRF, error mapping by entity kind
        │
        ▼
     fetchProfileBundle / fetchCompanyBundle / fetchPostsBundle
                               src/linkedin/voyager/endpoints.ts   ← every URL, decoration ID & queryId lives here
                 ▼
     EntityGraph → normalizeProfile | normalizeCompany | normalizePosts
                               src/linkedin/voyager/{graph,normalize,normalize-company,normalize-posts}.ts
                                              ▼
     zod ProfileResponse | CompanyResponse | PostsResponse
                               src/schema/{profile,company,post}.ts  ← types + validation + OpenAPI
```

Design points worth calling out:

- **One schema, three uses.** Each of `src/schema/{profile,company,post}.ts` is a zod schema. It gives the TypeScript types, validates every response before it leaves the service (a mismatch becomes a `meta.warnings` entry, not a 500), and generates the OpenAPI document served at `/docs`. The shared pieces (`Image`, `Meta`, `ErrorResponse`) live in `src/schema/common.ts`.
- **One service, three entities.** `LinkedInService` owns the cache and the semaphore for all three; cache keys are namespaced (`profile:<slug>`, `company:<name>`, `posts:<slug>:<count>`) so a posts lookup never collides with a profile of the same slug, and the count is part of the key because it changes the answer.
- **Failure mapping lives in one place.** `interpretVoyagerResponse` turns every LinkedIn response into either a parsed body or a typed error; the transport itself is a one-method interface so tests substitute a fake.
- **Volatile knowledge is quarantined.** Decoration IDs, URLs and the posts `queryId` default live only in `endpoints.ts`. When LinkedIn changes something, there is one file to touch and a fixture test to tell you what moved; the `queryId` is additionally overridable from the environment, so the most perishable constant needs no redeploy at all.
- **The account is protected.** Per-IP rate limiting, a 15-minute cache, and a concurrency semaphore (default 2) keep request volume to LinkedIn low even under a burst of API traffic. The semaphore bounds concurrent _bundles_, not upstream requests: a posts bundle is 2 requests and a profile is 2 or more, so the real ceiling on in-flight LinkedIn calls is a small multiple of the limit.
- **Order in `buildApp` is load-bearing.** Swagger UI is registered before helmet so the docs keep their looser CSP; the playground's static files are registered before the rate limiter so loading a page never spends the budget. `@fastify/static` runs with `wildcard: false` on purpose: its default `GET /*` would swallow every unmatched path and answer with `reply.callNotFound()`, which skips the not-found route's own hooks, so unknown URLs would come back unbudgeted. A route per file is registered instead, which is exact for a folder holding one file that is baked into the image.
- **Secrets never touch logs.** Cookie headers are redacted by pino; config is logged through `redactConfig`, which masks `LI_AT` and reports only the length of `LI_COOKIES`.

---

## Testing

```bash
pnpm test          # unit + integration, offline, ~1 s
pnpm test:live     # hits LinkedIn for real; needs LI_AT in the environment
pnpm typecheck && pnpm lint
```

- **Unit:** the profile and company URL parsing matrices, entity-graph resolution, each normaliser against hand-written fixtures that cover every branch (missing entities, capped skills, year-only dates, unknown enum values, a company with no industry or `followingInfo`, a showcase sibling in `included[]`, a repost via `header`, a reshare via `resharedUpdate`, missing social counts…), `activityIdToDate`, the bundle fetchers' warning and stale-hash paths, the HTTP client's error mapping (per entity kind) and session bootstrap with a mocked `fetch`, cache/semaphore, and the service.
- **Recorded fixtures:** `pnpm record-fixture <slug>` saves real Voyager responses (tracking noise stripped) under `tests/fixtures/voyager/<slug>/`; `pnpm record-fixture company <name>` and `pnpm record-fixture posts <slug>` do the same under `tests/fixtures/voyager/company/<name>/` and `tests/fixtures/voyager/posts/<slug>/`. `normalize.recorded.test.ts` runs the matching normaliser over every recorded entity and checks the output against the schema, this is the schema-drift alarm. Checked in so far: `company/anthropicresearch`, `company/iithyderabad`, `posts/sharmanityam`.
- **Integration:** the Fastify app via `app.inject`. `routes.test.ts` covers the entity routes, validation (including `count` 0 and 51 → 400), the error envelope and per-entity 404s, `Retry-After`, OpenAPI, the helmet CSP, and that the per-IP limit counts unknown routes while never counting the playground, `/health` or `/openapi.json`.
- **Live:** env-gated smoke tests against LinkedIn for a real profile (all sections present, skills paged past 20, unknown slug → 404), a company and a school, and a member's posts.

### CI

Two GitHub Actions workflows. [`ci.yml`](.github/workflows/ci.yml) runs `pnpm test`, `typecheck`, `lint` and `build` on every push to `main`, every pull request, and nightly. [`live.yml`](.github/workflows/live.yml) runs `pnpm test:live` against real LinkedIn, on `workflow_dispatch` and weekly; it's opt-in via the `LI_AT` repository secret and skips entirely when that secret is unset. Weekly rather than nightly because each run spends a handful of real LinkedIn requests against the account behind `LI_AT`.

---

## Deployment

The service ships as a small `node:22-slim` Docker image. Two stages: the build stage installs with pnpm, compiles, then prunes to production dependencies; the runtime stage copies `node_modules`, `dist` and `public` and runs as the unprivileged `node` user.

```bash
docker build -t linkedin-profile-api .
docker run --rm -p 3000:3000 -e LI_AT="$LI_AT" linkedin-profile-api
```

### Render

`render.yaml` describes the service. Connect the repo in the Render dashboard, create a Blueprint, and set `LI_AT` in Render as a secret environment variable (it is marked `sync: false`, so it is never read from the repo). Render provisions HTTPS automatically. `NODE_ENV`, `RATE_LIMIT_PER_MINUTE` and `CACHE_TTL_SECONDS` are set in the blueprint itself, since none of them is a secret.

The blueprint targets the **free** plan. Free instances sleep after 15 minutes of inactivity, so the first request after a pause takes ~30–50 s while the container wakes.

---

## Known limitations

**Terms of service and account risk.** Accessing LinkedIn through its private API with a personal session violates LinkedIn's User Agreement. The account behind `LI_AT` can be rate-limited, challenged or restricted. This project exists as a technical exercise; the rate limit, cache and concurrency cap are there to keep volume low, but they don't make it sanctioned.

**Session lifetime and revocation.** `li_at` expires (roughly yearly) and LinkedIn revokes it outright if it decides the session is being replayed from another client, see the note in [Getting `LI_AT`](#getting-li_at). The cookie bootstrap mitigates this; it doesn't eliminate it. Rotation is manual; the API reports `503 LINKEDIN_SESSION_EXPIRED` until it's done.

**404 conflates "missing" and "private".** LinkedIn returns the same 403 `"This profile can't be accessed"` for a non-existent slug and for a profile the account is not allowed to see. The API reports both as `PROFILE_NOT_FOUND`, or `COMPANY_NOT_FOUND` when a company or school page was the thing being fetched.

**Data is what the viewer can see.** Results reflect the visibility the scraping account has: out-of-network profiles may show fewer details, and LinkedIn may serve a subset of a profile to accounts it considers suspicious.

**Not exposed by the decorations used:** skill endorsement counts, contact info (email/phone/websites), a member's follower and connection counts, recommendations, featured posts, and comments or reactions on a post. A member's own posts are now available at `/v1/posts`, and a company's follower count at `/v1/company`. Adding any of the rest means finding its decoration or GraphQL `queryId` and extending `endpoints.ts` plus a normaliser.

**Skills are capped at 200** (paged in 50s) to bound request count.

**Decoration IDs are undocumented and versioned.** LinkedIn can retire `FullProfileWithEntities-101` or `WebFullCompanyMain-12` at any time; the symptom would be `SCHEMA_DRIFT` and failing recorded-fixture tests. The remedy is to capture the new ID from the web app and update one constant.

**The posts `queryId` rotates.** `/v1/posts` depends on a persisted-query hash, which LinkedIn regenerates whenever it changes the query. This is more perishable than a decoration ID, and the failure is loud: `502 SCHEMA_DRIFT` naming `VOYAGER_POSTS_QUERY_ID`. Recapturing it is a browser DevTools job and an env var, no redeploy, see [Re-capturing the posts `queryId`](#re-capturing-the-posts-queryid).

**Posts are the newest 50 at most, and there is no pagination.** `count` is clamped to 1 to 50 and the response is whatever LinkedIn returns from the top of the member's activity feed, newest first. LinkedIn does send a `metadata.paginationToken`, which v1 ignores; deeper history would mean threading that token through the service and the schema. `paging.total` on the feed is `0` and cannot be used as a count.

**The home feed is not exposed, by design.** `linkedin.com/feed/` would return whatever LinkedIn chose to show the account behind `LI_AT`, which is a property of that account rather than of any member the caller asked about. There is no endpoint for it and adding one is not planned.

**Parts of the posts shape are unverified.** The recorded sample contains ordinary posts, image posts and one plain repost. It contains no repost with added commentary, no article share and no native video, so the nested `resharedUpdate` shape behind `reshared`, and the `articleComponent` and `linkedInVideoComponent` parsing behind `article` and `video`, are written defensively from the field names LinkedIn exposes and have not been exercised against real data. Treat those three fields as best-effort until a fixture covers them.

**School handling is verified against one school.** `kind: "school"` is decided by the presence of a `school` URN on the company entity, checked against `iithyderabad`. Schools whose pages predate that field, or that LinkedIn models differently, may come back as `kind: "company"`. Unverified.

**Bot detection.** Requests come from a plain HTTP client, not a browser. LinkedIn can respond with HTTP 999 if it decides the client looks automated; the API reports that as `502 UPSTREAM_ERROR`. Sending the session's companion cookies and a realistic user agent keeps this rare, but not impossible.

**Image URLs expire.** Every image URL LinkedIn returns is signed (`?e=<unix-expiry>&v=beta&t=<sig>`), typically valid for weeks. A response served from the cache after that point contains dead image URLs; the playground falls back to a placeholder instead of a broken image, and API consumers should treat `url`/`variants` as short-lived. Only `media.licdn.com` renditions are emitted, but nothing in the normalisers filters by host: that guarantee is enforced by the recorded-fixture test, which fails if a cookie-gated `linkedin.com/dms/prv/` URL ever reaches a response.

**No persistence.** The cache is in-memory; a restart clears it. That's appropriate for this scope but means a multi-instance deployment would not share it.

**A per-IP rate limit is the only access control, and an IP is rented, not owned.** Nothing identifies a caller: `RATE_LIMIT_PER_MINUTE` is counted against the source address and nothing else. A datacentre proxy pool, a residential proxy service or a phone's flight-mode toggle all hand out a fresh address in seconds, and the budget resets with it, so the ceiling on what one determined caller can pull is that number times however many addresses they can cycle through. It also punishes the wrong people: an office, a university or a mobile carrier NAT puts thousands of unrelated users behind one address, and they share a budget none of them agreed to. What the limit actually buys is protection against a careless script, not against a determined one.

---

## License

MIT
