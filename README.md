# LinkedIn Profile API

A small HTTPS service that takes a LinkedIn URL and returns structured JSON. Three entities: a **member profile** (name, headline, location, about, experience, education, skills, certifications, languages, volunteering and images), a **company or school page**, and a **member's newest posts**.

It is a pure reverse-engineering of **Voyager**, the private JSON API that LinkedIn's own web app calls. Every request goes straight to LinkedIn's endpoints over HTTP; there is no browser, no HTML parsing and no third-party service involved.

```bash
curl -b jar "https://linkedin-profile-api-c925.onrender.com/v1/profile?url=https://www.linkedin.com/in/sharmanityam/"
curl -b jar "https://linkedin-profile-api-c925.onrender.com/v1/company?url=https://www.linkedin.com/company/anthropicresearch/"
curl -b jar "https://linkedin-profile-api-c925.onrender.com/v1/posts?url=https://www.linkedin.com/in/sharmanityam/&count=5"
```

The `/v1/*` endpoints are **account-gated**: they need a `sid` session cookie from a verified account, which is what `-b jar` above supplies. Getting one takes three requests and is described in [Accounts and access](#accounts-and-access). `/`, `/docs`, `/openapi.json`, `/health` and `/auth/*` stay public.

- **Live docs:** `https://linkedin-profile-api-c925.onrender.com/docs` (Swagger UI, generated from the response schema)
- **OpenAPI:** `https://linkedin-profile-api-c925.onrender.com/openapi.json`

---

## Contents

- [Quick start](#quick-start)
- [Accounts and access](#accounts-and-access)
  - [Why an account and not just a per-IP limit](#why-an-account-and-not-just-a-per-ip-limit)
  - [The flow](#the-flow)
  - [What each check proves, and what it does not](#what-each-check-proves-and-what-it-does-not)
- [API](#api)
  - [`POST /auth/signup`](#post-authsignup)
  - [`POST /auth/verify-email`](#post-authverify-email)
  - [`POST /auth/login`](#post-authlogin)
  - [`POST /auth/phone`](#post-authphone)
  - [`POST /auth/logout`](#post-authlogout)
  - [`GET /auth/me`](#get-authme)
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
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Quick start

Requirements: Node 22+, pnpm, and a LinkedIn account.

```bash
git clone https://github.com/SharmaNityam/linkedin-profile-api
cd linkedin-profile-api
pnpm install
cp .env.example .env                                  # then fill in LI_AT (see below)
echo "SESSION_KEY=$(openssl rand -hex 32)" >> .env    # required; signs the session cookie
pnpm dev                                              # http://localhost:3000/docs
```

Without `DATABASE_URL`, accounts live in the process and are lost on restart, which is fine for a local run; the startup log says so. To use a real database locally, set `DATABASE_URL` and run `pnpm migrate:dev` once.

`APP_ORIGIN` has to be the origin the **browser** is on, and it defaults to `http://localhost:3000`. Change `PORT` and it has to move with it — on `PORT=3200`, set `APP_ORIGIN=http://localhost:3200`, or every button in the playground that posts (sign up, verify, sign in, add a phone) comes back `403 FORBIDDEN_ORIGIN` while the page itself loads perfectly.

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

Everything the service reads is declared and validated in [`src/config.ts`](src/config.ts); an invalid environment fails the process at startup rather than at the first request.

| Variable | Default | Purpose |
|---|---|---|
| `LI_AT` | - | LinkedIn session cookie (required) |
| `LI_COOKIES` | - | Optional: the browser's `document.cookie` for linkedin.com, used instead of bootstrapping companion cookies |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `RATE_LIMIT_PER_MINUTE` | `10` | Requests per minute, keyed by **account** once signed in and by IP before that; protects the LinkedIn account behind the API |
| `CACHE_TTL_SECONDS` | `900` | In-memory cache for repeated lookups of the same entity |
| `MAX_CONCURRENT_UPSTREAM` | `2` | Concurrent requests to LinkedIn |
| `VOYAGER_POSTS_QUERY_ID` | `20c70fe0314184158516a7ec004c0408` | The `voyagerFeedDashProfileUpdates` persisted-query hash used by `/v1/posts`. LinkedIn rotates these; see [Re-capturing the posts `queryId`](#re-capturing-the-posts-queryid) |
| `LOG_LEVEL` | `info` | pino log level. `debug` is what prints verification codes locally, see [The flow](#the-flow) |

Accounts:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. Production additionally **requires** `DATABASE_URL`, `RESEND_API_KEY` and a non-localhost `APP_ORIGIN`, and puts `Secure` on the session cookie |
| `DATABASE_URL` | - | Postgres connection string. **Required when `NODE_ENV=production`.** Unset elsewhere means the in-memory repositories, with a startup warning. TLS is verified for every host except loopback, so a hosted database needs no extra flag and a local one needs no certificate. Any `sslmode`/`ssl` in the connection string is stripped, so the string cannot downgrade that |
| `SESSION_KEY` | - | **Required.** The session cookie's encryption key: 32 bytes as 64 hex characters, `openssl rand -hex 32`. Changing it invalidates every cookie in circulation |
| `APP_ORIGIN` | `http://localhost:3000` | The only `Origin` a `POST`/`PUT`/`PATCH`/`DELETE` may declare. Must be the public origin in production |
| `RESEND_API_KEY` | - | Resend key for the verification email. Unset falls back to writing the code to the log at `debug`, which is fine locally and **not** fine in production — so it is **required when `NODE_ENV=production`**, and the app refuses to start without it |
| `EMAIL_FROM` | `LinkedIn Profile API <onboarding@resend.dev>` | The `From:` header. Resend rejects sender domains it has not verified; the default shared sender needs none |
| `ABSTRACT_API_KEY` | - | Abstract Phone Validation v1 key. Unset means every number comes back `skipped` |
| `PHONE_VALIDATION_FAIL_MODE` | `open` | What to do when the provider gives no verdict (no key, no quota, its 5xx). `open` accepts and reports `phoneValidation: "skipped"`; `closed` rejects with `400 PHONE_REJECTED` |
| `ALLOWED_EMAIL_DOMAINS` | built-in list | Comma-separated override for the accepted mailbox providers. The built-in list is the consumer Google, Microsoft and Yahoo domains in [`src/auth/email-domains.ts`](src/auth/email-domains.ts) |
| `AUTH_RATE_LIMIT_PER_HOUR` | `20` | Per-IP hourly budget on `/auth/*`, the endpoints an anonymous caller can reach |
| `PASSWORD_HASHER` | `argon2` | Which algorithm new passwords are written with: `argon2` (argon2id, 19 MiB, t=2, p=1, native binding) or `scrypt` (N=2^17, pure node). Both verify either format, so switching re-hashes nothing and signs nobody out |

Secrets never reach the log: `redactConfig` masks `LI_AT`, `SESSION_KEY`, `RESEND_API_KEY` and `ABSTRACT_API_KEY` by length, and strips the password out of `DATABASE_URL` while leaving the host and database name readable.

---

## Accounts and access

### Why an account and not just a per-IP limit

Every request this API serves is a request to LinkedIn made with one real person's session cookie. The thing being rationed is not CPU, it is how suspicious that account looks to LinkedIn's abuse systems. So the budget has to attach to a *caller*, and a per-IP limit does not attach to anything durable:

- **An IP is rented, not owned.** A datacentre proxy pool, a residential proxy service or a phone's flight-mode toggle all hand out a fresh IP in seconds. The limit resets with it, so the ceiling on what one determined caller can pull is not `RATE_LIMIT_PER_MINUTE`, it is that number times however many addresses they can cycle through.
- **It punishes the wrong people.** An office, a university or a mobile carrier NAT puts thousands of unrelated users behind one address, and they share a budget none of them agreed to. Signed in, the budget follows the account across IPs instead, so those users stop colliding.
- **There is nobody to talk to.** When a caller does start pulling harder than the LinkedIn account can absorb, an IP is not a handle you can revoke; an account is.

Signing up is not free either, which is the point: a mailbox at an accepted provider, plus a distinct mobile number, is a real cost per identity. It does not make farming impossible. It makes it expensive enough to be worth someone's time rather than a loop.

### The flow

Three requests, then the `sid` cookie opens `/v1/*`. `curl` keeps that cookie in a jar: `-c jar` writes what the server sets, `-b jar` sends what is already there, and a step that needs both takes both.

Two things every state-changing request needs, and both are enforced (see [`src/auth/plugin.ts`](src/auth/plugin.ts)): either no `content-type` at all or one starting `application/json`, and either no `Origin` header at all (`curl`'s default) or one exactly equal to `APP_ORIGIN`. A browser form posting from somewhere else gets `403 FORBIDDEN_ORIGIN`; a form-encoded body gets `400 INVALID_REQUEST`, empty or not.

The origin check compares the whole origin, scheme and port included, so `APP_ORIGIN` must be exactly what the browser's address bar shows — `http://localhost:3200` when the server runs on `PORT=3200`, not the default `http://localhost:3000`. A mismatch is invisible until the first POST, which then fails with `403 FORBIDDEN_ORIGIN`; `curl`, which sends no `Origin`, keeps working throughout and will not reproduce it.

```bash
API=https://linkedin-profile-api-c925.onrender.com

# 1. Sign up. Answers the same way whether or not the address is already taken.
curl -X POST "$API/auth/signup" \
  -H 'content-type: application/json' \
  -d '{"email":"you@gmail.com","password":"a-long-enough-password"}'
# {"status":"verification_sent"}

# 2. Confirm the six-digit code from the email. This is what issues the cookie.
curl -c jar -X POST "$API/auth/verify-email" \
  -H 'content-type: application/json' \
  -d '{"email":"you@gmail.com","code":"860576"}'
# {"email":"you@gmail.com","emailVerified":true,"phoneVerified":false,"createdAt":"2026-08-28T07:44:33.776Z"}

# 3. Link a mobile number. Until this lands, /v1/* answers 403 PHONE_REQUIRED.
curl -c jar -b jar -X POST "$API/auth/phone" \
  -H 'content-type: application/json' \
  -d '{"phone":"+919876543210"}'
# {"email":"you@gmail.com","emailVerified":true,"phoneVerified":true,"createdAt":"…","phoneValidation":"skipped"}

# Now the data endpoints work, and the rate limit is counted against the account.
curl -b jar "$API/v1/profile?url=https://www.linkedin.com/in/sharmanityam/"
```

On a later day, `POST /auth/login` with the same email and password mints a fresh cookie; the signup and verify steps are not repeated. `GET /auth/me` reports where an account got to, which is how the playground decides which step to show.

Running locally without a `RESEND_API_KEY`, the code is not mailed anywhere: it is written to the log at `debug` level, so start the server with `LOG_LEVEL=debug` and read it off the `verification code` line.

```
{"level":20,…,"to":"you@gmail.com","code":"860576","msg":"verification code"}
```

The number in the example is Indian; any number `libphonenumber-js/max` accepts works, but the country code is not optional. There is no default country, because a bare `98765 43210` is a valid Indian mobile and nonsense elsewhere, and guessing would let two accounts claim one line from different regions.

### What each check proves, and what it does not

The honest version, because the gate is worth exactly what its weakest step is worth.

**Email verification proves control of a mailbox, and nothing else.** A six-digit code is generated, mailed, and stored only as a digest; confirming it is proof the person reading the mail is the person signing up. It says nothing about who they are. The two things that stop one mailbox becoming many accounts are the **domain allowlist** (consumer Google, Microsoft and Yahoo domains out of the box, overridable with `ALLOWED_EMAIL_DOMAINS`) and **canonicalisation**: for Google, `googlemail.com` folds to `gmail.com`, dots in the local part are stripped and everything after a `+` is dropped, so `j.o.h.n+api@googlemail.com` and `john@gmail.com` are one account. Every other provider is lowercased and left alone, so `john+tag@outlook.com` genuinely is a second address there. This limits alias farming. It does not end it, and a disposable-mailbox provider that Google, Microsoft or Yahoo happen to host would slip through.

**An account only exists once a code has come back.** An unverified signup is a row in `pending_signups`, not a user, and each submission keeps its own password. So there is no window in which a stranger's password is sitting on an address they do not control, and no ordering trick that hands them the account when the real owner verifies: the code decides, and the code goes to the mailbox. See [`POST /auth/signup`](#post-authsignup).

**Phone linking proves a number exists and looks like a mobile. It does not prove possession.** The number is normalised to E.164 with `libphonenumber-js/max` and is unique across accounts, so one line cannot back two of them. Abstract Phone Validation v1 then rejects anything it reports as `valid=false` or with a `type` other than `Mobile`. Nobody ever sends a message to that number, so a caller can supply a stranger's number, or a number from a list, and the check passes. The documented tier also **does not flag VoIP**, which is the cheap end of the number supply. **SMS OTP is the known next step**, and the reason it is not here is that it is not free.

**The provider's verdict is best-effort, and by default it fails open.** Abstract's free quota is small, so verdicts are cached in `phone_validations` and a number already paid for is never re-checked. A missing `ABSTRACT_API_KEY`, or a 402, 429 or 5xx from the provider, produces `skipped` rather than a rejection: with `PHONE_VALIDATION_FAIL_MODE=open` (the default) the signup continues and the response says so in `phoneValidation`, and with `closed` it is rejected instead. Choosing `open` is a deliberate trade: running out of credits should not lock out real users, and it means a caller who can exhaust the quota can walk past the phone filter entirely. A `skipped` is never cached, so one bad minute for the provider is not remembered forever. An answer, though, is cached **permanently**: `checked_at` is recorded and never read, so a number that was a mobile in 2026 stays accepted no matter what it is reassigned to later.

**Passwords are hashed, and that is the whole password policy.** Argon2id at OWASP's 2024 minimum by default, scrypt as a pure-node fallback, and the only rule on the password itself is 10 to 200 characters. Length is the rule because a composition rule mostly moves people to `Password1!`.

**The session is a cookie, and the server keeps no record of it.** `sid` carries authenticated encryption keyed by `SESSION_KEY`, and is `httpOnly`, `sameSite=lax`, `Secure` in production, valid 30 days and renewed on every request that resolves. Nothing is stored server-side, so there is no session table to revoke a single device from. What exists is `session_version` on the account: `POST /auth/logout {"everywhere": true}` bumps it and every cookie already issued stops resolving on its next request.

**And none of this launders the LinkedIn side.** An account gate rations who can ask; it does not make asking sanctioned. See [Known limitations](#known-limitations).

---

## API

Public: `GET /`, `GET /docs`, `GET /openapi.json`, `GET /health` and every `/auth/*` route. Everything under `/v1/` requires the `sid` session cookie of an account that has verified an email **and** linked a phone number; without one it answers `401 UNAUTHENTICATED`, and with a session that has not reached the phone step, `403 PHONE_REQUIRED`.

All six account endpoints are also in the Swagger UI at `/docs` under the `auth` tag, generated from the same zod schemas that validate them ([`src/schema/auth.ts`](src/schema/auth.ts)).

The four endpoints an anonymous caller can reach (`signup`, `verify-email`, `login`, `phone`) carry their own budget of `AUTH_RATE_LIMIT_PER_HOUR` (default 20) per IP per hour, keyed by IP rather than by account because at that point there is no account yet. Those are the ones worth hammering: address enumeration, code guessing, password spraying, and the mail provider's quota. The default is loosely set because the budget is shared by everyone behind one NAT, and a mistyped password or a code that arrived late should not lock a whole office out for an hour. `me` falls under the ordinary per-minute limit; `logout` is exempt from both, because being over budget must never trap someone in a session they cannot end.

### `POST /auth/signup`

Body `{"email": "…", "password": "…"}`. The address must be at an accepted provider and the password 10 to 200 characters.

Always answers `200 {"status": "verification_sent"}`, whether or not the address already has an account. That is deliberate: a distinguishable response would turn signup into an account-existence oracle, so the already-registered branch burns a password hash to keep the timing comparable. A code is only actually mailed when there is no account yet — and the send is **not** awaited on the response path, because a round trip to the mail provider is the one step whose duration would give the answer away no matter how the hashes are matched. What separates the two branches is now a hash and a couple of local writes. A send that fails is logged as a warning; the caller is told to check their mail either way and can sign up again.

Signing up does **not** create an account. It creates a row in `pending_signups`, holding the address as typed, that submission's password hash, that submission's code digest and its expiry — and it never touches another row. Verifying a code creates the account from the row that code belongs to, so the password that ends up on the account is always the one submitted alongside the code that came back.

That is what closes the pre-registration hijack. An attacker who signs up as `victim@gmail.com` gets their own pending row and their own code mailed to the victim's mailbox, which they cannot read; when the victim signs up and verifies with the code from their own mail, the account is created from the *victim's* row with the victim's password, whichever of the two submitted first. The attacker's row is deleted along with every other submission for the address, and their code verifies nothing afterwards. Order no longer decides anything; only the mailbox does.

One address may hold **5** pending submissions at a time — the oldest is dropped when a sixth arrives — and every one of them expires after 10 minutes.

`400 EMAIL_DOMAIN_NOT_ALLOWED` names the rejected domain. `400 INVALID_REQUEST` is a malformed address or an out-of-range password.

### `POST /auth/verify-email`

Body `{"email": "…", "code": "123456"}`. On success sets the `sid` cookie and returns the [`/auth/me`](#get-authme) shape.

The code is six digits, valid **10 minutes** and capped at **5 attempts**, counted per submission so that guessing at one pending row cannot spend the budget of the row the real owner is about to use. Every live submission for the address is tried, newest first, and the first one that matches becomes the account; verifying then deletes them all, so a code is single use and so is every code that was racing it. Wrong, expired and exhausted all come back as `400 INVALID_CODE`; the message distinguishes them (`expired` only when every submission has expired, `exhausted` only when every live one is out of attempts), since by that point the caller has already shown they know an address that was sent a code.

### `POST /auth/login`

Body `{"email": "…", "password": "…"}`. On success sets the cookie and returns the `/auth/me` shape.

An unknown address and a wrong password are both `401 INVALID_CREDENTIALS` with the same message, and the unknown-address path hashes anyway so response time does not separate the two. An address that has only been signed up for, never verified, is an unknown address here: it has no account to sign in to, and there is no `EMAIL_UNVERIFIED` state left for login to report.

### `POST /auth/phone`

Body `{"phone": "+919876543210"}`. Needs a session, which by construction means a verified address. Any readable form is accepted and normalised to E.164, but the country code is required.

```jsonc
{
  "email": "you@gmail.com",
  "emailVerified": true,
  "phoneVerified": true,
  "createdAt": "2026-08-28T07:44:33.776Z",
  "phoneValidation": "skipped"   // or "accepted"
}
```

`phoneValidation` is `accepted` when the provider confirmed a live mobile line and `skipped` when it gave no verdict at all and `PHONE_VALIDATION_FAIL_MODE` is `open`. `401 UNAUTHENTICATED` means no session, `400 INVALID_PHONE` a number `libphonenumber-js` will not parse, `400 PHONE_REJECTED` a number the provider says is not in service or not a mobile, and `409 PHONE_TAKEN` a number already linked to another account.

### `POST /auth/logout`

Body optional. `200 {"status": "signed_out"}`, and signing out when already signed out is a no-op rather than an error.

`{"everywhere": true}` additionally bumps the account's `session_version`, which invalidates every cookie already issued to it. Since sessions are stateless there is no other way to revoke one, and no way to revoke a single device.

### `GET /auth/me`

The signed-in account, or `401 UNAUTHENTICATED`.

```jsonc
{ "email": "you@gmail.com", "emailVerified": true, "phoneVerified": true, "createdAt": "2026-08-28T07:44:33.776Z" }
```

No ids, no hashes and no phone number: enough for a client to know which step of the flow the account is on, and nothing more.

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
      { "width": 400, "height": 400, "url": "…" }
    ]
  },
  "backgroundImage": {
    "url": "https://media.licdn.com/dms/image/v2/…/image-scale_191_1128/…",
    "variants": [
      { "width": 108, "height": 18, "url": "…" },
      { "width": 749, "height": 127, "url": "…" },
      { "width": 1128, "height": 191, "url": "…" }
    ]
  },
  "meta": { "source": "voyager", "fetchedAt": "…", "cached": false, "durationMs": 640, "warnings": [] }
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
        "linkedinUrl": "https://www.linkedin.com/in/sharmanityam"
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
        "reactions": { "LIKE": 53, "PRAISE": 8, "EMPATHY": 5 }
      }
    },
    {
      "urn": "urn:li:activity:7193517581419380736",
      "url": "https://www.linkedin.com/posts/shinjanpatra_working-on-something-interesting-…",
      "createdAt": "2024-05-07T07:50:40.504Z",
      "text": "Working on something interesting, will share once done. …",
      "author": {
        "name": "Shinjan P",
        "headline": "writing code",
        "linkedinUrl": "https://www.linkedin.com/in/shinjanpatra"
      },
      "isReshare": true,
      "reshared": null,
      "images": [
        {
          "url": "https://media.licdn.com/dms/image/v2/…/feedshare-shrink_1280/…",
          "variants": [
            { "width": 20, "height": 8, "url": "…" },
            { "width": 480, "height": 208, "url": "…" },
            { "width": 1179, "height": 513, "url": "…" }
          ]
        }
      ],
      "article": null,
      "video": false,
      "stats": {
        "likes": 69,
        "comments": 5,
        "shares": 3,
        "reactions": { "LIKE": 65, "APPRECIATION": 3, "INTEREST": 1 }
      }
    }
  ],
  "meta": { "source": "voyager", "fetchedAt": "…", "cached": false, "durationMs": 1810, "warnings": [] }
}
```

Note the second entry. It is a **plain repost**, and LinkedIn does not model it as a wrapper: the update it returns *is* the original post. So `author` is the **original** author (Shinjan P, not the member whose activity was requested), `isReshare` is `true`, and `reshared` is `null`. The reposting member is not surfaced as a separate field; the fact that they reposted it is what `isReshare` records. `reshared` is populated only for a repost that adds its own commentary, where LinkedIn nests the original, and that shape is **unverified** (see [Known limitations](#known-limitations)).

Schema conventions:

- `count` echoes what was asked for, not how many came back; `posts.length` is the real number.
- `createdAt` is derived from the activity id, not from a field LinkedIn sends. See [Member posts](#member-posts).
- `stats` is `null` when the counts entity is missing; `stats.reactions` maps LinkedIn's reaction types (`LIKE`, `PRAISE`, `EMPATHY`, `APPRECIATION`, `INTEREST`, …) to counts.
- `reshared` never carries its own `reshared`: nesting stops at one level.
- The full schema is in [`src/schema/post.ts`](src/schema/post.ts).

### Errors

All errors share one envelope: `{ "error": { "code", "message", "details"? } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_URL` | Wrong kind of LinkedIn URL for the endpoint. A company URL on `/v1/profile` says "use /v1/company"; an `/in/` URL on `/v1/company` says "use /v1/profile" |
| 400 | `INVALID_REQUEST` | Missing/invalid `url` parameter, a `count` outside 1 to 50, a malformed account body, a password outside 10 to 200 characters, or a state-changing request whose `content-type` is not `application/json` |
| 400 | `EMAIL_DOMAIN_NOT_ALLOWED` | The address is not at one of the accepted mailbox providers. `details.domain` names the one that was rejected |
| 400 | `INVALID_CODE` | The verification code is wrong, expired, or its 5 attempts are spent. The message says which |
| 400 | `INVALID_PHONE` | The number could not be parsed as a valid E.164 number. Usually a missing country code |
| 400 | `PHONE_REJECTED` | The validation provider reports the number as not in service or not a mobile line. Also what `PHONE_VALIDATION_FAIL_MODE=closed` returns when the provider gave no verdict |
| 401 | `UNAUTHENTICATED` | No `sid` cookie, or one whose account is gone or whose sessions were revoked. `/v1/*` and `/auth/me` |
| 401 | `INVALID_CREDENTIALS` | Wrong password, or an address with no account. Identical either way, by design |
| 403 | `PHONE_REQUIRED` | Signed in, but no phone number is linked yet, so `/v1/*` is still closed |
| 403 | `FORBIDDEN_ORIGIN` | A state-changing request declared an `Origin` other than `APP_ORIGIN` |
| 404 | `NOT_FOUND` | No route matches that method and path. The message names them; the query string is not echoed back. Counted against the same budget as everything else, so 404s cannot be used to guess at URLs for free |
| 404 | `PROFILE_NOT_FOUND` | LinkedIn says the profile "can't be accessed": it doesn't exist or its visibility is restricted (LinkedIn does not distinguish the two). Also returned by `/v1/posts` for a member it cannot resolve |
| 404 | `COMPANY_NOT_FOUND` | Same, for a company or school page |
| 409 | `PHONE_TAKEN` | That number is already linked to a different account |
| 429 | `RATE_LIMITED` | The per-account (or, signed out, per-IP) limit on `/v1/*`, the per-IP hourly limit on `/auth/*`, or LinkedIn's own limit. Always with `Retry-After` |
| 500 | `INTERNAL_ERROR` | An unhandled failure. Deliberately opaque; the diagnosis is in the log. A mail provider that will not accept the verification email is **not** one of these: the send is off the response path, so it is a logged warning and signup still answers `200` |
| 502 | `UPSTREAM_ERROR` / `SCHEMA_DRIFT` | LinkedIn returned something we couldn't use (blocked request, 5xx, or a changed response shape). On `/v1/posts` a stale persisted-query hash surfaces here, with a message naming `VOYAGER_POSTS_QUERY_ID` |
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

### Company pages

Company pages are the one place this project deliberately does *not* follow the web app. Loading `linkedin.com/company/anthropicresearch/` shows the app calling GraphQL `voyagerOrganizationDashCompanies.148b1aebfadd0a455f32806df656c3c1` with `variables=(universalName:anthropicresearch)`. This service uses the older REST decoration instead:

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
- **A plain repost is the original post.** LinkedIn does not wrap it in anything. The update *is* the original author's post, marked only by `header.text.text = "<member> reposted this"`, with `resharedUpdate: null`. That is why a repost comes back with the original author in `author`, `isReshare: true` and `reshared: null`.

`resharedUpdate` (a nested `Update`) is what a repost *with added commentary* is expected to use, and it is what `reshared` is built from, but no such post was present in the recorded sample: that path is **unverified**. `articleComponent` and `linkedInVideoComponent` were likewise absent, so `article` and `video` are parsed defensively (`articleComponent.navigationContext.actionTarget`, `.title.text`) and are **unverified** too.

### Re-capturing the posts `queryId`

Persisted-query hashes are the one volatile constant in the project: LinkedIn rotates them whenever the underlying query changes. A stale one comes back as a 400 or a 404, which `/v1/posts` reports as `502 SCHEMA_DRIFT` with a message naming the environment variable. Recovering takes a minute and no code change:

1. Open `https://www.linkedin.com/in/<any-slug>/recent-activity/all/` in a logged-in browser with DevTools on the **Network** tab.
2. Filter for `graphql?queryId=voyagerFeedDashProfileUpdates`.
3. The request URL ends in `voyagerFeedDashProfileUpdates.<hash>`. Copy the hash.
4. Set `VOYAGER_POSTS_QUERY_ID=<hash>` and restart.

The default is `20c70fe0314184158516a7ec004c0408`. The older hash `4af00b28d60ed0f1488018948daad822` was still accepted when this was captured, so LinkedIn evidently keeps retired hashes alive for a while.

### Failure handling

`interpretVoyagerResponse` maps every way LinkedIn can say no onto one typed error: a login redirect or HTML body means the session is dead (`503`), a 403 "can't be accessed" is a missing or restricted entity (`404`), 429 is passed through with `Retry-After`, 400 means the decoration ID or persisted query is no longer recognised (`SCHEMA_DRIFT`), and 999 is LinkedIn's bot-detection status. Only network errors and 5xx are retried, once.

Every request carries a small `RequestContext` (`{ kind: 'profile' | 'company' | 'posts', identifier }`), which is what lets the same 403 become `PROFILE_NOT_FOUND` or `COMPANY_NOT_FOUND` depending on what was being fetched. Recognising a stale posts hash is a separate mechanism: `fetchPostsBundle` wraps the feed request in a try/catch and rewrites a rejection as schema drift, because by then the top-card request has already proved the member exists.

---

## Architecture

```
HTTP (Fastify + zod)          src/server.ts
        │
        ├── authPlugin        src/auth/plugin.ts   ← sid cookie, request.currentUser, CSRF origin + content-type
        │      │                                     runs on onRequest, before the rate limiter keys by account
        │      ▼
        │   /auth/*           src/routes/auth.ts + src/schema/auth.ts   ← bodies in, AppError or a session out
        │      │
        │      ▼
        │   AuthService       src/auth/service.ts   ← every account rule: allowlist, canonical email, codes,
        │      │                                      phone verdict + fail mode, session claims
        │      ▼
        │   Repositories      src/auth/repositories.ts   ← one interface, two implementations
        │      ├── postgres.ts  (pg pool, migrations/*.sql applied by src/db/migrate.ts)
        │      └── memory.ts    (tests and a DATABASE_URL-less local run)
        │   Collaborators     password.ts (argon2 | scrypt), codes.ts, email.ts, email-domains.ts,
        │                     phone.ts, phone-validation.ts (Abstract), mailer.ts (Resend | log)
        │
        └── requireAccount    src/auth/plugin.ts   ← one encapsulated context wraps all three /v1 routes
               │
               ▼
        /v1/*                 src/routes/{profile,company,posts}.ts
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
- **The account is protected.** Per-account rate limiting (per IP until someone signs in), a 15-minute cache, and a concurrency semaphore (default 2) keep request volume to LinkedIn low even under a burst of API traffic. The semaphore bounds concurrent *bundles*, not upstream requests: a posts bundle is 2 requests and a profile is 2 or more, so the real ceiling on in-flight LinkedIn calls is a small multiple of the limit.
- **The gate is stated once.** `requireAccount` is a `preHandler` on a single encapsulated Fastify context that wraps all three `/v1` routes, so a fourth entity route inherits it rather than having to remember it. `authPlugin` itself is registered with `fastify-plugin` on purpose: its `onRequest` hook has to resolve `request.currentUser` *before* `@fastify/rate-limit`'s own hook reads it, and encapsulating it would silently key every limit by IP. That hook only looks at the session for paths under `/v1/` or `/auth/`: the playground, the docs, `/openapi.json` and `/health` are public, so a cookie sent with them buys nothing and would otherwise cost a database round trip and a refreshed `Set-Cookie` on every asset the page loads.
- **Order in `buildApp` is load-bearing.** Swagger UI is registered before helmet so the docs keep their looser CSP; the playground's static files are registered before the rate limiter so loading a page never spends the budget; the auth plugin sits before the limiter for the reason above. `@fastify/static` runs with `wildcard: false` on purpose: its default `GET /*` would swallow every unmatched path and answer with `reply.callNotFound()`, which skips the not-found route's own hooks, so unknown URLs would come back unbudgeted. A route per file is registered instead, which is exact for a folder holding one file that is baked into the image.
- **Account rules live in one class.** `AuthService` owns the allowlist, canonicalisation, code lifecycle, phone verdicts and session claims; the routes only map a body in and an `AppError` or a session cookie out. The same flow is therefore testable without a server, and the storage behind it is an interface with a Postgres and an in-memory implementation.
- **Secrets never touch logs.** Cookie headers are redacted by pino; config is logged through `redactConfig`, which masks `LI_AT`, `SESSION_KEY` and both API keys and strips the password from `DATABASE_URL`.

---

## Testing

```bash
pnpm test          # unit + integration, offline, ~1 s
pnpm test:live     # hits LinkedIn for real; needs LI_AT in the environment
pnpm typecheck && pnpm lint
```

- **Unit:** the profile and company URL parsing matrices, entity-graph resolution, each normaliser against hand-written fixtures that cover every branch (missing entities, capped skills, year-only dates, unknown enum values, a company with no industry or `followingInfo`, a showcase sibling in `included[]`, a repost via `header`, a reshare via `resharedUpdate`, missing social counts…), `activityIdToDate`, the bundle fetchers' warning and stale-hash paths, the HTTP client's error mapping (per entity kind) and session bootstrap with a mocked `fetch`, cache/semaphore, and the service.
- **Recorded fixtures:** `pnpm record-fixture <slug>` saves real Voyager responses (tracking noise stripped) under `tests/fixtures/voyager/<slug>/`; `pnpm record-fixture company <name>` and `pnpm record-fixture posts <slug>` do the same under `tests/fixtures/voyager/company/<name>/` and `tests/fixtures/voyager/posts/<slug>/`. `normalize.recorded.test.ts` runs the matching normaliser over every recorded entity and checks the output against the schema, this is the schema-drift alarm. Checked in so far: `company/anthropicresearch`, `company/iithyderabad`, `posts/sharmanityam`.
- **Accounts:** `tests/unit/auth/` covers the pieces in isolation, each against the rule it owns: email canonicalisation and the domain allowlist, phone normalisation, the Abstract client with a mocked `fetch` (mobile accepted, landline rejected, no key or a provider error to `skipped`), both hashers and their cross-format verification, code expiry and the attempt cap, the mailer, and the in-memory repositories (including that pending signups list newest first and that deleting by address touches only that address). `tests/unit/auth/password-scrypt-only.test.ts` is the one that matters for portability: it proves the scrypt path never imports the argon2 native addon. `tests/integration/auth.test.ts` drives the whole flow through the app.
- **Integration:** the Fastify app via `app.inject`. `routes.test.ts` covers the entity routes, validation (including `count` 0 and 51 → 400), the error envelope and per-entity 404s, `Retry-After` and OpenAPI. `auth.test.ts` covers the flow end to end (signup → verify → phone → `/v1/profile`), a repeat signup on a registered address keeping its password, two signups racing for one address in both orders (the code the victim received wins either way), the 5-submission cap, a duplicate phone number, both CSRF guards, logout and logout-everywhere, and that the limit is counted per account rather than per IP while the playground and `/health` are never counted at all.
- **Database:** `tests/db/postgres.test.ts` runs the real repositories against Postgres and is skipped unless `DATABASE_URL` is set, so `pnpm test` stays offline by default.
- **Live:** env-gated smoke tests against LinkedIn for a real profile (all sections present, skills paged past 20, unknown slug → 404), a company and a school, and a member's posts.

---

## Deployment

The service ships as a small `node:22-slim` Docker image. Two stages: the build stage installs with pnpm, compiles, then prunes to production dependencies; the runtime stage copies `node_modules`, `dist`, `public` and `migrations` and runs as the unprivileged `node` user.

```bash
docker build -t linkedin-profile-api .

# Production-shaped: the image sets NODE_ENV=production, which requires a
# database and a real origin.
docker run --rm -p 3000:3000 \
  -e LI_AT="$LI_AT" \
  -e SESSION_KEY="$(openssl rand -hex 32)" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e APP_ORIGIN=https://linkedin-profile-api-c925.onrender.com \
  linkedin-profile-api

# Or, to try the image with in-memory accounts and no database at all:
docker run --rm -p 3000:3000 \
  -e NODE_ENV=development -e LI_AT="$LI_AT" -e SESSION_KEY="$(openssl rand -hex 32)" \
  linkedin-profile-api
```

The container's `CMD` applies migrations and then starts the server, guarded so that the second form still boots:

```sh
if [ -n "$DATABASE_URL" ]; then node dist/db/migrate.js; fi && node dist/main.js
```

`dist/db/migrate.js` (`pnpm migrate`) applies every `migrations/*.sql` not already recorded in `schema_migrations`, in filename order, each in its own transaction, behind a Postgres advisory lock so two instances booting at once cannot both apply the same file. It is idempotent, so running it on every boot costs one round trip when there is nothing to do. It requires `DATABASE_URL`, and refuses to run without one, which is what the guard is for.

**Neither `argon2` nor `sodium-native` is compiled at image build time.** `node:22-slim` has no compiler, and does not need one: `argon2` resolves a prebuilt `linux-x64` binding through `node-gyp-build`, and `sodium-native` (which `@fastify/secure-session` uses) ships prebuilds and is never built at all. `pnpm-workspace.yaml` has to allow `argon2`'s install script (`allowBuilds`) for that resolution step to run, so it is copied into the build stage alongside `package.json`. If a future dependency does need a compiler, install `python3 make g++` in the **build** stage only, never the runtime one.

### Database: Neon

1. Create a project at [neon.tech](https://neon.tech) (free tier).
2. Copy the **pooled** connection string, the one whose host contains `-pooler`. Render's free instances restart often and Neon's free tier allows few direct connections; the pooler is what keeps a redeploy from exhausting them. The application's own `pg` pool is capped at 5 on top of that.
3. Set it as `DATABASE_URL`. TLS is on and verified for any non-loopback host, which is what Neon wants, so nothing needs to be appended to the URL and `sslmode=require` is harmless if it is already there.
4. Nothing else to do: the container runs the migrations on its next boot.

**Why not Render's own free Postgres.** Render deletes a free database 30 days after it is created, with no upgrade path that preserves it. That is an unrecoverable data loss with a calendar on it, which is a strange property for the thing holding the accounts. Neon's free tier has no such expiry; it suspends an idle database instead and wakes it on the next connection.

### Render

`render.yaml` describes the service. Connect the repo in the Render dashboard, create a Blueprint, and set the secrets. Render provisions HTTPS automatically.

Marked `sync: false`, so Render prompts for them once and they are never read from the repo:

| Secret | Needed for | If unset |
|---|---|---|
| `LI_AT` | Every LinkedIn call | The service will not start |
| `DATABASE_URL` | Accounts | The service will not start (`NODE_ENV=production` requires it) |
| `SESSION_KEY` | The session cookie | The service will not start. `openssl rand -hex 32` |
| `RESEND_API_KEY` | Mailing verification codes | The service will not start (`NODE_ENV=production` requires it, so codes are never written to the log there) |
| `ABSTRACT_API_KEY` | Filtering non-mobile numbers | Every number is `skipped` and, under the default fail-open, accepted |

Set in the blueprint itself, since none of them is a secret: `NODE_ENV=production`, `APP_ORIGIN=https://linkedin-profile-api-c925.onrender.com` (production refuses to start on a localhost origin), `EMAIL_FROM`, `PHONE_VALIDATION_FAIL_MODE=open`, `AUTH_RATE_LIMIT_PER_HOUR=20`, `PASSWORD_HASHER=argon2`, `RATE_LIMIT_PER_MINUTE=10`, `CACHE_TTL_SECONDS=900`.

`APP_ORIGIN` has to match the origin the playground is actually served from, or every state-changing request the page makes is rejected with `403 FORBIDDEN_ORIGIN`. If the service is renamed or moved to a custom domain, that value moves with it.

The blueprint targets the **free** plan. Free instances sleep after 15 minutes of inactivity, so the first request after a pause takes ~30–50 s while the container wakes. Signed-in sessions survive that, because the cookie is the session.

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

### Accounts

**Phone possession is not proven.** Linking a number establishes that it exists, that it is unique in this system, and that a provider calls it a mobile. Nothing is ever sent to it, so a caller can supply a number they do not hold. **SMS OTP is the next step** and the only reason it is not here is cost. The provider's documented tier also does not flag VoIP, which is where cheap numbers come from.

**The phone filter has a small quota and fails open.** Abstract's free tier is limited, and a missing key or a 402/429/5xx produces `skipped` rather than a rejection, which under the default `PHONE_VALIDATION_FAIL_MODE=open` accepts the number. So a caller who can exhaust the quota can walk past the filter entirely. `closed` trades that for locking out real users during a provider outage. Neither is right; `open` is the one chosen.

**Cached phone verdicts never expire.** `phone_validations` stores the answer per number and `checked_at` is written but never read, so a verdict from today still stands in five years. Numbers get disconnected and reassigned; this will not notice. A TTL on that column is the obvious fix and is not implemented.

**Sessions are stateless, so revocation is coarse.** The `sid` cookie is self-contained; nothing about it is stored server-side. There is no list of active sessions, no way to sign out one device, and no way to invalidate a cookie before its 30 days are up except `POST /auth/logout {"everywhere": true}`, which bumps `session_version` and drops **every** session on the account at once. A stolen cookie is valid until one of those happens or `SESSION_KEY` is rotated, which signs out everyone.

**In-memory mode loses every account on restart.** With no `DATABASE_URL` the repositories are process memory. `NODE_ENV=production` refuses to start in that state, and outside production the startup log warns, so this is only ever a local surprise. It is still a surprise.

**The verification code digest is unsalted sha256.** Six digits is a million-entry space, so every possible digest can be precomputed in seconds; the hash gives essentially no protection against someone who can already read the `pending_signups` table. What actually protects a code is that it expires in 10 minutes, allows 5 attempts, and is deleted on use. A slow KDF there would add latency to every verification and buy nothing, so this is a deliberate choice rather than an oversight, but it does mean database read access is equivalent to code access.

**Pending signups are capped at 5 per address and expire after 10 minutes.** Every submission is kept as its own row, so something has to bound the table: a sixth submission for one address evicts the oldest, and expired rows are swept on the next signup. Both numbers are fixed in `src/auth/service.ts`, not configurable. Someone who submits six signups for an address they do not own therefore invalidates the code a real owner requested first — which costs the owner one more signup, and is the price of never letting a later submission take over an earlier one's password.

**Nothing rate-limits an account's creation beyond the mailbox and the number.** `AUTH_RATE_LIMIT_PER_HOUR` is itself keyed by IP — the very thing the account gate exists because it cannot be trusted. The same address rotation that defeats a per-IP read limit resets this counter too, so it paces a casual signup script and no more. What actually bounds farming is the supply of accepted-provider mailboxes and, above all, distinct mobile numbers: the phone is unique across accounts, so each identity costs a number nobody else is using.

**Email deliverability is Resend's shared sender by default.** `EMAIL_FROM` points at `onboarding@resend.dev`, which works without a verified domain and lands in spam more often than a domain you own. A verification code nobody sees is indistinguishable from a broken signup.

---

## License

MIT
