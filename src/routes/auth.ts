import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { setClaims } from '../auth/plugin.js';
import type { User } from '../auth/repositories.js';
import type { AuthService, EmailVerificationMode } from '../auth/service.js';
import { AppError } from '../errors.js';
import {
  AuthConfigResponse,
  LoginBody,
  LogoutBody,
  LogoutResponse,
  MeResponse,
  PhoneBody,
  PhoneResponse,
  SignupBody,
  SignupResponse,
  VerifyEmailBody,
} from '../schema/auth.js';
import { ErrorResponse } from '../schema/common.js';

export interface AuthRoutesOptions {
  auth: AuthService;
  /** Per-IP budget for the endpoints an anonymous caller can reach. */
  authRateLimitPerHour: number;
  /** Reported by `GET /auth/config` so a client knows which steps exist here. */
  emailVerification: EmailVerificationMode;
  /** Whether a phone-validation provider is configured. */
  phoneValidation: 'abstract' | 'none';
}

const errorResponses = {
  400: ErrorResponse.describe('The body is malformed, or the code or phone number was rejected'),
  401: ErrorResponse.describe('Not signed in, or the credentials are wrong'),
  403: ErrorResponse.describe('Phone number required, or the request came from another origin'),
  409: ErrorResponse.describe(
    'That phone number, or that email address, belongs to another account',
  ),
  429: ErrorResponse.describe('Rate limited'),
};

/**
 * The account endpoints. Every rule lives in `AuthService`; these handlers map
 * a body in, an `AppError` or a response out, and own exactly one extra thing:
 * writing the session cookie.
 */
export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (
  app,
  { auth, authRateLimitPerHour, emailVerification, phoneValidation },
) => {
  /**
   * The endpoints an anonymous caller can reach are budgeted per IP and per
   * hour, not by the global per-account limit — there is no account yet, and
   * these are the ones worth hammering (address enumeration, code guessing,
   * password spraying, and our mail provider's quota).
   */
  const perIp = {
    rateLimit: {
      max: authRateLimitPerHour,
      timeWindow: '1 hour',
      keyGenerator: (req: FastifyRequest) => req.ip,
      errorResponseBuilder: (_req: FastifyRequest, ctx: { max: number; ttl: number }) => ({
        statusCode: 429,
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Limit is ${ctx.max} per hour per IP.`,
          details: { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) },
        },
      }),
    },
  };

  app.post(
    '/auth/signup',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create an account, sending a verification code when one is required',
        description:
          'With EMAIL_VERIFICATION=required this mails a six-digit code and answers ' +
          '`{"status":"verification_sent"}`, the same way whether or not the address is ' +
          'already registered. With EMAIL_VERIFICATION=off it creates the verified ' +
          'account, sets the session cookie and answers with the /auth/me shape, or ' +
          '409 EMAIL_TAKEN if the address already has an account. GET /auth/config ' +
          'reports which of the two this instance does.',
        body: SignupBody,
        response: { 200: SignupResponse, ...errorResponses },
      },
      config: perIp,
    },
    async (req) => {
      const session = await auth.signup(req.body.email, req.body.password);
      if (!session) return { status: 'verification_sent' as const };
      setClaims(req.session, session.claims);
      return session.me;
    },
  );

  app.get(
    '/auth/config',
    {
      schema: {
        tags: ['auth'],
        summary: 'Which account steps this instance has',
        description:
          'Public, and unbudgeted: a client has to read it before it can draw the first ' +
          'screen, and it says nothing about any account.',
        response: { 200: AuthConfigResponse },
      },
      config: { rateLimit: false },
    },
    async () => ({ emailVerification, phoneValidation }),
  );

  app.post(
    '/auth/verify-email',
    {
      schema: {
        tags: ['auth'],
        summary: 'Confirm the emailed code and start a session',
        body: VerifyEmailBody,
        response: { 200: MeResponse, ...errorResponses },
      },
      config: perIp,
    },
    async (req) => {
      const { claims, me } = await auth.verifyEmail(req.body.email, req.body.code);
      setClaims(req.session, claims);
      return me;
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start a session with an email and password',
        body: LoginBody,
        response: { 200: MeResponse, ...errorResponses },
      },
      config: perIp,
    },
    async (req) => {
      const { claims, me } = await auth.login(req.body.email, req.body.password);
      setClaims(req.session, claims);
      return me;
    },
  );

  app.post(
    '/auth/phone',
    {
      schema: {
        tags: ['auth'],
        summary: 'Link a mobile number to the signed-in account',
        body: PhoneBody,
        response: { 200: PhoneResponse, ...errorResponses },
      },
      config: perIp,
    },
    async (req) => {
      const { me, phoneValidation } = await auth.setPhone(currentUser(req).id, req.body.phone);
      return { ...me, phoneValidation };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Clear the session cookie',
        body: LogoutBody,
        response: { 200: LogoutResponse, ...errorResponses },
      },
      // Being over budget must not trap someone in a session they cannot end,
      // and a sign-out costs nothing upstream.
      config: { rateLimit: false },
      // A body-less POST parses to `null`, which the schema would reject; a
      // client that just wants to sign out should not have to send `{}`.
      preValidation: async (req) => {
        req.body ??= {};
      },
    },
    async (req) => {
      // Signing out an already-signed-out caller is a no-op, not an error.
      if (req.body.everywhere === true && req.currentUser) {
        await auth.logoutEverywhere(req.currentUser.id);
      }
      req.session.delete();
      return { status: 'signed_out' as const };
    },
  );

  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'The signed-in account',
        response: { 200: MeResponse, ...errorResponses },
      },
    },
    async (req) => auth.me(currentUser(req)),
  );
};

function currentUser(req: FastifyRequest): User {
  const user = req.currentUser;
  if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to use this endpoint');
  return user;
}
