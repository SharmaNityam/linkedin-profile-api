import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { canonicalEmail } from '../auth/email.js';
import { domainNotAllowedMessage, isDomainAllowed } from '../auth/domains.js';
import type { MailSender } from '../auth/mailer.js';
import type { OtpStore, VerifyResult } from '../auth/otp.js';
import { AppError } from '../errors.js';
import {
  AuthConfigResponse,
  LogoutResponse,
  MeResponse,
  RequestCodeBody,
  RequestCodeResponse,
  VerifyBody,
} from '../schema/auth.js';
import { ErrorResponse } from '../schema/common.js';

export interface AuthRoutesOptions {
  store: OtpStore;
  mailer: MailSender;
  /** Per-IP budget for the endpoints an anonymous caller can reach. */
  otpRateLimitPerHour: number;
  /** Domains `/auth/request-code` accepts, lowercased and trimmed. */
  allowedEmailDomains: string[];
}

const errorResponses = {
  400: ErrorResponse.describe(
    'Invalid email, a disallowed domain, or the code is wrong, expired or exhausted',
  ),
  429: ErrorResponse.describe('Rate limited'),
};

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (
  app,
  { store, mailer, otpRateLimitPerHour, allowedEmailDomains },
) => {
  /**
   * Anonymous callers hit these, so they're budgeted per IP and per hour on
   * top of the global limit — the ones worth hammering are address
   * enumeration, code guessing, and the mail provider's own quota.
   */
  const perIp = {
    rateLimit: {
      max: otpRateLimitPerHour,
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

  app.get(
    '/auth/config',
    {
      schema: {
        tags: ['auth'],
        summary: 'What kind of access gate this deployment uses',
        response: { 200: AuthConfigResponse },
      },
      config: { rateLimit: false },
    },
    async () => ({ gate: 'email' as const }),
  );

  app.post(
    '/auth/request-code',
    {
      schema: {
        tags: ['auth'],
        summary: 'Mail a one-time code to an address',
        body: RequestCodeBody,
        response: { 200: RequestCodeResponse, ...errorResponses, 502: ErrorResponse },
      },
      config: perIp,
    },
    async (req) => {
      const email = canonicalEmail(req.body.email);
      if (!isDomainAllowed(email, allowedEmailDomains)) {
        throw new AppError('EMAIL_DOMAIN_NOT_ALLOWED', domainNotAllowedMessage(allowedEmailDomains));
      }
      const outcome = store.issue(email);
      if (outcome.status === 'rate_limited') {
        throw new AppError(
          'RATE_LIMITED',
          'Too many codes requested for this address. Try again in an hour.',
          { retryAfterSeconds: 3600 },
        );
      }
      await mailer.sendCode(email, outcome.code);
      return { status: 'code_sent' as const };
    },
  );

  app.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Confirm the emailed code and start a session',
        body: VerifyBody,
        response: { 200: MeResponse, ...errorResponses },
      },
      config: perIp,
    },
    async (req) => {
      const email = canonicalEmail(req.body.email);
      const result = store.verify(email, req.body.code);
      if (result !== 'ok') throw new AppError('INVALID_CODE', invalidCodeMessage(result));
      req.session.set('viewer', { email });
      return { email };
    },
  );

  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'The verified viewer for this session',
        response: { 200: MeResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'Verify your email to use this endpoint');
      return { email: req.viewer.email };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Clear the session cookie',
        response: { 200: LogoutResponse },
      },
      config: { rateLimit: false },
    },
    async (req) => {
      req.session.delete();
      return { status: 'signed_out' as const };
    },
  );
};

function invalidCodeMessage(result: Exclude<VerifyResult, 'ok'>): string {
  switch (result) {
    case 'expired':
      return 'That code has expired. Request a new one.';
    case 'exhausted':
      return 'Too many attempts. Request a new code.';
    case 'mismatch':
    case 'none':
      return 'That code is incorrect.';
  }
}
