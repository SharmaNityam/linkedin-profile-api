# Account-Gated API Implementation Plan


**Goal:** `/v1/*` requires a signed-in account with a verified email and a validated unique phone; rate limits are per account; accounts live in Postgres (Neon) with an in-memory fallback for dev/tests.

**Architecture:** Pure helpers (`src/auth/email.ts`, `phone.ts`, `codes.ts`, `password.ts`) → repositories behind interfaces (`memory.ts`, `postgres.ts`) → `AuthService` → Fastify plugin (`session`, `requireAccount`, CSRF hook, helmet) → `/auth/*` routes. `server.ts` gets the plugin order: error handler → helmet → swagger → static → session → csrf → rate-limit → health/openapi → auth routes → gated `/v1` routes.

**Tech Stack:** `@fastify/secure-session` 8 (+ `@fastify/cookie` 11 transitively, `sodium-native`), `@fastify/helmet` 13, `argon2` 0.45, `libphonenumber-js` 1.13 (`/max`), `pg` 8 + `@types/pg`. Vitest. All Fastify-org plugins are Fastify 5 compatible.

## Global Constraints

- Spec: `docs/design/specs/2026-08-27-account-gating-design.md` — read it first.
- Dependencies allowed: exactly the ones listed above. No `@fastify/cors`, no `@fastify/csrf-protection`, no ORM.
- `pnpm test` must never need a database, network, or API key. `tests/db/postgres.test.ts` is gated on `DATABASE_URL`.
- Argon2id parameters: `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`. Scrypt fallback: `N: 2**17, r: 8, p: 1, maxMem: 256 * 1024 * 1024`.
- Session cookie: name `sid`, `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `secure: NODE_ENV === 'production'`, `maxAge: 30 * 24 * 3600` seconds, rolling.
- Verification code: 6 digits, sha256 at rest, 10-minute expiry, max 5 attempts.
- Error codes (all in `src/errors.ts`): `UNAUTHENTICATED 401`, `INVALID_CREDENTIALS 401`, `EMAIL_UNVERIFIED 403`, `PHONE_REQUIRED 403`, `FORBIDDEN_ORIGIN 403`, `PHONE_TAKEN 409`, `INVALID_PHONE 400`, `INVALID_CODE 400`, `EMAIL_DOMAIN_NOT_ALLOWED 400`, `PHONE_REJECTED 400`.
- Signup never reveals whether an email exists: always `200 { status: 'verification_sent' }`.
- Abstract API: `GET https://phonevalidation.abstractapi.com/v1/?api_key=<key>&phone=<e164 without '+'>`; accept only `valid === true && type === 'Mobile'`; missing key / 402 / 429 / 5xx / network error → `skipped`; `PHONE_VALIDATION_FAIL_MODE=open` (default) lets `skipped` through, `closed` rejects with `PHONE_REJECTED`.
- Config vars: `DATABASE_URL`, `SESSION_KEY` (64 hex), `APP_ORIGIN`, `RESEND_API_KEY`, `EMAIL_FROM`, `ABSTRACT_API_KEY`, `PHONE_VALIDATION_FAIL_MODE`, `ALLOWED_EMAIL_DOMAINS`, `AUTH_RATE_LIMIT_PER_HOUR` (default 5), `PASSWORD_HASHER` (`argon2`|`scrypt`, default `argon2`).
- Commit per task, 6–7-word subject, no body. `pnpm test && pnpm typecheck && pnpm lint` green before every commit.
- Existing interfaces: `LinkedInService` (`src/linkedin/service.ts`), `buildApp({ services, rateLimitPerMinute, logger? })` (`src/server.ts`), `AppError(code, message, details?)` (`src/errors.ts`), `loadConfig/redactConfig` (`src/config.ts`), `TtlCache` (`src/linkedin/cache.ts`).

## File map

