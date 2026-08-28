import { z } from 'zod';

export const RequestCodeBody = z.object({
  email: z.string().min(3).max(320).describe('Address to send the one-time code to'),
});
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

export const RequestCodeResponse = z.object({ status: z.literal('code_sent') });
export type RequestCodeResponse = z.infer<typeof RequestCodeResponse>;

export const VerifyBody = z.object({
  email: z.string().min(3).max(320),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export type VerifyBody = z.infer<typeof VerifyBody>;

export const MeResponse = z.object({ email: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;

export const LogoutResponse = z.object({ status: z.literal('signed_out') });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const AuthConfigResponse = z.object({ gate: z.literal('email') });
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;
