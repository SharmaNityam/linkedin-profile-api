import secureSession from '@fastify/secure-session';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    viewer: { email: string };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified viewer for this request, or `null` when unset/unresolved. */
    viewer: { email: string } | null;
  }
}

/** Cookie and session lifetime. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthPluginOptions {
  /** 32 bytes as 64 hex chars; see `SESSION_KEY`. */
  sessionKey: string;
  /** The only `Origin` a state-changing request may declare. */
  appOrigin: string;
  /** `Secure` on the cookie. Off in development, where there is no TLS. */
  secureCookies: boolean;
}

/**
 * Sessions, `request.viewer` and the CSRF guard.
 *
 * Registered with `fastify-plugin` on purpose: the hooks have to apply to
 * every route registered after it — including `@fastify/rate-limit`'s own
 * `onRequest` hook, which keys the limit by `viewer.email` once one exists.
 */
const authPluginFn: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  await app.register(secureSession, {
    key: Buffer.from(options.sessionKey, 'hex'),
    cookieName: 'sid',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies,
      maxAge: SESSION_TTL_SECONDS,
    },
    expiry: SESSION_TTL_SECONDS,
  });

  app.decorateRequest('viewer', null);

  const appOrigin = normalizeOrigin(options.appOrigin);

  app.addHook('onRequest', async (request) => {
    // Decoding the cookie costs a decrypt; skip it for the static/docs paths
    // that never look at `request.viewer`.
    const path = request.url.split('?', 1)[0] ?? '';
    if (path.startsWith('/v1/') || path.startsWith('/auth/')) {
      const viewer = request.session.get('viewer');
      request.viewer = viewer && typeof viewer.email === 'string' ? viewer : null;
    }

    if (!MUTATING_METHODS.has(request.method)) return;

    // SameSite=Lax already blocks the cross-site cookie riding along on
    // anything but a top-level GET; this closes the remaining gap.
    const origin = request.headers.origin;
    if (origin !== undefined && normalizeOrigin(origin) !== appOrigin) {
      throw new AppError('FORBIDDEN_ORIGIN', `Requests from ${origin} are not accepted`, {
        origin,
      });
    }

    if (!hasBody(request)) return;
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new AppError('INVALID_REQUEST', 'Expected application/json');
    }
  });
};

export const authPlugin = fp(authPluginFn, { name: 'auth' });

/** The gate on `/v1/*`: a valid cookie is not optional. */
export function requireViewer(): preHandlerAsyncHookHandler {
  return async (request) => {
    if (!request.viewer) {
      throw new AppError('UNAUTHENTICATED', 'Verify your email to use this endpoint');
    }
  };
}

/** Trailing slashes are not significant in an `Origin`; treat them as equal. */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

function hasBody(request: FastifyRequest): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return length !== undefined && length !== '0';
}
