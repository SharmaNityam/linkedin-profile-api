import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AdminCredential } from './auth/admin.js';
import type { MailSender } from './auth/mailer.js';
import type { OtpStore } from './auth/otp.js';
import { authPlugin, requireViewer } from './auth/plugin.js';
import type { LoginRegistry } from './auth/registry.js';
import { AppError, isAppError } from './errors.js';
import type { ErrorResponse } from './schema/profile.js';
import type { LinkedInService } from './linkedin/service.js';
import { authRoutes } from './routes/auth.js';
import { companyRoutes } from './routes/company.js';
import { postsRoutes } from './routes/posts.js';
import { profileRoutes } from './routes/profile.js';

export interface BuildAppAuthOptions {
  store: OtpStore;
  mailer: MailSender;
  /** 32 bytes as 64 hex chars; see `SESSION_KEY`. */
  sessionKey: string;
  /** The only `Origin` a state-changing request may declare. */
  appOrigin: string;
  /** `Secure` on the session cookie. Off in development, where there's no TLS. */
  secureCookies: boolean;
  /** Per IP, on `/auth/request-code` and `/auth/verify`. */
  otpRateLimitPerHour: number;
  /** Domains `/auth/request-code` accepts, lowercased and trimmed. */
  allowedEmailDomains: string[];
  /** Tracks which emails have verified from which IPs, for the per-IP account cap. */
  registry: LoginRegistry;
  /** Per IP, distinct verified accounts inside the trailing 7 days. */
  accountsPerIp: number;
  /** The shared tester credential for POST /auth/login. Undefined when not configured. */
  admin?: AdminCredential;
}

// Read once at module load rather than on every buildApp() call: both files
// are baked into the image and never change at runtime.
const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json') as { version: string };
const docsThemeCss = readFileSync(
  fileURLToPath(new URL('../public/docs-theme.css', import.meta.url)),
  'utf8',
);

