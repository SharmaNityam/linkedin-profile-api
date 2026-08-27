import type { VoyagerTransport } from './client.js';
import type { ProfileBundle } from './normalize.js';
import type { CompanyBundle } from './normalize-company.js';
import type { PostsBundle } from './normalize-posts.js';
import { ProfileNotFoundError, SchemaDriftError } from '../../errors.js';
import { EntityGraph } from './graph.js';
import { TYPES, type CollectionResponse, type VoyagerResponse } from './types.js';

/**
 * Every LinkedIn URL and decoration ID lives here and nowhere else, so when
 * LinkedIn changes them there is exactly one file to touch.
 *
 * A "decoration" is Voyager's name for a projection: which fields and nested
 * entities to include. The numeric suffix is a version. These were captured
 * from the LinkedIn web app on 2026-08-27.
 */
export const DECORATION = {
  /** Positions, education, skills (first 20), certifications, languages, volunteering, … */
  fullProfile: 'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101',
  /** Top card: resolves the Geo entity so we get a human-readable location. */
  topCard: 'com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16',
  /** Company pages: the legacy (non-dash) organization projection. */
  company: 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12',
} as const;

/**
 * The persisted-query hash for `voyagerFeedDashProfileUpdates`. LinkedIn rotates
 * these when the query changes; a stale one comes back as a 400 or 404, so it is
 * overridable at runtime via `VOYAGER_POSTS_QUERY_ID`.
 */
export const DEFAULT_POSTS_QUERY_ID = '20c70fe0314184158516a7ec004c0408';

/** Voyager returns at most this many skills inline; the rest must be paged. */
const SKILLS_PAGE_SIZE = 50;
const MAX_SKILLS = 200;

export function profilePath(publicIdentifier: string, decorationId: string): string {
  const id = encodeURIComponent(publicIdentifier);
  return `/identity/dash/profiles?q=memberIdentity&memberIdentity=${id}&decorationId=${decorationId}`;
}

export function skillsPath(profileUrn: string, start: number, count = SKILLS_PAGE_SIZE): string {
  return `/identity/dash/profileSkills?q=viewee&profileUrn=${encodeURIComponent(profileUrn)}&start=${start}&count=${count}`;
}

export function companyPath(universalName: string): string {
  return `/organization/companies?decorationId=${DECORATION.company}&q=universalName&universalName=${encodeURIComponent(universalName)}`;
}

/**
 * Posts come from the GraphQL surface, not Rest.li. `variables` uses Rest.li's
 * unquoted tuple syntax, so it is assembled by hand rather than by URLSearchParams.
 */
export function postsPath(profileUrn: string, count: number, queryId: string): string {
  const variables = `(count:${count},start:0,profileUrn:${encodeURIComponent(profileUrn)})`;
  return `/graphql?includeWebMetadata=true&variables=${variables}&queryId=voyagerFeedDashProfileUpdates.${queryId}`;
}

export interface FetchedProfile {
  bundle: ProfileBundle;
  /** Non-fatal problems, surfaced in `meta.warnings`. */
  warnings: string[];
}

/**
 * Fetches everything needed to build one profile: the full entity graph, the
 * top card (for the location name), and any skills beyond the inline cap.
 */
export async function fetchProfileBundle(
  client: VoyagerTransport,
  publicIdentifier: string,
): Promise<FetchedProfile> {
  const context = { kind: 'profile' as const, identifier: publicIdentifier };
  const warnings: string[] = [];

  const [full, topCard] = await Promise.all([
    client.get(profilePath(publicIdentifier, DECORATION.fullProfile), context),
    client.get(profilePath(publicIdentifier, DECORATION.topCard), context).catch((err: unknown) => {
      // The top card is only needed for the location name; degrade gracefully.
      warnings.push(
        `location name unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }),
  ]);

  const bundle: ProfileBundle = { full, skillPages: [] };
  if (topCard) bundle.topCard = topCard;

  // Skills paging. The inline collection tells us the real total.
  const graph = new EntityGraph(full);
  const profile = graph.rootElements().find((e) => e.$type === TYPES.profile);
  const { elements, collection } = graph.collection(profile, 'profileSkills');
  const total = collection?.paging?.total ?? elements.length;
  const profileUrn = profile?.entityUrn;

  if (profileUrn && total > elements.length) {
    let start = elements.length;
    const cap = Math.min(total, MAX_SKILLS);
    while (start < cap) {
      try {
        const page = await client.get(skillsPath(profileUrn, start), context);
        const got = ((page.data as CollectionResponse | undefined)?.['*elements'] ?? []).length;
        if (got === 0) break;
        bundle.skillPages!.push(page);
        start += got;
      } catch (err) {
        warnings.push(
          `skills truncated at ${start} of ${total}: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    }
    if (total > MAX_SKILLS) warnings.push(`skills truncated to ${MAX_SKILLS} of ${total}`);
  }

  return { bundle, warnings };
}

/** One request: the company page decoration, keyed by its universal name. */
export async function fetchCompanyBundle(
  client: VoyagerTransport,
  universalName: string,
): Promise<{ bundle: CompanyBundle; warnings: string[] }> {
  const company = await client.get(companyPath(universalName), {
    kind: 'company',
    identifier: universalName,
  });
  return { bundle: { company }, warnings: [] };
}

/**
 * Two requests: the top card resolves the public identifier to the internal
 * profile URN, which the GraphQL feed query needs.
 */
export async function fetchPostsBundle(
  client: VoyagerTransport,
  publicIdentifier: string,
  count: number,
  queryId: string,
): Promise<{ bundle: PostsBundle; warnings: string[] }> {
  const context = { kind: 'posts' as const, identifier: publicIdentifier };

  const topCard = await client.get(profilePath(publicIdentifier, DECORATION.topCard), context);
  const profile = new EntityGraph(topCard).rootElements().find((e) => e.$type === TYPES.profile);
  const profileUrn = typeof profile?.entityUrn === 'string' ? profile.entityUrn : undefined;
  if (!profileUrn) {
    throw new SchemaDriftError('Top card response did not contain a profile URN', {
      publicIdentifier,
    });
  }

  let posts: VoyagerResponse;
  try {
    posts = await client.get(postsPath(profileUrn, count, queryId), context);
  } catch (err) {
    // The top card already proved the profile exists, so a 400 (rejected query)
    // or a 404 here means the persisted query hash is unknown, not the member.
    if (err instanceof SchemaDriftError || err instanceof ProfileNotFoundError) {
      throw new SchemaDriftError(
        `LinkedIn rejected the posts query. The GraphQL queryId "${queryId}" is probably stale; capture the current voyagerFeedDashProfileUpdates hash and set VOYAGER_POSTS_QUERY_ID.`,
        { ...err.details, queryId },
      );
    }
    throw err;
  }

  return { bundle: { topCard, posts }, warnings: [] };
}
