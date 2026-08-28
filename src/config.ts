import { z } from 'zod';
import { DEFAULT_POSTS_QUERY_ID } from './linkedin/voyager/endpoints.js';

const rawEnvSchema = z.object({
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

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Email-OTP gate on /v1/*
  SESSION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'SESSION_KEY must be 64 hex characters (32 bytes)'),
  SMTP_USER: z.string().email('SMTP_USER must be a valid email').optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  /** Brevo transactional-email API key; used instead of SMTP where outbound SMTP is blocked. */
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_ORIGIN: z.string().default('http://localhost:3000'),
  /** Per IP, on /auth/request-code and /auth/verify. */
  OTP_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  /** Per email address, on code issuance. */
  OTP_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(5),
  /** Comma list of domains `/auth/request-code` accepts, lowercased and trimmed. */
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default('gmail.com,yahoo.com,outlook.com,myyahoo.com')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Per IP, distinct verified accounts inside the trailing 7 days. */
  ACCOUNTS_PER_IP: z.coerce.number().int().positive().default(10),
});

const envSchema = rawEnvSchema
  .refine((v) => v.NODE_ENV !== 'production' || v.BREVO_API_KEY || (v.SMTP_USER && v.SMTP_PASS), {
    message: 'BREVO_API_KEY, or SMTP_USER and SMTP_PASS, are required when NODE_ENV=production',
    path: ['BREVO_API_KEY'],
  })
  .refine((v) => !v.BREVO_API_KEY || v.EMAIL_FROM || v.SMTP_USER, {
    message: 'EMAIL_FROM is required when BREVO_API_KEY is set (unless SMTP_USER is too)',
    path: ['EMAIL_FROM'],
  })
  .transform((v) => ({ ...v, EMAIL_FROM: v.EMAIL_FROM ?? v.SMTP_USER }));

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
    SESSION_KEY: `(${config.SESSION_KEY.length} chars, redacted)`,
    SMTP_PASS: config.SMTP_PASS ? `(${config.SMTP_PASS.length} chars, redacted)` : undefined,
    BREVO_API_KEY: config.BREVO_API_KEY
      ? `(${config.BREVO_API_KEY.length} chars, redacted)`
      : undefined,
  };
}
