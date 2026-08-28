import 'dotenv/config';
import pino from 'pino';
import {
  BrevoMailer,
  LogMailer,
  SmtpMailer,
  type LogFn as MailLogFn,
  type MailSender,
} from './auth/mailer.js';
import { OtpStore } from './auth/otp.js';
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
  const mailLog: MailLogFn = (level, msg, extra) => logger[level](extra ?? {}, msg);
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

  let mailer: MailSender;
  if (config.BREVO_API_KEY) {
    // Config validation guarantees EMAIL_FROM is set whenever BREVO_API_KEY is.
    mailer = new BrevoMailer(
      { apiKey: config.BREVO_API_KEY, from: config.EMAIL_FROM! },
      undefined,
      mailLog,
    );
    logger.info('mailer: Brevo');
  } else if (config.SMTP_USER && config.SMTP_PASS) {
    mailer = new SmtpMailer(
      {
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        from: config.EMAIL_FROM ?? config.SMTP_USER,
      },
      undefined,
      mailLog,
    );
    logger.info('mailer: SMTP');
  } else {
    logger.warn('SMTP not configured; OTP codes will be logged instead of mailed');
    mailer = new LogMailer(mailLog);
  }

  const app = await buildApp({
    services,
    auth: {
      store: new OtpStore(config.OTP_PER_EMAIL_PER_HOUR),
      mailer,
      sessionKey: config.SESSION_KEY,
      appOrigin: config.APP_ORIGIN,
      secureCookies: config.NODE_ENV === 'production',
      otpRateLimitPerHour: config.OTP_RATE_LIMIT_PER_HOUR,
    },
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
