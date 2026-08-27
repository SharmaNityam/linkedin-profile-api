import 'dotenv/config';
import pino from 'pino';
import { loadConfig, redactConfig } from './config.js';
import { BrowserVoyagerClient, scrapeTopCard } from './linkedin/browser/scraper.js';
import { BrowserSession } from './linkedin/browser/session.js';
import { TtlCache } from './linkedin/cache.js';
import { Semaphore } from './linkedin/semaphore.js';
import { ProfileService, type BrowserFallback } from './linkedin/service.js';
import { HttpVoyagerClient, type LogFn } from './linkedin/voyager/client.js';
import type { ProfileResponse } from './schema/profile.js';
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

  const http = new HttpVoyagerClient({ liAt: config.LI_AT, userAgent: config.USER_AGENT, log });

  let session: BrowserSession | undefined;
  let browser: BrowserFallback | undefined;
  if (config.BROWSER_FALLBACK) {
    session = new BrowserSession({
      liAt: config.LI_AT,
      userAgent: config.USER_AGENT,
      ...(config.BROWSER_CHANNEL ? { channel: config.BROWSER_CHANNEL } : {}),
      log,
    });
    const s = session;
    browser = {
      voyager: new BrowserVoyagerClient(s, log),
      scrapeTopCard: (id) => scrapeTopCard(s, id, log),
    };
  }

  const service = new ProfileService({
    http,
    ...(browser ? { browser } : {}),
    cache: new TtlCache<ProfileResponse>(config.CACHE_TTL_SECONDS * 1000),
    semaphore: new Semaphore(config.MAX_CONCURRENT_UPSTREAM),
    log,
  });

  const app = await buildApp({ service, rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE, logger });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await session?.close();
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
