# Design: account-gated API

Date: 2026-08-27. Lands after company/posts and playground images.

## Goal
Replace "per-IP rate limit only" with: signup → email code → phone (normalised, unique, Abstract-filtered) → session cookie → `/v1/*` access, rate-limited **per account**. `/`, `/docs`, `/openapi.json`, `/health`, `/auth/*` stay public.

## Threat model and honest limits
- Email verification proves mailbox control; the domain allowlist (consumer Google/Microsoft/Yahoo domains, env override) plus canonicalisation (`gmail`: strip dots and `+tag`, `googlemail→gmail`; others: lowercase) limits farming via aliases.
- Phone is normalised to E.164 with `libphonenumber-js/max` and unique. Abstract Phone Validation v1 rejects `valid=false` or `type!=Mobile`; it does **not** prove possession and does not flag VoIP on the documented tier. SMS OTP is the known next step (not free).
- Abstract quota is small: verdicts cached in `phone_validations`; missing key or 402/429/5xx → `skipped` and the signup continues when `PHONE_VALIDATION_FAIL_MODE=open` (default), rejected when `closed`. `meta.phoneValidation: 'accepted'|'skipped'` in the `/auth/phone` response.

## Storage
Neon Postgres (free tier, no 30-day expiry) via `pg`; `migrations/NNNN_*.sql` applied by `pnpm migrate` (`src/db/migrate.ts`, tracked in `schema_migrations`). Container `CMD` runs migrate then the server. Repositories behind interfaces with an in-memory implementation for tests/dev (`DATABASE_URL` unset → memory, with a startup warning). Tables:
```
users(id uuid pk, email text, email_canonical text unique, email_verified_at timestamptz,
      password_hash text, phone_e164 text unique null, phone_verified_at timestamptz,
      session_version int default 0, created_at timestamptz default now())
email_verifications(user_id uuid pk references users, code_hash text, expires_at timestamptz, attempts int default 0)
phone_validations(phone_e164 text pk, provider text, valid bool, type text, raw jsonb, checked_at timestamptz)
```

## Auth flow (`src/routes/auth.ts`)
| Route | Body | Behaviour |
|---|---|---|
| `POST /auth/signup` | `{email,password}` | domain allowlist → `400 EMAIL_DOMAIN_NOT_ALLOWED`; password ≥ 10 chars; if canonical email is new: create user + code (6 digits, sha256 at rest, 10 min, 5 attempts) + mail; if it exists: re-send only when unverified. Always `200 {status:'verification_sent'}`. Per-IP `AUTH_RATE_LIMIT_PER_HOUR`. |
| `POST /auth/verify-email` | `{email,code}` | `400 INVALID_CODE` (wrong/expired/attempts exhausted, message says which); success sets `email_verified_at`, issues the session cookie, returns `/auth/me` shape. |
| `POST /auth/phone` | `{phone}` | needs verified-email session (`401 UNAUTHENTICATED`); `400 INVALID_PHONE`; `409 PHONE_TAKEN`; Abstract verdict; sets `phone_e164`, `phone_verified_at`. |
| `POST /auth/login` | `{email,password}` | `401 INVALID_CREDENTIALS` (same for unknown email); unverified email → `403 EMAIL_UNVERIFIED`; success issues cookie. |
| `POST /auth/logout` | – | clears cookie. `{everywhere:true}` bumps `session_version`. |
| `GET /auth/me` | – | `{ email, emailVerified, phoneVerified, createdAt }` or 401. |

Session: `@fastify/secure-session` cookie `sid` `{userId, sessionVersion, issuedAt}`, `httpOnly`, `sameSite: 'lax'`, `secure` when `NODE_ENV=production`, `path: '/'`, `maxAge` 30 d, rolling. Key `SESSION_KEY` (64 hex chars). `requireAccount` hook on `/v1/*`: loads user, checks `sessionVersion`, `401 UNAUTHENTICATED` / `403 PHONE_REQUIRED`.

Password hashing: `PasswordHasher` interface; `Argon2Hasher` (argon2id, 19 MiB, t=2, p=1) default; `ScryptHasher` (N=2^17, r=8, p=1, maxmem 256 MiB) selectable with `PASSWORD_HASHER=scrypt` if the argon2 binary is unavailable. Both verify each other's hashes by prefix (`$argon2id$` / `$scrypt$`).