| File | Responsibility |
|---|---|
| `src/auth/email.ts` | `canonicalEmail`, `emailDomain` |
| `src/auth/email-domains.ts` | `DEFAULT_ALLOWED_EMAIL_DOMAINS`, `isAllowedDomain` |
| `src/auth/phone.ts` | `normalizePhone` |
| `src/auth/codes.ts` | `generateCode`, `hashCode`, `codeIsValid` |
| `src/auth/password.ts` | `PasswordHasher`, `Argon2Hasher`, `ScryptHasher`, `createHasher` |
| `src/auth/phone-validation.ts` | `PhoneValidator` interface, `AbstractPhoneValidator`, `NoopPhoneValidator` |
| `src/auth/mailer.ts` | `MailSender`, `ResendMailer`, `LogMailer` |
| `src/auth/repositories.ts` | `User`, repository interfaces |
| `src/auth/memory.ts` | in-memory repositories |
| `src/auth/postgres.ts` | `pg` repositories |
| `src/auth/service.ts` | `AuthService` |
| `src/auth/plugin.ts` | session, `requireAccount`, CSRF hook, helmet |
| `src/routes/auth.ts` | `/auth/*` |
| `src/db/migrate.ts`, `migrations/0001_accounts.sql` | migrations |
| `src/schema/auth.ts` | zod request/response schemas |
| `src/server.ts`, `src/main.ts`, `src/config.ts`, `src/errors.ts` | wiring |
| `public/index.html` | auth panel |
| `Dockerfile`, `render.yaml`, `.env.example`, `README.md` | ops/docs |

---

### Task 1: Error codes, config, email canonicalisation and allowlist

**Files:** `src/errors.ts`, `src/config.ts`, `src/auth/email.ts` (new), `src/auth/email-domains.ts` (new), `tests/unit/auth/email.test.ts` (new), `tests/unit/config.test.ts`

**Interfaces produced:**
```ts
// email.ts
export function canonicalEmail(email: string): string;   // throws AppError('INVALID_REQUEST') if not a@b form
export function emailDomain(email: string): string;      // lowercase domain after canonicalisation
// email-domains.ts
export const DEFAULT_ALLOWED_EMAIL_DOMAINS: readonly string[];
export function isAllowedDomain(domain: string, allowed: readonly string[]): boolean;
export function parseAllowedDomains(env: string | undefined): string[]; // comma list → lowercase trimmed, or defaults
```

- [ ] **Step 1: Tests** `tests/unit/auth/email.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { canonicalEmail, emailDomain } from '../../../src/auth/email.js';
import { DEFAULT_ALLOWED_EMAIL_DOMAINS, isAllowedDomain, parseAllowedDomains } from '../../../src/auth/email-domains.js';

describe('canonicalEmail', () => {
  it.each([
    ['John.Doe+promo@Gmail.com', 'johndoe@gmail.com'],
    ['j.o.h.n@googlemail.com', 'john@gmail.com'],
    ['John+tag@Outlook.com', 'john+tag@outlook.com'],
    ['  Jane@Yahoo.co.in ', 'jane@yahoo.co.in'],
  ])('%s → %s', (input, out) => expect(canonicalEmail(input)).toBe(out));
  it.each(['nope', '@gmail.com', 'a@', 'a@b@c'])('rejects %s', (bad) => expect(() => canonicalEmail(bad)).toThrow());
  it('extracts the domain', () => expect(emailDomain('X@GoogleMail.com')).toBe('gmail.com'));
});

describe('allowlist', () => {
  it('ships consumer domains by default', () => {
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.co.in', 'live.com']) expect(isAllowedDomain(d, DEFAULT_ALLOWED_EMAIL_DOMAINS)).toBe(true);
    expect(isAllowedDomain('brackets.agency', DEFAULT_ALLOWED_EMAIL_DOMAINS)).toBe(false);
  });
  it('parses the env override', () => {
    expect(parseAllowedDomains(' Example.com, gmail.com ')).toEqual(['example.com', 'gmail.com']);
    expect(parseAllowedDomains(undefined)).toEqual([...DEFAULT_ALLOWED_EMAIL_DOMAINS]);
    expect(parseAllowedDomains('')).toEqual([...DEFAULT_ALLOWED_EMAIL_DOMAINS]);
  });
});
```

