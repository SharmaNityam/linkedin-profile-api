import { SchemaDriftError } from '../../errors.js';
import type { Image, Organization, PartialDate, ProfileData } from '../../schema/profile.js';
import { EntityGraph } from './graph.js';
import {
  TYPES,
  type VectorImage,
  type VoyagerDate,
  type VoyagerDateRange,
  type VoyagerEntity,
  type VoyagerResponse,
} from './types.js';

/** The raw responses that together describe one profile. */
export interface ProfileBundle {
  /** FullProfileWithEntities decoration, the main entity graph. */
  full: VoyagerResponse;
  /** WebTopCardCore decoration, resolves the location name. Optional. */
  topCard?: VoyagerResponse;
  /** Extra pages from /profileSkills when the profile has > 20 skills. */
  skillPages?: VoyagerResponse[];
}

/**
 * Turns LinkedIn's entity graph into our public schema. Pure and synchronous
 * so it can be tested exhaustively against recorded fixtures.
 */
export function normalizeProfile(bundle: ProfileBundle): ProfileData {
  const graph = new EntityGraph(bundle.full, bundle.topCard ?? {}, ...(bundle.skillPages ?? []));

  const profile = graph.rootElements().find((e) => e.$type === TYPES.profile);
  if (!profile) {
    throw new SchemaDriftError('Voyager response did not contain a root Profile entity', {
      rootElements: graph.rootElements().map((e) => e.$type),
      entityCount: graph.size,
    });
  }

  const publicIdentifier = str(profile.publicIdentifier);
  if (!publicIdentifier) {
    throw new SchemaDriftError('Profile entity has no publicIdentifier');
  }

  const firstName = str(profile.firstName) ?? '';
  const lastName = str(profile.lastName) ?? '';

  return {
    url: `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier)}/`,
    publicIdentifier,
    urn: str(profile.entityUrn),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    pronouns: pronouns(profile.pronounUnion),
    headline: str(profile.headline),
    about: str(profile.summary),
    location: location(graph, profile),
    industry: str(graph.ref(profile, 'industry')?.name),
    isPremium:
      typeof profile.showPremiumSubscriberBadge === 'boolean'
        ? profile.showPremiumSubscriberBadge
        : null,
    profileImage: image(pictureOf(profile.profilePicture)),
    backgroundImage: image(pictureOf(profile.backgroundPicture)),
    experience: experience(graph, profile),
    education: graph.collection(profile, 'profileEducations').elements.map((e) => ({
      schoolName: str(e.schoolName),
      school: organization(graph.ref(e, 'school')),
      degree: str(e.degreeName),
      fieldOfStudy: str(e.fieldOfStudy),
      grade: str(e.grade),
      activities: str(e.activities),
      description: str(e.description),
      ...dates(e.dateRange),
    })),
    skills: skills(graph, profile, bundle.skillPages ?? []),
    certifications: graph.collection(profile, 'profileCertifications').elements.map((c) => {
      const { startDate, endDate } = dates(c.dateRange);
      return {
        name: str(c.name) ?? '',
        authority: str(c.authority),
        organization: organization(graph.ref(c, 'company')),
        licenseNumber: str(c.licenseNumber),
        url: str(c.url),
        issuedAt: startDate,
        expiresAt: endDate,
      };
    }),
    languages: graph.collection(profile, 'profileLanguages').elements.map((l) => ({
      name: str(l.name) ?? '',
      proficiency: proficiency(l.proficiency),
    })),
    volunteering: graph.collection(profile, 'profileVolunteerExperiences').elements.map((v) => ({
      role: str(v.role) ?? '',
      organizationName: str(v.companyName),
      organization: organization(graph.ref(v, 'company')),
      cause: str(v.cause),
      description: str(v.description),
      ...dates(v.dateRange),
    })),
    projects: graph.collection(profile, 'profileProjects').elements.map((p) => ({
      title: str(p.title) ?? '',
      description: str(p.description),
      url: str(p.url),
      ...dates(p.dateRange),
    })),
    honors: graph.collection(profile, 'profileHonors').elements.map((h) => ({
      title: str(h.title) ?? '',
      issuer: str(h.issuer),
      description: str(h.description),
      issuedAt: date(h.issuedOn),
    })),
    publications: graph.collection(profile, 'profilePublications').elements.map((p) => ({
      title: str(p.name) ?? '',
      publisher: str(p.publisher),
      description: str(p.description),
      url: str(p.url),
      publishedAt: date(p.publishedOn),
    })),
    courses: graph.collection(profile, 'profileCourses').elements.map((c) => ({
      name: str(c.name) ?? '',
      number: str(c.number),
    })),
  };
}

