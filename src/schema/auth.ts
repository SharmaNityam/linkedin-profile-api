import { z } from 'zod';

/**
 * Trimmed, lowercased, and shaped like an email before it ever reaches
 * `canonicalEmail` (which does the Gmail-specific folding and the stricter,
 * defense-in-depth character checks). `z.email().max(254)` rather than
 * `.pipe(z.email()).max(254)`: `ZodPipe` doesn't expose `.max`, so the length
 * cap is applied on the email schema itself.
 */
const EmailAddress = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const RequestCodeBody = z.object({
  email: EmailAddress.describe('Address to send the one-time code to'),
});
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

export const RequestCodeResponse = z.object({ status: z.literal('code_sent') });
export type RequestCodeResponse = z.infer<typeof RequestCodeResponse>;

export const VerifyBody = z.object({
  email: EmailAddress,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export type VerifyBody = z.infer<typeof VerifyBody>;

export const MeResponse = z.object({ email: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;

export const LogoutResponse = z.object({ status: z.literal('signed_out') });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const AuthConfigResponse = z.object({ gate: z.literal('email') });
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;