Config test additions (`tests/unit/config.test.ts`): `SESSION_KEY` must be 64 hex chars (`loadConfig({LI_AT:'x', SESSION_KEY:'zz'})` throws); `PHONE_VALIDATION_FAIL_MODE` defaults to `open`, rejects `maybe`; `AUTH_RATE_LIMIT_PER_HOUR` defaults to 5; `PASSWORD_HASHER` defaults `argon2`; in `NODE_ENV=production` missing `DATABASE_URL` or `APP_ORIGIN` throws; `redactConfig` output contains no raw `SESSION_KEY`, `RESEND_API_KEY`, `ABSTRACT_API_KEY`, or `DATABASE_URL` password (`postgres://u:secret@h/db` → `secret` absent). `SESSION_KEY` is required always (tests pass a 64-hex constant).

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `email.ts`:

```ts
const GOOGLE = new Set(['gmail.com', 'googlemail.com']);
export function canonicalEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) throw new AppError('INVALID_REQUEST', 'Email address is not valid');
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (GOOGLE.has(domain)) { domain = 'gmail.com'; local = local.split('+')[0]!.replace(/\./g, ''); }
  if (!local) throw new AppError('INVALID_REQUEST', 'Email address is not valid');
  return `${local}@${domain}`;
}
export function emailDomain(email: string): string { return canonicalEmail(email).split('@')[1]!; }
```

`email-domains.ts`: the list from the brief in the prompt (Google 2, Microsoft ~25 incl. regional, Yahoo ~19), with the comment "Intentionally not exhaustive; ALLOWED_EMAIL_DOMAINS overrides it." `parseAllowedDomains` splits on commas, trims, lowercases, drops empties, falls back to defaults when the result is empty.

`config.ts` additions: `NODE_ENV: z.enum(['development','test','production']).default('development')`, `DATABASE_URL: z.string().url().optional()`, `SESSION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'SESSION_KEY must be 32 bytes as 64 hex chars (openssl rand -hex 32)')`, `APP_ORIGIN: z.string().url().default('http://localhost:3000')`, `RESEND_API_KEY: z.string().optional()`, `EMAIL_FROM: z.string().default('LinkedIn Profile API <onboarding@resend.dev>')`, `ABSTRACT_API_KEY: z.string().optional()`, `PHONE_VALIDATION_FAIL_MODE: z.enum(['open','closed']).default('open')`, `ALLOWED_EMAIL_DOMAINS: z.string().optional()`, `AUTH_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5)`, `PASSWORD_HASHER: z.enum(['argon2','scrypt']).default('argon2')`, plus a `.superRefine` that requires `DATABASE_URL` and a non-localhost `APP_ORIGIN` when `NODE_ENV === 'production'`. `redactConfig` masks the four secrets (`(n chars, redacted)`) and rewrites `DATABASE_URL` as `postgres://<user>:***@<host>/<db>` using `new URL`.

`errors.ts`: add the ten codes/statuses from Global Constraints.

- [ ] **Step 4:** green. **Step 5:** `git add src/errors.ts src/config.ts src/auth tests/unit/auth tests/unit/config.test.ts && git commit -m "Add auth config, email canonicalisation, allowlist"`

---

### Task 2: Phone normalisation, codes, password hashers

**Files:** `src/auth/phone.ts`, `src/auth/codes.ts`, `src/auth/password.ts`, `tests/unit/auth/{phone,codes,password}.test.ts`; `pnpm add libphonenumber-js argon2`.

**Interfaces produced:**
```ts
export function normalizePhone(input: string): string;                     // E.164 or throws AppError('INVALID_PHONE')
export function generateCode(random?: () => number): string;              // 6 digits, crypto.randomInt
export function hashCode(code: string): string;                           // sha256 hex
export function codeIsValid(args: { stored: { codeHash: string; expiresAt: Date; attempts: number }; code: string; now: Date; maxAttempts: number }): 'ok' | 'expired' | 'exhausted' | 'mismatch';
export interface PasswordHasher { hash(p: string): Promise<string>; verify(hash: string, p: string): Promise<boolean> }
export class Argon2Hasher implements PasswordHasher {}
export class ScryptHasher implements PasswordHasher {}   // format `$scrypt$N=131072,r=8,p=1$<salt b64>$<key b64>`
export function createHasher(kind: 'argon2' | 'scrypt'): PasswordHasher; // each verify() also accepts the other's prefix by delegating
```

