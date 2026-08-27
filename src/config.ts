import { z } from 'zod';
import { DEFAULT_POSTS_QUERY_ID } from './linkedin/voyager/endpoints.js';

const baseSchema = z.object({
  // Quotes are stripped so a value pasted as LI_AT="…" works whether it comes
  // from dotenv (which unquotes) or `docker --env-file` (which doesn't).
  LI_AT: z
    .string()
    .transform((v) => v.trim().replace(/^"|"$/g, ''))
    .pipe(z.string().min(1, 'LI_AT (LinkedIn session cookie) is required')),
  /**
   * Optional: the browser's `document.cookie` for linkedin.com. Sends the same
   * companion cookies (JSESSIONID, bcookie, lidc…) the browser does, which
   * makes the session far less likely to be flagged and revoked.
   */
  LI_COOKIES: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(900),
  MAX_CONCURRENT_UPSTREAM: z.coerce.number().int().positive().default(2),
  /**
   * The `voyagerFeedDashProfileUpdates` persisted-query hash. LinkedIn rotates
   * it; set this to the current value (visible in the web app's network tab)
   * when `/v1/posts` starts reporting SCHEMA_DRIFT.
   */
  VOYAGER_POSTS_QUERY_ID: z.string().min(8).default(DEFAULT_POSTS_QUERY_ID),
  USER_AGENT: z
    .string()
    .default(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    ),

  // --- Accounts ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Postgres connection string. Required in production; dev/test fall back to in-memory repositories. */
  DATABASE_URL: z.string().url().optional(),
  /** Session cookie key: 32 bytes of hex (`openssl rand -hex 32`). */
  SESSION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'SESSION_KEY must be 32 bytes as 64 hex chars (openssl rand -hex 32)'),
  /** The origin the browser app is served from; used for the CSRF origin check and cookie scope. */
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('LinkedIn Profile API <onboarding@resend.dev>'),
  ABSTRACT_API_KEY: z.string().optional(),
  /** What to do when phone validation can't reach a verdict: `open` accepts, `closed` rejects. */
  PHONE_VALIDATION_FAIL_MODE: z.enum(['open', 'closed']).default('open'),
  /** Comma-separated override for the built-in consumer email domain allowlist. */
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  AUTH_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  PASSWORD_HASHER: z.enum(['argon2', 'scrypt']).default('argon2'),
});

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

/**
 * Production must not silently run on the in-memory repositories or trust a
 * localhost origin — both would look healthy while dropping accounts or
 * accepting cross-site writes.
 */
const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (!env.DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required when NODE_ENV=production',
    });
  }

  let hostname: string | undefined;
  try {
    hostname = new URL(env.APP_ORIGIN).hostname;
  } catch {
    hostname = undefined;
  }
  if (hostname === undefined || LOCAL_HOSTNAMES.has(hostname)) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_ORIGIN'],
      message: 'APP_ORIGIN must be the public origin (not localhost) when NODE_ENV=production',
    });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

function mask(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `(${value.length} chars, redacted)`;
}

/**
 * Strips the password from a connection string so the rest (which host, which
 * database) stays readable in logs.
 */
function redactDatabaseUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    return `${parsed.protocol}//${parsed.username}:***@${parsed.host}/${database}`;
  } catch {
    return '(unparseable, redacted)';
  }
}

/** Config with secrets masked, safe to log at startup. */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    LI_AT: `(${config.LI_AT.length} chars, redacted)`,
    LI_COOKIES: config.LI_COOKIES ? `(${config.LI_COOKIES.length} chars)` : undefined,
    SESSION_KEY: mask(config.SESSION_KEY),
    RESEND_API_KEY: mask(config.RESEND_API_KEY),
    ABSTRACT_API_KEY: mask(config.ABSTRACT_API_KEY),
    DATABASE_URL: redactDatabaseUrl(config.DATABASE_URL),
  };
}
