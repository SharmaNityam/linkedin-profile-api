import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../../src/linkedin/voyager/normalize.js';
import { SchemaDriftError } from '../../src/errors.js';
import { ProfileResponse } from '../../src/schema/profile.js';
import { loadFixture } from '../helpers/fixtures.js';

const full = loadFixture('minimal', 'full.json');
const topCard = loadFixture('minimal', 'topcard.json');
const skillsPage = loadFixture('minimal', 'skills-page.json');

describe('normalizeProfile (minimal fixture)', () => {
  const profile = normalizeProfile({ full, topCard, skillPages: [skillsPage] });

  it('produces output that satisfies the public schema', () => {
    const meta = {
      source: 'voyager',
      fetchedAt: new Date().toISOString(),
      cached: false,
      durationMs: 1,
      partial: false,
      warnings: [],
    };
    expect(ProfileResponse.safeParse({ ...profile, meta }).success).toBe(true);
  });

  it('maps identity fields and trims whitespace', () => {
    expect(profile).toMatchObject({
      url: 'https://www.linkedin.com/in/jane-doe/',
      publicIdentifier: 'jane-doe',
      urn: 'urn:li:fsd_profile:ABC',
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      pronouns: 'She/Her',
      headline: 'Engineer @Acme',
      about: 'I build things.',
      industry: 'Computer Software',
      isPremium: false,
    });
  });

  it('resolves the location name from the top-card decoration', () => {
    expect(profile.location).toEqual({ name: 'Chennai, Tamil Nadu, India', countryCode: 'IN' });
  });

  it('falls back to countryCode-only location when the top card is absent', () => {
    expect(normalizeProfile({ full }).location).toEqual({ name: null, countryCode: 'IN' });
  });

  it('builds image URLs from rootUrl + segment, largest first as `url`', () => {
    expect(profile.profileImage?.url).toBe(
      'https://media.licdn.com/dms/image/v2/X/profile-displayphoto-crop_800_800/c',
    );
    expect(profile.profileImage?.variants.map((v) => v.width)).toEqual([100, 400, 800]);
    expect(profile.backgroundImage).toBeNull();
  });

  it('flattens position groups into experience, preserving order', () => {
    expect(profile.experience).toEqual([
      {
        title: 'Senior Engineer',
        companyName: 'Acme',
        company: {
          name: 'Acme',
          linkedinUrl: 'https://www.linkedin.com/company/acme/',
          logoUrl: 'https://media.licdn.com/dms/image/v2/L/company-logo_200_200/x',
          universalName: 'acme',
        },
        employmentType: 'Full-time',
        location: 'Chennai, India',
        description: 'Leading the platform team.',
        startDate: { year: 2024, month: 3 },
        endDate: null,
        isCurrent: true,
      },
      expect.objectContaining({
        title: 'Engineer',
        companyName: 'Acme',
        employmentType: null,
        startDate: { year: 2022, month: 1 },
        endDate: { year: 2024, month: 2 },
        isCurrent: false,
      }),
      expect.objectContaining({
        title: 'Intern',
        companyName: 'Stealth Startup',
        company: null,
        employmentType: 'Internship',
        startDate: { year: 2021 },
        endDate: { year: 2021 },
      }),
    ]);
  });

  it('maps education with school organization and year-only dates', () => {
    expect(profile.education).toEqual([
      {
        schoolName: 'SRM Institute',
        school: {
          name: 'SRM Institute',
          linkedinUrl: 'https://www.linkedin.com/school/srm/',
          logoUrl: null,
          universalName: null,
        },
        degree: 'B.Tech',
        fieldOfStudy: 'Computer Science',
        grade: '9.1',
        activities: null,
        description: null,
        startDate: { year: 2021 },
        endDate: { year: 2025 },
      },
    ]);
  });

  it('merges paged skills and de-duplicates case-insensitively', () => {
    expect(profile.skills.map((s) => s.name)).toEqual(['TypeScript', 'Flutter', 'Rust']);
  });

  it('keeps certifications even when the issuing company entity is missing', () => {
    expect(profile.certifications).toEqual([
      {
        name: 'AWS Certified',
        authority: 'Amazon',
        organization: null,
        licenseNumber: 'XYZ',
        url: 'https://example.com/cert',
        issuedAt: { year: 2023, month: 5 },
        expiresAt: null,
      },
    ]);
  });

  it('maps languages and nulls unknown proficiency values', () => {
    expect(profile.languages).toEqual([
      { name: 'Hindi', proficiency: 'NATIVE_OR_BILINGUAL' },
      { name: 'Klingon', proficiency: null },
    ]);
  });

  it('maps volunteering', () => {
    expect(profile.volunteering).toEqual([
      {
        role: 'Mentor',
        organizationName: 'Code Club',
        organization: null,
        cause: 'EDUCATION',
        description: 'Weekly sessions',
        startDate: { year: 2020, month: 9 },
        endDate: null,
      },
    ]);
  });

  it('returns empty arrays for sections the profile does not have', () => {
    expect(profile.projects).toEqual([]);
    expect(profile.honors).toEqual([]);
    expect(profile.publications).toEqual([]);
    expect(profile.courses).toEqual([]);
  });

  it('throws SchemaDriftError when the root profile entity is missing', () => {
    expect(() => normalizeProfile({ full: { data: { '*elements': [] }, included: [] } })).toThrow(
      SchemaDriftError,
    );
    expect(() => normalizeProfile({ full: {} })).toThrow(SchemaDriftError);
  });

  it('tolerates a profile with no sections at all', () => {
    const bare = normalizeProfile({
      full: {
        data: { '*elements': ['urn:li:fsd_profile:X'] },
        included: [
          {
            entityUrn: 'urn:li:fsd_profile:X',
            $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
            publicIdentifier: 'x-y-z',
            firstName: 'X',
          },
        ],
      },
    });
    expect(bare.fullName).toBe('X');
    expect(bare.location).toBeNull();
    expect(bare.experience).toEqual([]);
    expect(bare.profileImage).toBeNull();
    expect(bare.pronouns).toBeNull();
  });
});