- [ ] **Step 1: Tests.** `phone.test.ts`: `'+91 98765 43210' → '+919876543210'`, `'+1 (415) 555-2671' → '+14155552671'`, `'+44 7911 123456' → '+447911123456'`; rejects `'98765 43210'` (no country code), `'+1 555 0100'` (invalid), `'hello'`, `''` with `INVALID_PHONE`. `codes.test.ts`: generated code matches `/^\d{6}$/` (100 iterations), `hashCode` is stable and 64 hex, `codeIsValid` returns `ok` on match before expiry, `expired` at `expiresAt` or later, `exhausted` when `attempts >= maxAttempts` (checked before mismatch), `mismatch` otherwise. `password.test.ts`: both hashers round-trip, reject wrong password, produce different hashes for the same password (salt), hash strings start with `$argon2id$` / `$scrypt$`; `createHasher('argon2').verify(scryptHash, pw)` is true and vice versa; argon2 test uses `memoryCost: 19456`; scrypt test asserts `maxmem` doesn't throw for N=2^17.
- [ ] **Step 2:** FAIL. **Step 3: Implement** — `normalizePhone` via `parsePhoneNumberFromString(input)` from `libphonenumber-js/max`; require `?.isValid()` and `number` starting with `+`; `ScryptHasher` uses `scrypt` from `node:crypto` promisified with `{ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }`, 16-byte salt, 64-byte key, `timingSafeEqual`. `Argon2Hasher` uses `argon2.hash(p, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })` and `argon2.verify`.
- [ ] **Step 4:** green. **Step 5:** `git add package.json pnpm-lock.yaml src/auth tests/unit/auth && git commit -m "Add phone, code and password primitives"`

---

### Task 3: Repositories (interfaces, memory, postgres) and migrations

**Files:** `src/auth/repositories.ts`, `src/auth/memory.ts`, `src/auth/postgres.ts`, `src/db/migrate.ts`, `src/db/pool.ts`, `migrations/0001_accounts.sql`, `tests/unit/auth/memory-repo.test.ts`, `tests/db/postgres.test.ts`, `package.json` (`"migrate": "node dist/db/migrate.js"`, `"migrate:dev": "tsx src/db/migrate.ts"`), `vitest.config.ts` (include `tests/db/**`), `tsconfig.build.json` (nothing if `src/**` already included). `pnpm add pg && pnpm add -D @types/pg`.

**Interfaces produced:**
```ts
export interface User { id: string; email: string; emailCanonical: string; emailVerifiedAt: Date | null; passwordHash: string; phoneE164: string | null; phoneVerifiedAt: Date | null; sessionVersion: number; createdAt: Date }
export interface EmailVerification { userId: string; codeHash: string; expiresAt: Date; attempts: number }
export interface PhoneValidation { phoneE164: string; provider: string; valid: boolean | null; type: string | null; raw: unknown; checkedAt: Date }
export interface UserRepository {
  create(u: { email: string; emailCanonical: string; passwordHash: string }): Promise<User>;   // throws AppError('INTERNAL_ERROR') on duplicate; callers check first
  findById(id: string): Promise<User | null>;
  findByCanonicalEmail(e: string): Promise<User | null>;
  findByPhone(phoneE164: string): Promise<User | null>;
  markEmailVerified(id: string, at: Date): Promise<void>;
  setPhone(id: string, phoneE164: string, at: Date): Promise<'ok' | 'taken'>;   // unique-violation → 'taken'
  bumpSessionVersion(id: string): Promise<number>;
}
export interface EmailVerificationRepository { upsert(v: EmailVerification): Promise<void>; find(userId: string): Promise<EmailVerification | null>; incrementAttempts(userId: string): Promise<void>; delete(userId: string): Promise<void> }
export interface PhoneValidationRepository { find(phoneE164: string): Promise<PhoneValidation | null>; save(v: PhoneValidation): Promise<void> }
export interface Repositories { users: UserRepository; verifications: EmailVerificationRepository; phoneValidations: PhoneValidationRepository }
export function createMemoryRepositories(): Repositories;
export function createPostgresRepositories(pool: Pool): Repositories;
export async function migrate(pool: Pool, dir?: string): Promise<string[]>;  // applied file names; idempotent via schema_migrations(name PK, applied_at)
```

