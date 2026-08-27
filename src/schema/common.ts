import { z } from 'zod';

export const Image = z.object({
  url: z.string().url().describe('Largest available rendition'),
  variants: z
    .array(z.object({ width: z.number().int(), height: z.number().int(), url: z.string().url() }))
    .describe('All renditions, smallest first'),
});
export type Image = z.infer<typeof Image>;

export const Meta = z.object({
  source: z.literal('voyager').describe('Where the data came from'),
  fetchedAt: z.string().datetime(),
  cached: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type Meta = z.infer<typeof Meta>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
