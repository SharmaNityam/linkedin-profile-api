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
import { AppError, isAppError } from './errors.js';
import type { ErrorResponse } from './schema/profile.js';
import type { LinkedInService } from './linkedin/service.js';
import { companyRoutes } from './routes/company.js';
import { postsRoutes } from './routes/posts.js';
import { profileRoutes } from './routes/profile.js';

export interface BuildAppOptions {
  services: LinkedInService;
  /** Per IP. */
  rateLimitPerMinute: number;
  /** A pino instance to log through; omitted in tests. */
  logger?: FastifyBaseLogger;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    requestIdHeader: 'x-request-id',
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
        version: '1.0.0',
        description:
          "Turns LinkedIn profile, company and post URLs into structured JSON, reverse engineered from LinkedIn's internal Voyager API.",
      },
      tags: [{ name: 'profile' }, { name: 'company' }, { name: 'posts' }, { name: 'ops' }],
    },
    transform: jsonSchemaTransform,
  });
  // Registered before helmet so the docs UI keeps its own, looser CSP; helmet's
  // hooks only apply to routes registered after it.
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The playground renders LinkedIn's CDN images and inline SVG data URIs.
        imgSrc: ["'self'", 'https://media.licdn.com', 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        // The playground is a single file: its script and styles are inline.
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

  app.get('/openapi.json', { config: { rateLimit: false } }, async () => app.swagger());
  // The playground UI. A single self-contained file; no build step.
  // Registered before the rate limiter, whose hook only covers routes declared
  // after it: loading the page and its assets must never spend the budget.
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
    index: ['index.html'],
    decorateReply: false,
    // A route per file rather than one `GET /*`. The wildcard would swallow
    // every unmatched GET and answer it with `reply.callNotFound()`, which
    // skips the not-found route's own hooks — so an unknown path would come
    // back unbudgeted, and 404s are exactly what URL guessing generates. The
    // folder is a single file baked into the image, so globbing it once at
    // boot costs nothing and nothing is ever added at runtime.
    wildcard: false,
  });

  await app.register(rateLimit, {
    max: options.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Matched on the path alone: `req.url` carries the query string, so a
    // bare `===` would miss `/health?x=1`, and a bare `startsWith('/docs')`
    // would exempt a `/docsomething` route added later.
    allowList: (req) => {
      const path = req.url.split('?', 1)[0] ?? '';
      return (
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

  /**
   * An unknown path is still an error this API reports, so it gets the same
   * envelope as every other one rather than Fastify's default body.
   *
   * The `preHandler` is `@fastify/rate-limit`'s documented way to budget the
   * not-found path: without it, 404s are the one response an attacker can
   * generate without limit, which is exactly what URL guessing needs. The query
   * string is dropped from the message so nothing the caller supplied beyond
   * the path is echoed back.
   */
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (request) => {
    const path = request.url.split('?', 1)[0] ?? '';
    throw new AppError('NOT_FOUND', `Route ${request.method} ${path} not found`);
  });

  await app.register(profileRoutes, { services: options.services });
  await app.register(companyRoutes, { services: options.services });
  await app.register(postsRoutes, { services: options.services });

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
  // Fastify's own body-parsing failures — an unsupported or malformed
  // content type (415), a body larger than the limit (413). All of them are
  // the caller sending something we cannot accept, which is a 400 here; the
  // envelope stays one shape rather than leaking Fastify's status codes.
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