- [ ] **Step 1: Tests.** `memory-repo.test.ts` exercises every method incl. `setPhone` returning `'taken'` for a second user, `bumpSessionVersion` incrementing, `find` after `delete` → null. `tests/db/postgres.test.ts`: `describe.skipIf(!process.env.DATABASE_URL)`; creates a `Pool`, runs `migrate` twice (second returns `[]`), runs the same behavioural suite against `createPostgresRepositories`, truncates tables in `afterAll`. Share the behavioural suite: `tests/helpers/repo-suite.ts` exporting `repositorySuite(name, factory)` used by both.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** Migration SQL exactly per spec tables, `id uuid primary key default gen_random_uuid()`. `migrate.ts` reads `migrations/*.sql` sorted, wraps each in a transaction, inserts into `schema_migrations`; when run as a script (`import.meta.url === pathToFileURL(process.argv[1]).href`) it loads config, connects with `DATABASE_URL` (Neon requires `ssl: { rejectUnauthorized: true }` — use `ssl: url.hostname !== 'localhost'`), migrates, logs, exits. `pool.ts` exports `createPool(databaseUrl)`. Postgres repo maps `23505` unique violations in `setPhone` to `'taken'`.
- [ ] **Step 4:** green (postgres suite skipped offline). If you have a `DATABASE_URL` in `.env`, run `DATABASE_URL=… pnpm vitest run tests/db` and report. **Step 5:** `git add -A migrations src/auth src/db tests package.json pnpm-lock.yaml vitest.config.ts && git commit -m "Add account repositories and migrations"`

---

### Task 4: Mailer, phone validator, `AuthService`

**Files:** `src/auth/mailer.ts`, `src/auth/phone-validation.ts`, `src/auth/service.ts`, `tests/unit/auth/{phone-validation,service}.test.ts`

**Interfaces produced:**
```ts
export interface MailSender { sendVerificationCode(to: string, code: string): Promise<void> }
export class ResendMailer implements MailSender { constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) } // POST https://api.resend.com/emails
export class LogMailer implements MailSender { constructor(log: LogFn) }   // log('debug', 'verification code', { to, code })
export type PhoneVerdict = { verdict: 'accepted' | 'rejected' | 'skipped'; reason: string | null; raw: unknown; provider: string; type: string | null; valid: boolean | null };
export interface PhoneValidator { validate(phoneE164: string): Promise<PhoneVerdict> }
export class AbstractPhoneValidator implements PhoneValidator { constructor(opts: { apiKey: string | undefined; fetch?: typeof fetch; log?: LogFn }) }
export class NoopPhoneValidator implements PhoneValidator {}   // always 'skipped', reason 'no validator configured'
export interface AuthServiceDeps { repos: Repositories; hasher: PasswordHasher; mailer: MailSender; phoneValidator: PhoneValidator; allowedDomains: readonly string[]; failMode: 'open' | 'closed'; log?: LogFn; now?: () => Date }
export interface SessionClaims { userId: string; sessionVersion: number; issuedAt: number }
export interface Me { email: string; emailVerified: boolean; phoneVerified: boolean; createdAt: string }
export class AuthService {
  signup(email: string, password: string): Promise<void>;                               // never throws on existing email
  verifyEmail(email: string, code: string): Promise<{ claims: SessionClaims; me: Me }>;
  setPhone(userId: string, phone: string): Promise<{ me: Me; phoneValidation: 'accepted' | 'skipped' }>;
  login(email: string, password: string): Promise<{ claims: SessionClaims; me: Me }>;
  logoutEverywhere(userId: string): Promise<void>;
  resolve(claims: SessionClaims | undefined): Promise<User | null>;                     // null when missing/stale version
  me(user: User): Me;
}
```

