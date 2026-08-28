import { z } from 'zod';
import { DEFAULT_POSTS_QUERY_ID } from './linkedin/voyager/endpoints.js';

const envSchema = z.object({
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

/** Config with secrets masked, safe to log at startup. */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    LI_AT: `(${config.LI_AT.length} chars, redacted)`,
    LI_COOKIES: config.LI_COOKIES ? `(${config.LI_COOKIES.length} chars)` : undefined,
  };
}
