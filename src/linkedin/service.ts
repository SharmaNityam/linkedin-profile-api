import type { z } from 'zod';
import { CompanyResponse } from '../schema/company.js';
import type { Meta } from '../schema/common.js';
import { PostsResponse } from '../schema/post.js';
import { ProfileResponse } from '../schema/profile.js';
import type { TtlCache } from './cache.js';
import type { Semaphore } from './semaphore.js';
import { parseCompanyUrl, parseProfileUrl } from './url.js';
import type { LogFn, VoyagerTransport } from './voyager/client.js';
import { fetchCompanyBundle, fetchPostsBundle, fetchProfileBundle } from './voyager/endpoints.js';
import { normalizeCompany } from './voyager/normalize-company.js';
import { normalizePosts } from './voyager/normalize-posts.js';
import { normalizeProfile } from './voyager/normalize.js';

/** How many posts `/v1/posts` returns when the caller does not ask for a count. */
export const POSTS_DEFAULT_COUNT = 10;
/** LinkedIn's feed query degrades past this, so the requested count is clamped. */
export const POSTS_MAX_COUNT = 50;

export interface LinkedInServiceDeps {
  voyager: VoyagerTransport;
  /** Shared across entity kinds; keys are namespaced (`profile:`, `company:`, `posts:`). */
  cache: TtlCache<unknown>;
  semaphore: Semaphore;
  postsQueryId: string;
  log?: LogFn;
  now?: () => Date;
}

/**
 * The one entry point the HTTP layer talks to: parse the URL, serve from
 * cache if possible, otherwise fetch from Voyager, normalise, validate.
 */
export class LinkedInService {
  private readonly log: LogFn;
  private readonly now: () => Date;

  constructor(private readonly deps: LinkedInServiceDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  async getProfile(inputUrl: string): Promise<ProfileResponse> {
    const { publicIdentifier } = parseProfileUrl(inputUrl);
    return this.cached(`profile:${publicIdentifier}`, ProfileResponse, async () => {
      const { bundle, warnings } = await fetchProfileBundle(this.deps.voyager, publicIdentifier);
      return { data: normalizeProfile(bundle), warnings };
    });
  }

  async getCompany(inputUrl: string): Promise<CompanyResponse> {
    const { universalName } = parseCompanyUrl(inputUrl);
    return this.cached(`company:${universalName}`, CompanyResponse, async () => {
      const { bundle, warnings } = await fetchCompanyBundle(this.deps.voyager, universalName);
      return { data: normalizeCompany(bundle), warnings };
    });
  }

  async getPosts(inputUrl: string, count?: number): Promise<PostsResponse> {
    const { publicIdentifier } = parseProfileUrl(inputUrl);
    const requested = Number.isFinite(count) ? (count as number) : POSTS_DEFAULT_COUNT;
    const n = Math.min(POSTS_MAX_COUNT, Math.max(1, Math.trunc(requested)));
    return this.cached(`posts:${publicIdentifier}:${n}`, PostsResponse, async () => {
      const { bundle, warnings } = await fetchPostsBundle(
        this.deps.voyager,
        publicIdentifier,
        n,
        this.deps.postsQueryId,
      );
      // `normalizePosts` reports how many updates came back; the contract is to
      // echo what the caller asked for.
      return { data: { ...normalizePosts(bundle, publicIdentifier), count: n }, warnings };
    });
  }

  /**
   * Cache lookup, concurrency-limited fetch, `meta` block and schema check —
   * identical for every entity kind, so it lives in one place.
   */
  private async cached<T extends { meta: Meta }>(
    key: string,
    schema: z.ZodType<T>,
    fetch: () => Promise<{ data: Omit<T, 'meta'>; warnings: string[] }>,
  ): Promise<T> {
    const hit = this.deps.cache.get(key) as T | undefined;
    if (hit) return { ...hit, meta: { ...hit.meta, cached: true } };

    const startedAt = this.now();
    const { data, warnings } = await this.deps.semaphore.run(fetch);

    const response = {
      ...data,
      meta: {
        source: 'voyager',
        fetchedAt: startedAt.toISOString(),
        cached: false,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        warnings,
      },
    } as T;

    // Validate what we are about to return. A mismatch means LinkedIn changed
    // something we didn't anticipate; surface it as a warning, not a 500.
    const check = schema.safeParse(response);
    if (!check.success) {
      const issues = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      this.log('warn', 'response failed schema validation', { key, issues });
      response.meta.warnings.push(`response did not fully match the schema: ${issues.join('; ')}`);
    }

    this.deps.cache.set(key, response);
    return response;
  }
}