- [ ] **Step 1: Tests.** `phone-validation.test.ts` with a mocked `fetch`: `{valid:true,type:'Mobile'}` → accepted; `{valid:true,type:'Landline'}` → rejected reason mentions Landline; `{valid:false}` → rejected; HTTP 429 → skipped; 402 → skipped; network throw → skipped; `apiKey: undefined` → skipped without calling fetch; request URL contains `phone=919876543210` (no `+`) and the key. `service.test.ts` (memory repos, `LogMailer` replaced by a recording fake, fake validator): signup stores hashed password (not plaintext) and sends a 6-digit code; signup with disallowed domain throws `EMAIL_DOMAIN_NOT_ALLOWED`; signup again with the same canonical email (`j.ohn+1@gmail.com` vs `john@gmail.com`) does not create a second user and re-sends a code only if unverified; `verifyEmail` wrong code → `INVALID_CODE` and increments attempts; 5 wrong → `exhausted` message; expired (advance `now`) → message contains `expired`; success sets `emailVerifiedAt`, returns claims with the user's `sessionVersion`; `setPhone` normalises, caches the verdict in `phoneValidations` (second call for same number does not call the validator), duplicate → `PHONE_TAKEN`, landline → `PHONE_REJECTED`, `skipped` + `open` → ok with `phoneValidation: 'skipped'`, `skipped` + `closed` → `PHONE_REJECTED`; `login` wrong password / unknown email → `INVALID_CREDENTIALS`, unverified → `EMAIL_UNVERIFIED`; `resolve` returns null for stale `sessionVersion` after `logoutEverywhere`; password shorter than 10 chars → `INVALID_REQUEST`.
- [ ] **Step 2:** FAIL. **Step 3: Implement** per spec. `signup` flow: canonicalise → domain check → `findByCanonicalEmail` → if exists and verified: return; if exists and unverified: new code; else `create` → new code (`generateCode`, `hashCode`, `expiresAt = now + 10 min`, `attempts 0`) → `mailer.sendVerificationCode(email, code)`. `verifyEmail` uses `codeIsValid` with `maxAttempts 5`; on `mismatch` increment attempts; on success delete the verification. `setPhone`: `normalizePhone` → `findByPhone` (other user → `PHONE_TAKEN`) → cached verdict or `validator.validate` (save to repo when provider responded, i.e. verdict !== 'skipped' or reason is a provider status) → map verdict → `users.setPhone` (`'taken'` → `PHONE_TAKEN`).
- [ ] **Step 4:** green. **Step 5:** `git add src/auth tests/unit/auth && git commit -m "Add auth service, mailer, phone validator"`

---

### Task 5: Fastify plugin, auth routes, server wiring, per-account rate limit

**Files:** `src/auth/plugin.ts`, `src/routes/auth.ts`, `src/schema/auth.ts`, `src/server.ts`, `src/main.ts`, `tests/integration/auth.test.ts`, `tests/integration/routes.test.ts`, `tests/helpers/auth.ts`, `pnpm add @fastify/secure-session @fastify/helmet`.

**Interfaces produced:**
```ts
// server.ts
export interface BuildAppOptions {
  services: LinkedInService;
  auth: AuthService;
  sessionKey: string;          // 64 hex
  appOrigin: string;
  secureCookies: boolean;
  rateLimitPerMinute: number;
  authRateLimitPerHour: number;
  logger?: FastifyBaseLogger;
}
// plugin.ts
export const authPlugin: FastifyPluginAsync<{ auth: AuthService; sessionKey: string; appOrigin: string; secureCookies: boolean }>;
// decorates: request.currentUser: User | null (resolved lazily in an onRequest hook for every route)
export function requireAccount(): preHandler   // 401 UNAUTHENTICATED if no user, 403 PHONE_REQUIRED if !phoneVerifiedAt
// tests/helpers/auth.ts
export async function signedInCookie(app, auth, { email, phone? }): Promise<string>  // runs signup→verify (reading the code from the fake mailer)→phone, returns `sid=…` cookie header
```

