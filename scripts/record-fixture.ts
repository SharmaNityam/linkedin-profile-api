/**
 * Records the raw Voyager responses for one entity into tests/fixtures so the
 * normalisers can be tested offline against real LinkedIn data.
 *
 *   LI_AT=… pnpm record-fixture <publicIdentifier>
 *   LI_AT=… pnpm record-fixture company <universalName>
 *   LI_AT=… pnpm record-fixture posts <publicIdentifier>
 *
 * Tracking/anti-abuse noise is stripped; everything else is kept verbatim so
 * the fixture is an honest sample of what LinkedIn returns.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import type { VoyagerTransport } from '../src/linkedin/voyager/client.js';
import { HttpVoyagerClient } from '../src/linkedin/voyager/client.js';
import {
  fetchCompanyBundle,
  fetchPostsBundle,
  fetchProfileBundle,
} from '../src/linkedin/voyager/endpoints.js';
import { normalizeCompany } from '../src/linkedin/voyager/normalize-company.js';
import { normalizePosts } from '../src/linkedin/voyager/normalize-posts.js';
import { normalizeProfile } from '../src/linkedin/voyager/normalize.js';
import { POSTS_DEFAULT_COUNT } from '../src/linkedin/service.js';

export const USAGE =
  'usage: pnpm record-fixture <publicIdentifier> | company <universalName> | posts <publicIdentifier>';

const NOISE_KEYS = new Set(['$anti_abuse_metadata', 'trackingId', 'trackingUrn', '$recipeTypes']);

/** The kinds share a shape: a fixture directory name plus what to fetch. */
export type Target = { kind: 'profile' | 'company' | 'posts'; slug: string };

/**
 * One recorded entity: the files to write, plus a deferred `summarize()` that
 * normalises the fetched bundle. Deferred so callers can write the raw files
 * to disk *before* risking a `SchemaDriftError` — schema drift is exactly the
 * case where the fixture is most worth keeping.
 */
export interface Recording {
  /** Absolute fixture directory, `<repo>/tests/fixtures/voyager[/<kind>]/<slug>`. */
  dir: string;
  files: { name: string; body: unknown }[];
  /** Normalises the bundle and returns the one-line summary. May throw `SchemaDriftError`. */
  summarize: () => string;
  warnings: string[];
}

export function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !NOISE_KEYS.has(k) && !k.startsWith('multiLocale'))
        .map(([k, v]) => [k, strip(v)]),
    );
  }
  return value;
}

const RESERVED_SLUGS = new Set(['profile', 'company', 'posts']);

/**
 * `<slug>` records a profile (the original behaviour); `company`/`posts` take
 * the entity name as the next argument.
 */
export function parseArgs(argv: readonly string[]): Target {
  if (argv.length > 2) throw new Error(USAGE);
  const [first, second] = argv;
  if (first === 'company' || first === 'posts') {
    if (!second) throw new Error(USAGE);
    return { kind: first, slug: second };
  }
  if (!first) throw new Error(USAGE);
  if (RESERVED_SLUGS.has(first)) throw new Error(USAGE);
  return { kind: 'profile', slug: first };
}

/** Profile fixtures sit at the root; every other kind is namespaced by kind. */
export function fixtureDir(target: Target): string {
  const root = join(import.meta.dirname, '..', 'tests', 'fixtures', 'voyager');
  return target.kind === 'profile' ? join(root, target.slug) : join(root, target.kind, target.slug);
}

/**
 * Fetches one entity and returns what should land on disk. Pure apart from the
 * transport, so it can be exercised offline against a fake client.
 */
export async function record(
  client: VoyagerTransport,
  target: Target,
  postsQueryId: string,
): Promise<Recording> {
  const dir = fixtureDir(target);
  const file = (name: string, body: unknown) => ({ name, body: strip(body) });

  if (target.kind === 'company') {
    const { bundle, warnings } = await fetchCompanyBundle(client, target.slug);
    return {
      dir,
      files: [file('company.json', bundle.company)],
      summarize: () => {
        const c = normalizeCompany(bundle);
        return `${c.name} · ${c.industries.join(', ') || 'no industries'} · ${c.followerCount ?? '?'} followers`;
      },
      warnings,
    };
  }

  if (target.kind === 'posts') {
    const { bundle, warnings } = await fetchPostsBundle(
      client,
      target.slug,
      POSTS_DEFAULT_COUNT,
      postsQueryId,
    );
    return {
      dir,
      files: [file('topcard.json', bundle.topCard), file('posts.json', bundle.posts)],
      summarize: () => {
        const p = normalizePosts(bundle, target.slug);
        const reshares = p.posts.filter((post) => post.isReshare).length;
        return `${p.posts.length} posts, ${reshares} reshares`;
      },
      warnings,
    };
  }

  const { bundle, warnings } = await fetchProfileBundle(client, target.slug);
  return {
    dir,
    files: [
      file('full.json', bundle.full),
      ...(bundle.topCard ? [file('topcard.json', bundle.topCard)] : []),
      ...(bundle.skillPages ?? []).map((page, i) => file(`skills-${i + 1}.json`, page)),
    ],
    summarize: () => {
      const profile = normalizeProfile(bundle);
      return `${profile.fullName} · ${profile.experience.length} positions · ${profile.education.length} education · ${profile.skills.length} skills · ${profile.certifications.length} certs · ${profile.languages.length} languages`;
    },
    warnings,
  };
}

/**
 * Fetches one entity, writes its files to `dir` immediately, and only then
 * attempts to normalise and summarise it. If normalisation throws (schema
 * drift is exactly the case this guards against), the fixture is already on
 * disk — the run is reported as a partial success instead of losing the
 * sample and requiring a second live request.
 */
export async function recordToDir(
  client: VoyagerTransport,
  target: Target,
  postsQueryId: string,
  dir: string,
): Promise<{
  files: { name: string; body: unknown }[];
  warnings: string[];
  summary: string | null;
  normalizeError: string | null;
}> {
  const { files, warnings, summarize } = await record(client, target, postsQueryId);

  mkdirSync(dir, { recursive: true });
  for (const { name, body } of files) {
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2) + '\n');
  }

  console.log(`Recorded ${target.kind} ${target.slug} → ${dir}`);

  let summary: string | null = null;
  let normalizeError: string | null = null;
  try {
    summary = summarize();
    console.log(`  ${summary}`);
  } catch (err) {
    normalizeError = err instanceof Error ? err.message : String(err);
    console.log(`  written, but did not normalize: ${normalizeError}`);
  }
  if (warnings.length) console.log('  warnings:', warnings);

  return { files, warnings, summary, normalizeError };
}

async function main(): Promise<void> {
  const target = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  const client = new HttpVoyagerClient({
    liAt: config.LI_AT,
    companionCookies: config.LI_COOKIES,
    userAgent: config.USER_AGENT,
  });

  await recordToDir(client, target, config.VOYAGER_POSTS_QUERY_ID, fixtureDir(target));
}

// Only when run as a script: importing this module (from tests) must never
// reach out to LinkedIn.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
