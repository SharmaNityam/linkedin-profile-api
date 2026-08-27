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

/** One recorded entity: the files to write and the line to print about them. */
export interface Recording {
  /** Absolute fixture directory, `<repo>/tests/fixtures/voyager[/<kind>]/<slug>`. */
  dir: string;
  files: { name: string; body: unknown }[];
  summary: string;
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

/**
 * `<slug>` records a profile (the original behaviour); `company`/`posts` take
 * the entity name as the next argument.
 */
export function parseArgs(argv: readonly string[]): Target {
  const [first, second] = argv;
  if (first === 'company' || first === 'posts') {
    if (!second) throw new Error(USAGE);
    return { kind: first, slug: second };
  }
  if (!first) throw new Error(USAGE);
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
    const c = normalizeCompany(bundle);
    return {
      dir,
      files: [file('company.json', bundle.company)],
      summary: `${c.name} · ${c.industries.join(', ') || 'no industries'} · ${c.followerCount ?? '?'} followers`,
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
    const p = normalizePosts(bundle, target.slug);
    const reshares = p.posts.filter((post) => post.isReshare).length;
    return {
      dir,
      files: [file('topcard.json', bundle.topCard), file('posts.json', bundle.posts)],
      summary: `${p.posts.length} posts, ${reshares} reshares`,
      warnings,
    };
  }

  const { bundle, warnings } = await fetchProfileBundle(client, target.slug);
  const profile = normalizeProfile(bundle);
  return {
    dir,
    files: [
      file('full.json', bundle.full),
      ...(bundle.topCard ? [file('topcard.json', bundle.topCard)] : []),
      ...(bundle.skillPages ?? []).map((page, i) => file(`skills-${i + 1}.json`, page)),
    ],
    summary: `${profile.fullName} · ${profile.experience.length} positions · ${profile.education.length} education · ${profile.skills.length} skills · ${profile.certifications.length} certs · ${profile.languages.length} languages`,
    warnings,
  };
}

async function main(): Promise<void> {
  const target = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  const client = new HttpVoyagerClient({
    liAt: config.LI_AT,
    companionCookies: config.LI_COOKIES,
    userAgent: config.USER_AGENT,
  });

  const { dir, files, summary, warnings } = await record(
    client,
    target,
    config.VOYAGER_POSTS_QUERY_ID,
  );

  mkdirSync(dir, { recursive: true });
  for (const { name, body } of files) {
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2) + '\n');
  }

  console.log(`Recorded ${target.kind} ${target.slug} → ${dir}`);
  console.log(`  ${summary}`);
  if (warnings.length) console.log('  warnings:', warnings);
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
