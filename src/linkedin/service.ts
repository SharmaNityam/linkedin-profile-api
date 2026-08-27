import { ProfileResponse, type ProfileData } from '../schema/profile.js';
import type { TtlCache } from './cache.js';
import type { Semaphore } from './semaphore.js';
import { parseProfileUrl } from './url.js';
import type { LogFn, VoyagerTransport } from './voyager/client.js';
import { fetchProfileBundle } from './voyager/endpoints.js';
import { normalizeProfile } from './voyager/normalize.js';

export interface ProfileServiceDeps {
  voyager: VoyagerTransport;
  cache: TtlCache<ProfileResponse>;
  semaphore: Semaphore;
  log?: LogFn;
  now?: () => Date;
}

/**
 * The one entry point the HTTP layer talks to: parse the URL, serve from
 * cache if possible, otherwise fetch from Voyager, normalise, validate.
 */
export class ProfileService {
  private readonly log: LogFn;
  private readonly now: () => Date;

  constructor(private readonly deps: ProfileServiceDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  async getProfile(inputUrl: string): Promise<ProfileResponse> {
    const { publicIdentifier } = parseProfileUrl(inputUrl);

    const cached = this.deps.cache.get(publicIdentifier);
    if (cached) return { ...cached, meta: { ...cached.meta, cached: true } };

    const startedAt = this.now();
    const { data, warnings } = await this.deps.semaphore.run(() => this.fetch(publicIdentifier));

    const response: ProfileResponse = {
      ...data,
      meta: {
        source: 'voyager',
        fetchedAt: startedAt.toISOString(),
        cached: false,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        warnings,
      },
    };

    // Validate what we are about to return. A mismatch means LinkedIn changed
    // something we didn't anticipate; surface it as a warning, not a 500.
    const check = ProfileResponse.safeParse(response);
    if (!check.success) {
      const issues = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      this.log('warn', 'response failed schema validation', { publicIdentifier, issues });
      response.meta.warnings.push(`response did not fully match the schema: ${issues.join('; ')}`);
    }

    this.deps.cache.set(publicIdentifier, response);
    return response;
  }

  private async fetch(
    publicIdentifier: string,
  ): Promise<{ data: ProfileData; warnings: string[] }> {
    const { bundle, warnings } = await fetchProfileBundle(this.deps.voyager, publicIdentifier);
    return { data: normalizeProfile(bundle), warnings };
  }
}