// ---------------------------------------------------------------------------
// Sections

function experience(graph: EntityGraph, profile: VoyagerEntity): ProfileData['experience'] {
  const groups = graph.collection(profile, 'profilePositionGroups').elements;
  return groups.flatMap((group) => {
    const groupCompany = graph.ref(group, 'company');
    return graph.collection(group, 'profilePositionInPositionGroup').elements.map((pos) => {
      const { startDate, endDate } = dates(pos.dateRange);
      return {
        title: str(pos.title) ?? '',
        companyName: str(pos.companyName) ?? str(group.companyName),
        company: organization(graph.ref(pos, 'company') ?? groupCompany),
        employmentType: str(graph.ref(pos, 'employmentType')?.name),
        location: str(pos.locationName) ?? str(pos.geoLocationName),
        description: str(pos.description),
        startDate,
        endDate,
        isCurrent: startDate !== null && endDate === null,
      };
    });
  });
}

function skills(
  graph: EntityGraph,
  profile: VoyagerEntity,
  pages: VoyagerResponse[],
): ProfileData['skills'] {
  const fromProfile = graph.collection(profile, 'profileSkills').elements;
  const fromPages = pages.flatMap((page) => graph.refs(page.data, 'elements'));
  const seen = new Set<string>();
  const out: ProfileData['skills'] = [];
  for (const s of [...fromProfile, ...fromPages]) {
    const name = str(s.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name });
  }
  return out;
}

function location(graph: EntityGraph, profile: VoyagerEntity): ProfileData['location'] {
  const geoLocation = asRecord(profile.geoLocation);
  const geo = graph.ref(geoLocation, 'geo');
  const name = str(geo?.defaultLocalizedName) ?? str(profile.locationName);
  const countryCode = str(asRecord(profile.location)?.countryCode);
  return name || countryCode ? { name, countryCode } : null;
}

function organization(entity: VoyagerEntity | undefined): Organization | null {
  const name = str(entity?.name);
  if (!entity || !name) return null;
  const logo = asRecord(entity.logo);
  return {
    name,
    linkedinUrl: str(entity.url),
    logoUrl: image(logo?.vectorImage as VectorImage | undefined)?.url ?? null,
    universalName: str(entity.universalName),
  };
}

// ---------------------------------------------------------------------------
// Primitives

function pictureOf(picture: unknown): VectorImage | undefined {
  const ref = asRecord(asRecord(picture)?.displayImageReference);
  return ref?.vectorImage as VectorImage | undefined;
}

export function image(vector: VectorImage | undefined): Image | null {
  const root = vector?.rootUrl;
  if (!root || !Array.isArray(vector.artifacts)) return null;
  const variants = vector.artifacts
    .filter((a) => a.fileIdentifyingUrlPathSegment && a.width && a.height)
    .map((a) => ({
      width: a.width!,
      height: a.height!,
      url: root + a.fileIdentifyingUrlPathSegment!,
    }))
    .sort((a, b) => a.width - b.width);
  const largest = variants.at(-1);
  return largest ? { url: largest.url, variants } : null;
}

function date(d: unknown): PartialDate | null {
  const v = d as VoyagerDate | null | undefined;
  if (!v || typeof v.year !== 'number') return null;
  return typeof v.month === 'number' ? { year: v.year, month: v.month } : { year: v.year };
}

function dates(range: unknown): { startDate: PartialDate | null; endDate: PartialDate | null } {
  const r = range as VoyagerDateRange | null | undefined;
  return { startDate: date(r?.start), endDate: date(r?.end) };
}

const PRONOUNS: Record<string, string> = {
  HE_HIM: 'He/Him',
  SHE_HER: 'She/Her',
  THEY_THEM: 'They/Them',
};

function pronouns(union: unknown): string | null {
  const u = asRecord(union);
  if (!u) return null;
  const standardized = str(u.standardizedPronoun);
  if (standardized) return PRONOUNS[standardized] ?? standardized;
  return str(u.customPronoun);
}

const PROFICIENCIES = new Set([
  'ELEMENTARY',
  'LIMITED_WORKING',
  'PROFESSIONAL_WORKING',
  'FULL_PROFESSIONAL',
  'NATIVE_OR_BILINGUAL',
]);

function proficiency(value: unknown): ProfileData['languages'][number]['proficiency'] {
  return typeof value === 'string' && PROFICIENCIES.has(value)
    ? (value as ProfileData['languages'][number]['proficiency'])
    : null;
}

export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asRecord(value: unknown): VoyagerEntity | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as VoyagerEntity)
    : undefined;
}
