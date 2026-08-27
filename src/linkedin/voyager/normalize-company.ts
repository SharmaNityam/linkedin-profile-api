import { SchemaDriftError } from '../../errors.js';
import type { CompanyData } from '../../schema/company.js';
import { EntityGraph } from './graph.js';
import { asRecord, image, str } from './normalize.js';
import { TYPES, type VectorImage, type VoyagerResponse } from './types.js';

export interface CompanyBundle {
  company: VoyagerResponse;
}

/**
 * Turns the `WebFullCompanyMain` decoration into the public `CompanyResponse`
 * shape. `included[]` also holds the page's showcase siblings (same `$type`),
 * so the target is taken from `data['*elements']`, never from `ofType()[0]`.
 */
export function normalizeCompany(bundle: CompanyBundle): CompanyData {
  const graph = new EntityGraph(bundle.company);
  const company = graph.rootElements().find((e) => e.$type === TYPES.legacyCompany);
  if (!company) {
    throw new SchemaDriftError('Voyager response did not contain a root Company entity', {
      rootElements: graph.rootElements().map((e) => e.$type),
      entityCount: graph.size,
    });
  }

  const universalName = str(company.universalName);
  const name = str(company.name);
  if (!universalName || !name) {
    throw new SchemaDriftError('Company entity has no universalName/name');
  }

  const kind = company.school ? 'school' : 'company';
  const hq = asRecord(company.headquarter);
  const range = asRecord(company.staffCountRange);

  return {
    url: `https://www.linkedin.com/${kind}/${encodeURIComponent(universalName)}/`,
    universalName,
    urn: str(company.entityUrn),
    name,
    kind,
    tagline: str(company.tagline),
    description: str(company.description),
    websiteUrl: str(company.companyPageUrl),
    industries: graph
      .refs(company, 'companyIndustries')
      .map((i) => str(i.localizedName))
      .filter(isPresent),
    companyType: str(asRecord(company.companyType)?.localizedName),
    staffCount: num(company.staffCount),
    staffCountRange:
      range && typeof range.start === 'number' ? { start: range.start, end: num(range.end) } : null,
    followerCount: num(graph.ref(company, 'followingInfo')?.followerCount),
    headquarters: hq
      ? {
          city: str(hq.city),
          region: str(hq.geographicArea),
          country: str(hq.country),
          postalCode: str(hq.postalCode),
          line1: str(hq.line1),
        }
      : null,
    foundedYear: num(asRecord(company.foundedOn)?.year),
    specialities: Array.isArray(company.specialities)
      ? company.specialities.map((s) => str(s)).filter(isPresent)
      : [],
    phone: str(company.phone),
    logo: image(asRecord(company.logo)?.image as VectorImage | undefined),
    backgroundImage: image(asRecord(company.backgroundCoverImage)?.image as VectorImage | undefined),
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPresent(value: string | null): value is string {
  return value !== null;
}
