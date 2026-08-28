import { describe, expect, it } from 'vitest';
import { normalizeCompany } from '../../src/linkedin/voyager/normalize-company.js';
import { CompanyResponse } from '../../src/schema/company.js';
import { loadEntityFixture } from '../helpers/fixtures.js';
import { SchemaDriftError } from '../../src/errors.js';

const company = loadEntityFixture('company', 'minimal', 'company.json');

describe('normalizeCompany', () => {
  const c = normalizeCompany({ company });

  it('picks the root company, not the showcase sibling', () => {
    expect(c.name).toBe('Acme');
    expect(c.universalName).toBe('acme');
    expect(c.urn).toBe('urn:li:fs_normalized_company:1');
    expect(c.kind).toBe('company');
    expect(c.url).toBe('https://www.linkedin.com/company/acme/');
  });

  it('resolves referenced entities and drops dangling ones', () => {
    expect(c.industries).toEqual(['Software Development']);
    expect(c.followerCount).toBe(1234);
  });

  it('maps scalars, trimming and nulling', () => {
    expect(c).toMatchObject({
      tagline: 'We make things',
      description: 'Long description',
      websiteUrl: 'https://acme.example/',
      companyType: 'Privately Held',
      staffCount: 42,
      staffCountRange: { start: 11, end: 50 },
      headquarters: {
        city: 'Hyderabad',
        region: 'Telangana',
        country: 'IN',
        postalCode: '500001',
        line1: '1 Main St',
      },
      foundedYear: 2008,
      specialities: ['AI', 'Robots'],
      phone: null,
      backgroundImage: null,
    });
  });

  it('sorts logo variants ascending and picks the largest', () => {
    expect(c.logo?.variants.map((v) => v.width)).toEqual([100, 400]);
    expect(c.logo?.url).toContain('400_400');
  });

  it('validates against the schema', () => {
    const meta = {
      source: 'voyager',
      fetchedAt: '2026-08-27T00:00:00.000Z',
      cached: false,
      durationMs: 0,
      warnings: [],
    };
    expect(CompanyResponse.safeParse({ ...c, meta }).success).toBe(true);
  });

  it('reports school pages as kind=school with a /school/ URL', () => {
    const school = structuredClone(company);
    const root = school.included!.find((e) => e.entityUrn === 'urn:li:fs_normalized_company:1')!;
    root.school = 'urn:li:fs_normalized_school:9';
    root.url = 'https://www.linkedin.com/school/acme/';
    const s = normalizeCompany({ company: school });
    expect(s.kind).toBe('school');
    expect(s.url).toBe('https://www.linkedin.com/school/acme/');
  });

  it('throws SchemaDriftError without a root company', () => {
    expect(() => normalizeCompany({ company: { data: {}, included: [] } })).toThrow(
      SchemaDriftError,
    );
  });
});
