import secureSession from '@fastify/secure-session';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';
import type { User } from './repositories.js';
import type { AuthService, SessionClaims } from './service.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    claims: SessionClaims;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The account behind the session cookie, resolved once per request, or
     * `null` when there is no valid session. Always set — routes never have to
     * decode a cookie themselves.
     */
    currentUser: User | null;
  }
}

/** Cookie and session lifetime. Rolling: every request that resolves renews it. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The single key the session cookie carries. */
const CLAIMS = 'claims';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthPluginOptions {
  auth: AuthService;
  /** 32 bytes as 64 hex chars; see `SESSION_KEY`. */
  sessionKey: string;
  /** The only `Origin` a state-changing request may declare. */
  appOrigin: string;
  /** `Secure` on the cookie. Off in development, where there is no TLS. */
  secureCookies: boolean;
}

type Session = FastifyRequest['session'];

/**
 * Sessions, `request.currentUser` and the CSRF guard.
 *
 * Registered with `fastify-plugin` on purpose: the hooks have to apply to
 * every route registered after it — including `@fastify/rate-limit`'s own
 * `onRequest` hook, which reads `request.currentUser` to key the limit by
 * account. Encapsulating this would silently key everything by IP.
 */
const auth: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
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

  app.decorateRequest('currentUser', null);

  // Resolving here rather than in a preHandler means the rate limiter, which
  // runs on onRequest, can already see who is asking.
  app.addHook('onRequest', async (request) => {
    const claims = readClaims(request.session);
    if (!claims) {
      request.currentUser = null;
      return;
    }

    const user = await options.auth.resolve(claims);
    request.currentUser = user;
    if (!user) {
      // The account is gone or every session was revoked: stop sending a
      // cookie that will never resolve again.
      request.session.delete();
      return;
    }
    request.session.touch();
  });

  const appOrigin = normalizeOrigin(options.appOrigin);

  /**
   * `SameSite=Lax` already blocks the cross-site cookie from riding along on
   * anything but a top-level GET; this closes the remaining gap the old
   * browsers leave, and rejects the form-encoded content types a plain HTML
   * form can send cross-site.
   */
  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;

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

export const authPlugin = fp(auth, { name: 'auth' });

/**
 * The gate on `/v1/*`: a session is not enough, the account has to have made
 * it all the way through the flow.
 */
export function requireAccount(): preHandlerAsyncHookHandler {
  return async (request) => {
    const user = request.currentUser;
    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'Sign in to use this endpoint');
    }
    if (!user.phoneVerifiedAt) {
      throw new AppError(
        'PHONE_REQUIRED',
        'Add a phone number to your account to use this endpoint',
      );
    }
  };
}

/** Issues the session cookie. The only place claims are written. */
export function setClaims(session: Session, claims: SessionClaims): void {
  session.set(CLAIMS, claims);
}

/**
 * The cookie is authenticated encryption, so its contents are ours — but it
 * may have been minted by an older build, so the shape is still checked.
 */
function readClaims(session: Session): SessionClaims | undefined {
  const raw = session.get(CLAIMS) as Partial<SessionClaims> | undefined;
  if (!raw) return undefined;
  if (typeof raw.userId !== 'string') return undefined;
  if (typeof raw.sessionVersion !== 'number') return undefined;
  return { userId: raw.userId, sessionVersion: raw.sessionVersion, issuedAt: raw.issuedAt ?? 0 };
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