- [ ] **Step 1: Tests** `tests/integration/auth.test.ts` (memory repos, recording mailer, scripted validator, `rateLimitPerMinute: 2` in the rate-limit describe, `authRateLimitPerHour: 3` in the auth-limit describe, `sessionKey` = 64 hex constant, `appOrigin: 'http://localhost:3000'`):
  - happy path: signup 200 `{status:'verification_sent'}` → verify-email 200 sets `set-cookie` `sid` with `HttpOnly; SameSite=Lax; Path=/` → `/v1/profile` 403 `PHONE_REQUIRED` → `/auth/phone` 200 → `/v1/profile` 200 (stub `getProfile`).
  - `/v1/profile` without cookie → 401 `UNAUTHENTICATED`; `/v1/company` and `/v1/posts` likewise.
  - signup for an existing email → 200 identical body; no second user (assert via `/auth/login` still works with the original password).
  - duplicate phone from a second user → 409 `PHONE_TAKEN`.
  - cross-origin: `POST /auth/login` with `origin: https://evil.example` → 403 `FORBIDDEN_ORIGIN`; same-origin and absent `Origin` pass; `POST /auth/login` with `content-type: text/plain` → 400.
  - `/auth/me` 401 signed out, 200 with `{ email, emailVerified, phoneVerified }` signed in; `/auth/logout` clears the cookie (`max-age=0` or `expires` in the past) and a following `/auth/me` → 401; `/auth/logout {everywhere:true}` invalidates the *other* session's cookie too.
  - per-account rate limit: two users from the same `remoteAddress` each get 2 × 200 then 429 independently.
  - auth per-IP limit: 4th `POST /auth/signup` from one IP → 429.
  - `GET /` (30 times) and `/health` never 429 at `rateLimitPerMinute: 2`.
  - helmet: `GET /` has `content-security-policy` containing `img-src 'self' https://media.licdn.com data:`.
  Update `routes.test.ts` to pass the new `buildApp` options and use `signedInCookie` for every `/v1` call.
- [ ] **Step 2:** FAIL. **Step 3: Implement.**
  - `plugin.ts`: register `@fastify/secure-session` with `{ key: Buffer.from(sessionKey, 'hex'), cookieName: 'sid', cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 30 * 24 * 3600 }, expiry: 30 * 24 * 3600 }`; `onRequest` hook: read `session.get('claims')`, `request.currentUser = await auth.resolve(claims)`, if claims present but user null → `session.delete()`; when a user resolves, `session.touch()` for rolling renewal. CSRF hook (`onRequest`, after session): for `POST|PUT|PATCH|DELETE`: `origin` header present and `!== appOrigin` → `FORBIDDEN_ORIGIN`; content-type must start with `application/json` unless `content-length` is `0`/absent → `AppError('INVALID_REQUEST', 'Expected application/json')`. `@fastify/helmet` with `contentSecurityPolicy.directives` from the spec, `crossOriginEmbedderPolicy: false`; swagger-ui gets `staticCSP: true` (register swagger-ui with `{ routePrefix: '/docs', staticCSP: true }`) — verify `/docs` still renders in a browser.
  - `routes/auth.ts`: five routes with zod schemas from `src/schema/auth.ts` (`SignupBody { email: z.string().email().max(254), password: z.string().min(10).max(200) }`, `VerifyBody { email, code: z.string().regex(/^\d{6}$/) }`, `PhoneBody { phone: z.string().min(5).max(32) }`, `LoginBody`, `LogoutBody { everywhere: z.boolean().optional() }`, `MeResponse`), tag `auth`, `config: { rateLimit: { max: authRateLimitPerHour, timeWindow: '1 hour', keyGenerator: (req) => req.ip } }` on signup/verify/login/phone. On verify/login: `req.session.set('claims', claims)`. `/auth/me` and `/auth/logout` are not IP-limited.
  - `server.ts`: new plugin order per spec; rate-limit `keyGenerator: (req) => req.currentUser?.id ?? req.ip`, `allowList: (req) => req.url === '/health' || req.url === '/openapi.json' || req.url.startsWith('/docs')`; static registered before rate-limit; `/v1` routes registered inside an encapsulated plugin with `app.addHook('preHandler', requireAccount())`. Error handler: add a branch for `@fastify/rate-limit`'s error shape (already there) and make sure `AppError` from hooks is serialised the same way.
  - `main.ts`: build repos (`DATABASE_URL` ? postgres : memory + `logger.warn('DATABASE_URL not set; accounts are in-memory and lost on restart')`), hasher (`createHasher(config.PASSWORD_HASHER)`), mailer (`RESEND_API_KEY` ? `ResendMailer` : `LogMailer`), validator (`ABSTRACT_API_KEY` ? `AbstractPhoneValidator` : `NoopPhoneValidator`), `AuthService`, then `buildApp`.
