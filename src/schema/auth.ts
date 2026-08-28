import { z } from 'zod';

/**
 * The account endpoints' wire shapes. As with the entity schemas, these drive
 * validation, the TypeScript types and the OpenAPI document at once — and they
 * are deliberately narrower than what the service accepts, so obvious junk is
 * rejected before it reaches a password hash or a mail provider.
 */

const Email = z
  .string()
  .email()
  // The longest address RFC 5321 allows; anything longer is not a mailbox.
  .max(254)
  .describe('Email address at one of the accepted consumer providers');

const Password = z
  .string()
  .min(10)
  .max(200)
  .describe('At least 10 characters. Length is the only rule.');

export const SignupBody = z.object({ email: Email, password: Password });
export type SignupBody = z.infer<typeof SignupBody>;

export const VerifyEmailBody = z.object({
  email: Email,
  code: z.string().regex(/^\d{6}$/, 'Verification codes are six digits'),
});
export type VerifyEmailBody = z.infer<typeof VerifyEmailBody>;

export const LoginBody = z.object({ email: Email, password: Password });
export type LoginBody = z.infer<typeof LoginBody>;

export const PhoneBody = z.object({
  phone: z
    .string()
    .min(5)
    .max(32)
    .describe('Mobile number in any readable form; normalised to E.164 server-side'),
});
export type PhoneBody = z.infer<typeof PhoneBody>;

/**
 * Every field is optional: `POST /auth/logout` with no body at all is the
 * common case, and the route normalises that to `{}` before validation.
 */
export const LogoutBody = z.object({
  everywhere: z
    .boolean()
    .optional()
    .describe('Also invalidate every other session already issued to this account'),
});
export type LogoutBody = z.infer<typeof LogoutBody>;

/** Never says whether the address was already registered. */
export const VerificationSentResponse = z.object({ status: z.literal('verification_sent') });
export type VerificationSentResponse = z.infer<typeof VerificationSentResponse>;

export const MeResponse = z.object({
  email: z.string(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  createdAt: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * Which of the two arrives depends on `EMAIL_VERIFICATION`, so both are part of
 * the contract: `verification_sent` when a code was mailed and no account
 * exists yet, and the `/auth/me` shape when the account was created on the
 * signup call itself and the session cookie came back with it.
 */
export const SignupResponse = z.union([VerificationSentResponse, MeResponse]);
export type SignupResponse = z.infer<typeof SignupResponse>;

/**
 * What the playground needs to know before it draws the first screen: which
 * steps this instance actually has. Public, and says nothing about any account.
 */
export const AuthConfigResponse = z.object({
  emailVerification: z
    .enum(['required', 'off'])
    .describe("'off' means signup creates the account and skips the code step"),
  phoneValidation: z
    .enum(['abstract', 'none'])
    .describe("'none' means no provider is configured and every number is 'skipped'"),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

export const PhoneResponse = MeResponse.extend({
  phoneValidation: z
    .enum(['accepted', 'skipped'])
    .describe("'skipped' means the provider gave no verdict and the fail mode is open"),
});
export type PhoneResponse = z.infer<typeof PhoneResponse>;

export const LogoutResponse = z.object({ status: z.literal('signed_out') });
export type LogoutResponse = z.infer<typeof LogoutResponse>;
