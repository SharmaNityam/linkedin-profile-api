import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, isAppError } from './errors.js';
import type { ErrorResponse } from './schema/profile.js';
import type { ProfileService } from './linkedin/service.js';
import { profileRoutes } from './routes/profile.js';

export interface BuildAppOptions {
  service: ProfileService;
  rateLimitPerMinute: number;
  logger?: FastifyInstance['log'] | boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
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
          "Turns a LinkedIn profile URL into structured JSON, backed by LinkedIn's internal Voyager API with a headless-browser fallback.",
      },
      tags: [{ name: 'profile' }, { name: 'ops' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(rateLimit, {
    max: options.rateLimitPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Limit is ${ctx.max} per minute per IP.`,
        details: { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) },
      },
    }),
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
  app.get('/', { config: { rateLimit: false } }, async (_req, reply) => reply.redirect('/docs'));

  await app.register(profileRoutes, { service: options.service });

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
    statusCode?: number;
    validation?: unknown;
    message?: string;
    error?: ErrorResponse['error'];
  };
  if (e.statusCode === 429 && e.error) return { status: 429, error: e.error };
  if (e.validation || e.statusCode === 400) {
    return {
      status: 400,
      error: { code: 'INVALID_REQUEST', message: e.message ?? 'Invalid request' },
    };
  }
  const internal = new AppError('INTERNAL_ERROR', 'Something went wrong on our side');
  return { status: internal.status, error: { code: internal.code, message: internal.message } };
}
