import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  LI_AT: z.string().min(1, 'LI_AT (LinkedIn session cookie) is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(900),
  MAX_CONCURRENT_UPSTREAM: z.coerce.number().int().positive().default(2),
  BROWSER_FALLBACK: bool.default(false),
  /** Playwright channel (e.g. "chrome") for local runs without a bundled Chromium. */
  BROWSER_CHANNEL: z.string().optional(),
  USER_AGENT: z
    .string()
    .default(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
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
  return { ...config, LI_AT: `${config.LI_AT.slice(0, 6)}…(${config.LI_AT.length} chars)` };
}
