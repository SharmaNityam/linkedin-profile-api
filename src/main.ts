import 'dotenv/config';
import pino from 'pino';
import { loadConfig, redactConfig } from './config.js';
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

  const app = await buildApp({
    services,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
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
