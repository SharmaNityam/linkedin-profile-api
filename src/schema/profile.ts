import { z } from 'zod';

/**
 * Public response schema. This is the single source of truth: it drives the
 * TypeScript types, runtime validation of what we return, and the OpenAPI doc.
 *
 * Conventions: a field that LinkedIn does not expose for a profile is `null`;
 * a list section the profile does not have is `[]`. Dates are `{year, month?}`
 * because LinkedIn stores month precision — we never invent a day.
 */

export const PartialDate = z
  .object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12).optional(),
  })
  .describe('Month-precision date as LinkedIn stores it');

export const Image = z.object({
  url: z.string().url().describe('Largest available rendition'),
  variants: z
    .array(z.object({ width: z.number().int(), height: z.number().int(), url: z.string().url() }))
    .describe('All renditions, smallest first'),
});

export const Organization = z.object({
  name: z.string(),
  linkedinUrl: z.string().url().nullable(),
  logoUrl: z.string().url().nullable(),
  universalName: z.string().nullable().describe('Slug used in linkedin.com/company/<slug>'),
});

export const Experience = z.object({
  title: z.string(),
  companyName: z.string().nullable(),
  company: Organization.nullable(),
  employmentType: z.string().nullable().describe('e.g. "Full-time", "Internship"'),
  location: z.string().nullable(),
  description: z.string().nullable(),
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
  isCurrent: z.boolean(),
});

export const Education = z.object({
  schoolName: z.string().nullable(),
  school: Organization.nullable(),
  degree: z.string().nullable(),
  fieldOfStudy: z.string().nullable(),
  grade: z.string().nullable(),
  activities: z.string().nullable(),
  description: z.string().nullable(),
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
});

export const Skill = z.object({ name: z.string() });

export const Certification = z.object({
  name: z.string(),
  authority: z.string().nullable(),
  organization: Organization.nullable(),
  licenseNumber: z.string().nullable(),
  url: z.string().nullable(),
  issuedAt: PartialDate.nullable(),
  expiresAt: PartialDate.nullable(),
});

export const Language = z.object({
  name: z.string(),
  proficiency: z
    .enum([
      'ELEMENTARY',
      'LIMITED_WORKING',
      'PROFESSIONAL_WORKING',
      'FULL_PROFESSIONAL',
      'NATIVE_OR_BILINGUAL',
    ])
    .nullable(),
});

export const Volunteering = z.object({
  role: z.string(),
  organizationName: z.string().nullable(),
  organization: Organization.nullable(),
  cause: z.string().nullable(),
  description: z.string().nullable(),
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
});

export const Project = z.object({
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
});

export const Honor = z.object({
  title: z.string(),
  issuer: z.string().nullable(),
  description: z.string().nullable(),
  issuedAt: PartialDate.nullable(),
});

export const Publication = z.object({
  title: z.string(),
  publisher: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  publishedAt: PartialDate.nullable(),
});

export const Course = z.object({ name: z.string(), number: z.string().nullable() });

export const Meta = z.object({
  source: z.enum(['voyager', 'browser']).describe('Which extraction path produced this response'),
  fetchedAt: z.string().datetime(),
  cached: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  partial: z
    .boolean()
    .describe('true when the fallback path was used and some sections may be missing'),
  warnings: z.array(z.string()),
});

export const ProfileResponse = z.object({
  url: z.string().url().describe('Canonical profile URL'),
  publicIdentifier: z.string(),
  urn: z.string().nullable().describe('LinkedIn internal profile URN'),
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  pronouns: z.string().nullable(),
  headline: z.string().nullable(),
  about: z.string().nullable(),
  location: z
    .object({ name: z.string().nullable(), countryCode: z.string().nullable() })
    .nullable(),
  industry: z.string().nullable(),
  isPremium: z.boolean().nullable(),
  profileImage: Image.nullable(),
  backgroundImage: Image.nullable(),
  experience: z.array(Experience),
  education: z.array(Education),
  skills: z.array(Skill),
  certifications: z.array(Certification),
  languages: z.array(Language),
  volunteering: z.array(Volunteering),
  projects: z.array(Project),
  honors: z.array(Honor),
  publications: z.array(Publication),
  courses: z.array(Course),
  meta: Meta,
});

export type ProfileResponse = z.infer<typeof ProfileResponse>;
export type ProfileData = Omit<ProfileResponse, 'meta'>;
export type PartialDate = z.infer<typeof PartialDate>;
export type Image = z.infer<typeof Image>;
export type Organization = z.infer<typeof Organization>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
