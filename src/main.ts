import 'dotenv/config';
import pino from 'pino';
import { parseAllowedDomains } from './auth/email-domains.js';
import { LogMailer, ResendMailer, type MailSender } from './auth/mailer.js';
import { createMemoryRepositories } from './auth/memory.js';
import { createHasher } from './auth/password.js';
import {
  AbstractPhoneValidator,
  NoopPhoneValidator,
  type PhoneValidator,
} from './auth/phone-validation.js';
import { createPostgresRepositories } from './auth/postgres.js';
import type { Repositories } from './auth/repositories.js';
import { AuthService } from './auth/service.js';
import { loadConfig, redactConfig } from './config.js';
import { createPool } from './db/pool.js';
import { TtlCache } from './linkedin/cache.js';
import { Semaphore } from './linkedin/semaphore.js';
import { LinkedInService } from './linkedin/service.js';
import { HttpVoyagerClient, type LogFn } from './linkedin/voyager/client.js';
import { buildApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.cookie', 'headers.cookie'],
    ...(process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  });
  const log: LogFn = (level, msg, extra) => logger[level](extra ?? {}, msg);
  logger.info(redactConfig(config), 'starting');

  const services = new LinkedInService({
    voyager: new HttpVoyagerClient({
      liAt: config.LI_AT,
      companionCookies: config.LI_COOKIES,
      userAgent: config.USER_AGENT,
      log,
    }),
    cache: new TtlCache<unknown>(config.CACHE_TTL_SECONDS * 1000),
    semaphore: new Semaphore(config.MAX_CONCURRENT_UPSTREAM),
    postsQueryId: config.VOYAGER_POSTS_QUERY_ID,
    log,
  });

  // Without a database, accounts live in the process. Fine for a local run,
  // impossible in production — loadConfig requires DATABASE_URL there.
  let repos: Repositories;
  if (config.DATABASE_URL) {
    repos = createPostgresRepositories(createPool(config.DATABASE_URL));
  } else {
    logger.warn('DATABASE_URL not set; accounts are in-memory and lost on restart');
    repos = createMemoryRepositories();
  }

  const mailer: MailSender = config.RESEND_API_KEY
    ? new ResendMailer({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM, log })
    : new LogMailer(log);

  const phoneValidator: PhoneValidator = config.ABSTRACT_API_KEY
    ? new AbstractPhoneValidator({ apiKey: config.ABSTRACT_API_KEY, log })
    : new NoopPhoneValidator();

  const auth = new AuthService({
    repos,
    hasher: createHasher(config.PASSWORD_HASHER),
    mailer,
    phoneValidator,
    allowedDomains: parseAllowedDomains(config.ALLOWED_EMAIL_DOMAINS),
    failMode: config.PHONE_VALIDATION_FAIL_MODE,
    log,
  });

  const app = await buildApp({
    services,
    auth,
    sessionKey: config.SESSION_KEY,
    appOrigin: config.APP_ORIGIN,
    secureCookies: config.NODE_ENV === 'production',
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    authRateLimitPerHour: config.AUTH_RATE_LIMIT_PER_HOUR,
    logger,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
