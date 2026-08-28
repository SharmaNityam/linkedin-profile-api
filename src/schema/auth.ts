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
  email: EmailAddress.describe('Address to send the one-time code to').meta({
    example: 'you@example.com',
  }),
});
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

export const RequestCodeResponse = z.object({ status: z.literal('code_sent') });
export type RequestCodeResponse = z.infer<typeof RequestCodeResponse>;

export const VerifyBody = z.object({
  email: EmailAddress.describe('Address the code was sent to').meta({
    example: 'you@example.com',
  }),
  code: z
    .string()
    .regex(/^\d{6}$/, 'Code must be 6 digits')
    .describe('The 6-digit code emailed to you')
    .meta({ example: '123456' }),
});
export type VerifyBody = z.infer<typeof VerifyBody>;

export const VerifyResponse = z.object({ email: z.string() });
export type VerifyResponse = z.infer<typeof VerifyResponse>;

export const Role = z.enum(['user', 'admin']);
export type Role = z.infer<typeof Role>;

export const MeResponse = z.object({ email: z.string(), role: Role });
export type MeResponse = z.infer<typeof MeResponse>;

export const LoginBody = z.object({
  email: EmailAddress.describe('The shared admin address'),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const LogoutResponse = z.object({ status: z.literal('signed_out') });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const AuthConfigResponse = z.object({
  gate: z.literal('email'),
  domains: z.array(z.string()).describe('Email domains /auth/request-code accepts'),
  admin: z.boolean().describe('Whether an admin login (POST /auth/login) is configured'),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;