- [ ] **Step 4:** green. **Step 5:** `git add -A src tests package.json pnpm-lock.yaml && git commit -m "Gate API behind verified accounts"`

---

### Task 6: Playground auth panel

**Files:** `public/index.html`, `tests/integration/routes.test.ts` (assert the page contains `/auth/me`)

- [ ] **Step 1:** Add an `<aside class="auth card" id="auth">` under the header with four states rendered by `renderAuth(state)`: `signed-out` (email + password inputs, "Sign up" and "Log in" buttons, inline error line), `code` (6-digit input, "Verify", "Resend code" → signup again), `phone` (E.164 input with placeholder `+91 98765 43210`, "Add phone", helper text "Used only to keep the demo to one account per person"), `signed-in` (email chip + phone status + "Log out"). All requests `fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(...), credentials: 'same-origin' })`. On load: `GET /auth/me` → pick state. In `lookup()`: a `401` opens the panel in `signed-out`, a `403 PHONE_REQUIRED` opens it in `phone`, and the error card says "Sign in to fetch profiles". Style with existing variables (`.card`, `.btn`, inputs like `form.lookup input`), collapsible (`details`/toggle) so it doesn't dominate. Keep everything in the single file; no framework.
- [ ] **Step 2:** Verify in Chrome against `pnpm dev` (memory repos, `LogMailer` — read the code from the server log): signup → code → phone (`+91 98765 43210` is valid for libphonenumber; with no Abstract key the validator is `Noop` → accepted as skipped) → fetch a profile → log out → 401 prompt. Take one screenshot of each state for the report.
- [ ] **Step 3:** `pnpm test`; `git add public/index.html tests/integration/routes.test.ts && git commit -m "Add signup and login to playground"`

---

### Task 7: Docker, Render, env example, README

**Files:** `Dockerfile`, `render.yaml`, `.env.example`, `README.md`

- [ ] **Step 1:** Dockerfile: `COPY migrations ./migrations` in the runtime stage; `CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]`. Build it: `docker build -t lpa-test .` and grep the output for `node-gyp` / `prebuild-install` / `Building` to confirm `argon2` and `sodium-native` used prebuilt binaries (no compiler in `node:22-slim`). Run `docker run --rm -e LI_AT=x -e SESSION_KEY=$(openssl rand -hex 32) -p 3000:3000 lpa-test` briefly and confirm `/health` → 200 and the startup log shows the in-memory warning (no DATABASE_URL). Record the exact build lines in the task report. If a native module falls back to node-gyp and fails, switch the Dockerfile build stage to install `python3 make g++` for the build stage only and report it.
- [ ] **Step 2:** `render.yaml`: add `DATABASE_URL`, `SESSION_KEY`, `RESEND_API_KEY`, `ABSTRACT_API_KEY` with `sync: false`; `APP_ORIGIN` value `https://linkedin-profile-api-c925.onrender.com`; `EMAIL_FROM`, `PHONE_VALIDATION_FAIL_MODE: open`, `AUTH_RATE_LIMIT_PER_HOUR: "5"`.
- [ ] **Step 3:** `.env.example`: every new var with a one-line comment; `SESSION_KEY=` with "generate with `openssl rand -hex 32`".
- [ ] **Step 4:** README: new "Accounts and access" section (why: per-IP limits are bypassable; the flow; what each check proves and does not prove, verbatim from the spec's "Threat model and honest limits"); API section documents `/auth/*` and that `/v1/*` needs the `sid` cookie (curl example with `-c`/`-b` cookie jar); error table adds the new codes; configuration table adds all vars; Deployment: Neon setup (create project → copy pooled connection string → set `DATABASE_URL`; `pnpm migrate` runs at container start), why not Render Postgres (deleted after 30 days on free), secrets list; Known limitations: phone possession not proven (SMS OTP is the next step), Abstract quota/fail-open, sessions are stateless cookies (revocation only via `session_version`), in-memory mode loses accounts on restart.
- [ ] **Step 5:** `git add Dockerfile render.yaml .env.example README.md && git commit -m "Deploy accounts with Neon and secrets"`