CSRF: `onRequest` hook for non-GET/HEAD/OPTIONS: if `Origin` present and ≠ `APP_ORIGIN` → `403 FORBIDDEN_ORIGIN`; `content-type` must start with `application/json` → else `400 INVALID_REQUEST`. No `@fastify/cors`. Helmet CSP: `default-src 'self'; img-src 'self' https://media.licdn.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'` (the playground's inline script/styles), swagger-ui gets its own relaxed CSP via `@fastify/swagger-ui`'s `staticCSP`.

Rate limiting: global `@fastify/rate-limit` `keyGenerator: userId ?? ip`, `allowList` for `/health`, `/openapi.json`, `/docs*`; static registered **before** rate-limit so `/` and assets are never counted. `/auth/*` routes carry `config.rateLimit = { max: AUTH_RATE_LIMIT_PER_HOUR, timeWindow: '1 hour', keyGenerator: ip }`.

## Config
`DATABASE_URL` (required in production), `SESSION_KEY` (required), `APP_ORIGIN` (required in production, default `http://localhost:3000`), `RESEND_API_KEY`, `EMAIL_FROM`, `ABSTRACT_API_KEY`, `PHONE_VALIDATION_FAIL_MODE=open|closed`, `ALLOWED_EMAIL_DOMAINS`, `AUTH_RATE_LIMIT_PER_HOUR=5`, `PASSWORD_HASHER=argon2|scrypt`. `redactConfig` masks all secrets. `render.yaml`: every secret `sync: false`.

## Playground
Auth panel under the header: signed-out (email+password → "Sign up" / "Log in"), code step, phone step, signed-in chip with email + "Log out". Loaded via `/auth/me`. A `401`/`403 PHONE_REQUIRED` from `/v1/profile` opens the panel at the right step. Same visual language, single file.

## Tests
Unit: canonical email matrix, allowlist, phone normalisation, Abstract client (mocked fetch: mobile accept, landline reject, 429/missing key → skipped/open vs rejected/closed), hashers, codes (expiry, attempts), session-version revocation. Integration (memory repos, `LogMailer`, fake validator): happy path to `/v1/profile` 200; unverified → 401; no phone → 403; duplicate canonical email → generic 200; duplicate phone → 409; per-user limit independent across two users on one IP; cross-origin POST → 403; `GET /` and `/health` unlimited. `tests/db/postgres.test.ts` gated on `DATABASE_URL`.

## Amendment 2026-08-28

**`pending_signups` replaces `email_verifications`.** As designed above, an unverified signup was a `users` row and a repeat signup overwrote its password hash, so the *last* submission before verification won. An attacker who signed up as `victim@gmail.com` after the victim — any time inside the code window — owned the account the moment the victim verified with their own newest code. The fix is structural rather than a check: a signup no longer creates a user at all.

```
pending_signups(id uuid pk, email text, email_canonical text, password_hash text,
                code_hash text, expires_at timestamptz, attempts int default 0,
                created_at timestamptz default now())   -- index on (email_canonical)
users.email_verified_at is now NOT NULL
```

`migrations/0002_pending_signups.sql` creates the table, drops `email_verifications`, and makes `users.email_verified_at` not null (backfilled from `created_at` first, defensively; the table was empty everywhere).

- **Signup** canonicalises, checks the allowlist and the password policy, and returns early (burning a hash) if an account already exists. Otherwise it inserts one `pending_signups` row per submission — never updating another — caps the address at 5 rows by dropping the oldest, sweeps expired rows, and mails the code. The mail is not awaited on the response path.
- **verify-email** lists the address's rows newest first and tries each live one: the first `ok` creates the user with *that row's* password hash and `email_verified_at = now`, then deletes every row for the address. A `mismatch` increments that row's attempts only. `expired` is reported only when every row has expired, `exhausted` only when every live row is out of attempts, `incorrect` otherwise. Losing the create race (another submission verified first) is reported as `INVALID_CODE`.
- **login** has no `EMAIL_UNVERIFIED` branch left: an address with only pending submissions has no account, so it is `INVALID_CREDENTIALS` like any other unknown address. The code stays in `errors.ts`. `setPhone` still answers `UNAUTHENTICATED` for a user id that no longer exists.
- `UserRepository.create` takes `emailVerifiedAt`; `markEmailVerified` and `updatePasswordHash` are gone.

**Also corrected here:** `phoneValidation` is a top-level field on the `/auth/phone` response, not `meta.phoneValidation` as the table above says.