export interface BuildAppOptions {
  services: LinkedInService;
  auth: BuildAppAuthOptions;
  /** Per IP, or per verified email once signed in. */
  rateLimitPerMinute: number;
  /** A pino instance to log through; omitted in tests. */
  logger?: FastifyBaseLogger;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    requestIdHeader: 'x-request-id',
    // Render terminates TLS and proxies through exactly one hop. This
    // Fastify disables bare hop-count trust (`trustProxy: <number>` always
    // fails closed — see @fastify/proxy-addr) because it can't validate the
    // immediate peer, so hop-count trust is expressed as a function instead:
    // trust only the socket peer (hop 0, i.e. Render's edge) as a proxy, so
    // its single `X-Forwarded-For` entry is honoured, but nothing a client
    // prepends beyond that is — `req.ip` becomes the real client address
    // without letting a caller spoof further hops.
    trustProxy: (_address: string, hop: number) => hop === 0,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Must be set before plugins are registered: child contexts snapshot the
  // parent's error handler at registration time.
  app.setErrorHandler((err: unknown, req, reply) => {
    const body = toErrorResponse(err);
    if (body.status >= 500) req.log.error({ err }, 'request failed');
    else req.log.info({ code: body.error.code }, 'request rejected');
    if (
      isAppError(err) &&
      err.code === 'RATE_LIMITED' &&
      typeof err.details?.retryAfterSeconds === 'number'
    ) {
      void reply.header('retry-after', String(err.details.retryAfterSeconds));
    }
    return reply.status(body.status).send({ error: body.error });
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LinkedIn Profile API',
        version: packageVersion,
        description:
          "Turns LinkedIn profile, company and post URLs into structured JSON, reverse engineered from LinkedIn's internal Voyager API.\n\n" +
          "Sign in at /login with an email code or the shared admin credential; the `sid` cookie authorises `/v1/*`. In Swagger UI \"Try it out\" works once you have signed in on this origin.\n\n" +
          'Playground: https://linkedin-profile-api-c925.onrender.com/?url=https://www.linkedin.com/in/sharmanityam/ · Repo: https://github.com/SharmaNityam/linkedin-profile-api',
      },
      servers: [
        { url: 'https://linkedin-profile-api-c925.onrender.com', description: 'Live' },
        { url: 'http://localhost:3000', description: 'Local' },
      ],
      tags: [
        { name: 'profile', description: 'Look up a LinkedIn member profile by URL' },
        { name: 'company', description: 'Look up a LinkedIn company or school page by URL' },
        { name: 'posts', description: "Fetch a member's newest posts" },
        { name: 'auth', description: 'Email one-time-code sign-in' },
        { name: 'ops', description: 'Health and status' },
      ],
      externalDocs: {
        url: 'https://github.com/SharmaNityam/linkedin-profile-api#readme',
        description: 'Full documentation in the repo README',
      },
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sid' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  // authPlugin and rateLimit are registered before every other route —
  // including the docs UI, /health, /openapi.json and the static playground
  // — because Fastify hooks only apply to routes declared after the hook is
  // added. Registering the limiter first means it sees every request, and
  // the public paths below are exempted explicitly via its `allowList`
  // rather than by accidents of registration order.
  await app.register(authPlugin, {
    sessionKey: options.auth.sessionKey,
    appOrigin: options.auth.appOrigin,
    secureCookies: options.auth.secureCookies,
  });

  await app.register(rateLimit, {
    max: options.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.viewer?.email ?? req.ip,
    // Path matched alone, query string excluded, so `/health?x=1` is exempt
    // just like `/health`. Covers everything `@fastify/static` serves too
    // (`/`, `/index.html`, the sign-in page and the stylesheet both pull in).
    allowList: (req) => {
      const path = req.url.split('?', 1)[0] ?? '';
      return (
        path === '/' ||
        path === '/index.html' ||
        path === '/login' ||
        path === '/login.html' ||
        path === '/app.css' ||
        path === '/health' ||
        path === '/openapi.json' ||
        path === '/docs' ||
        path.startsWith('/docs/')
      );
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Limit is ${ctx.max} per minute per IP.`,
        details: { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) },
      },
    }),
  });

  // Registered before helmet so the docs UI keeps its own, looser CSP; helmet's
  // hooks only apply to routes registered after it.
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: {
      docExpansion: 'list',
      filter: true,
      defaultModelsExpandDepth: -1,
      tryItOutEnabled: true,
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    theme: {
      title: 'LinkedIn Profile API · Docs',
      css: [{ filename: 'theme.css', content: docsThemeCss }],
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The playground renders LinkedIn's CDN images and inline SVG data URIs.
        imgSrc: ["'self'", 'https://media.licdn.com', 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        // The playground's stylesheet is same-origin; its script is inline.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
    // The playground loads cross-origin images that send no CORP header.
    crossOriginEmbedderPolicy: false,
  });

  app.get(
    '/health',
    {
      schema: {
        tags: ['ops'],
        response: { 200: z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }) },
      },
      config: { rateLimit: false },
    },
    async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.get('/openapi.json', { schema: { hide: true }, config: { rateLimit: false } }, async () => app.swagger());
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
    index: ['index.html'],
    decorateReply: false,
    // A route per file rather than one `GET /*`. The wildcard would swallow
    // every unmatched GET and answer it with `reply.callNotFound()`, which
    // skips the not-found route's own hooks — so an unknown path would come
    // back unbudgeted, and 404s are exactly what URL guessing generates. The
    // folder is a handful of files baked into the image, so globbing it once
    // at boot costs nothing and nothing is ever added at runtime.
    wildcard: false,
  });

  // A route per file leaves the sign-in page reachable only as `/login.html`,
  // and the registration above declines to decorate, so a second instance that
  // serves nothing supplies `reply.sendFile` for the extensionless path.
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    serve: false,
  });
  app.get('/login', { schema: { hide: true } }, async (_req, reply) => reply.sendFile('login.html'));

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (request) => {
    const path = request.url.split('?', 1)[0] ?? '';
    throw new AppError('NOT_FOUND', `Route ${request.method} ${path} not found`);
  });

  await app.register(authRoutes, {
    store: options.auth.store,
    mailer: options.auth.mailer,
    otpRateLimitPerHour: options.auth.otpRateLimitPerHour,
    allowedEmailDomains: options.auth.allowedEmailDomains,
    registry: options.auth.registry,
    accountsPerIp: options.auth.accountsPerIp,
    ...(options.auth.admin ? { admin: options.auth.admin } : {}),
  });

  // Encapsulated so requireViewer() gates only /v1/*, not /auth/* or /health.
  await app.register(async (v1) => {
    v1.addHook('preHandler', requireViewer());
    await v1.register(profileRoutes, { services: options.services });
    await v1.register(companyRoutes, { services: options.services });
    await v1.register(postsRoutes, { services: options.services });
  });

  return app;
}

function toErrorResponse(err: unknown): { status: number } & ErrorResponse {
  if (isAppError(err)) {
    return {
      status: err.status,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  const e = err as {
    code?: string;
    statusCode?: number;
    validation?: unknown;
    message?: string;
    error?: ErrorResponse['error'];
  };
  if (e.statusCode === 429 && e.error) return { status: 429, error: e.error };
  // Coerce body-parsing 415/413 errors into 400 for consistency
  if (
    e.validation ||
    e.statusCode === 400 ||
    e.statusCode === 413 ||
    e.statusCode === 415 ||
    e.code?.startsWith('FST_ERR_CTP_')
  ) {
    return {
      status: 400,
      error: { code: 'INVALID_REQUEST', message: e.message ?? 'Invalid request' },
    };
  }
  const internal = new AppError('INTERNAL_ERROR', 'Something went wrong on our side');
  return { status: internal.status, error: { code: internal.code, message: internal.message } };
}
