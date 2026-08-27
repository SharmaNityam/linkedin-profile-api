import { SchemaDriftError, UpstreamError } from '../errors.js';
import { ProfileResponse, type ProfileData } from '../schema/profile.js';
import type { TtlCache } from './cache.js';
import type { Semaphore } from './semaphore.js';
import { parseProfileUrl } from './url.js';
import type { LogFn, VoyagerTransport } from './voyager/client.js';
import { fetchProfileBundle } from './voyager/endpoints.js';
import { normalizeProfile } from './voyager/normalize.js';

export interface BrowserFallback {
  voyager: VoyagerTransport;
  scrapeTopCard(publicIdentifier: string): Promise<{ data: ProfileData; warnings: string[] }>;
}

export interface ProfileServiceDeps {
  http: VoyagerTransport;
  browser?: BrowserFallback;
  cache: TtlCache<ProfileResponse>;
  semaphore: Semaphore;
  log?: LogFn;
  now?: () => Date;
}

interface FetchOutcome {
  data: ProfileData;
  warnings: string[];
  source: 'voyager' | 'browser';
  partial: boolean;
}

/**
 * The one entry point the HTTP layer talks to. Owns the escalation policy:
 *
 *   cache → Voyager over HTTP → Voyager inside a browser → DOM top card
 *
 * Only *infrastructure* failures escalate (LinkedIn blocked us, schema drift,
 * 5xx). A profile that doesn't exist, an expired session or a rate limit are
 * terminal: a browser would get the same answer, so we don't waste 10 seconds
 * finding out.
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
    const outcome = await this.deps.semaphore.run(() => this.fetchWithFallback(publicIdentifier));

    const response: ProfileResponse = {
      ...outcome.data,
      meta: {
        source: outcome.source,
        fetchedAt: startedAt.toISOString(),
        cached: false,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        partial: outcome.partial,
        warnings: outcome.warnings,
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

  private async fetchWithFallback(publicIdentifier: string): Promise<FetchOutcome> {
    try {
      return await this.viaVoyager(this.deps.http, publicIdentifier);
    } catch (primaryError) {
      if (!shouldEscalate(primaryError) || !this.deps.browser) throw primaryError;
      this.log('warn', 'http transport failed, escalating to browser', {
        publicIdentifier,
        error: String(primaryError),
      });

      try {
        return await this.viaVoyager(this.deps.browser.voyager, publicIdentifier);
      } catch (browserError) {
        if (!shouldEscalate(browserError)) throw browserError;
        this.log('warn', 'browser voyager failed, falling back to DOM top card', {
          publicIdentifier,
          error: String(browserError),
        });

        try {
          const { data, warnings } = await this.deps.browser.scrapeTopCard(publicIdentifier);
          return {
            data,
            source: 'browser',
            partial: true,
            warnings: [`primary path failed: ${String(primaryError)}`, ...warnings],
          };
        } catch (domError) {
          this.log('warn', 'DOM fallback failed too', {
            publicIdentifier,
            error: String(domError),
          });
          throw primaryError; // the most informative error is the first one
        }
      }
    }
  }

  private async viaVoyager(
    transport: VoyagerTransport,
    publicIdentifier: string,
  ): Promise<FetchOutcome> {
    const { bundle, warnings } = await fetchProfileBundle(transport, publicIdentifier);
    const data = normalizeProfile(bundle);
    return {
      data,
      warnings,
      source: transport.name === 'http' ? 'voyager' : 'browser',
      partial: false,
    };
  }
}

function shouldEscalate(err: unknown): boolean {
  return err instanceof SchemaDriftError || err instanceof UpstreamError;
}
