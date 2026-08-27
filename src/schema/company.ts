import { z } from 'zod';
import { Image, Meta } from './common.js';

export const CompanyResponse = z.object({
  url: z.string().url().describe('Canonical page URL'),
  universalName: z.string(),
  urn: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['company', 'school']),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  industries: z.array(z.string()),
  companyType: z.string().nullable().describe('e.g. "Privately Held"'),
  staffCount: z.number().int().nullable().describe('Members who list this company'),
  staffCountRange: z
    .object({ start: z.number().int(), end: z.number().int().nullable() })
    .nullable(),
  followerCount: z.number().int().nullable(),
  headquarters: z
    .object({
      city: z.string().nullable(),
      region: z.string().nullable(),
      country: z.string().nullable(),
      postalCode: z.string().nullable(),
      line1: z.string().nullable(),
    })
    .nullable(),
  foundedYear: z.number().int().nullable(),
  specialities: z.array(z.string()),
  phone: z.string().nullable(),
  logo: Image.nullable(),
  backgroundImage: Image.nullable(),
  meta: Meta,
});
export type CompanyResponse = z.infer<typeof CompanyResponse>;
export type CompanyData = Omit<CompanyResponse, 'meta'>;
