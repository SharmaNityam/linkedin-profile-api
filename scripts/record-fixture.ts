/**
 * Records the raw Voyager responses for a profile into tests/fixtures so the
 * normaliser can be tested offline against real LinkedIn data.
 *
 *   LI_AT=… pnpm record-fixture <publicIdentifier>
 *
 * Tracking/anti-abuse noise is stripped; everything else is kept verbatim so
 * the fixture is an honest sample of what LinkedIn returns.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HttpVoyagerClient } from '../src/linkedin/voyager/client.js';
import { fetchProfileBundle } from '../src/linkedin/voyager/endpoints.js';
import { normalizeProfile } from '../src/linkedin/voyager/normalize.js';
import type { VoyagerResponse } from '../src/linkedin/voyager/types.js';

const NOISE_KEYS = new Set(['$anti_abuse_metadata', 'trackingId', 'trackingUrn', '$recipeTypes']);

function strip(value: unknown): unknown {
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

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) throw new Error('usage: pnpm record-fixture <publicIdentifier>');

  const config = loadConfig();
  const client = new HttpVoyagerClient({ liAt: config.LI_AT, userAgent: config.USER_AGENT });
  const { bundle, warnings } = await fetchProfileBundle(client, slug);

  const dir = join(import.meta.dirname, '..', 'tests', 'fixtures', 'voyager', slug);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, body: VoyagerResponse) =>
    writeFileSync(join(dir, name), JSON.stringify(strip(body), null, 2) + '\n');

  write('full.json', bundle.full);
  if (bundle.topCard) write('topcard.json', bundle.topCard);
  bundle.skillPages?.forEach((page, i) => write(`skills-${i + 1}.json`, page));

  const profile = normalizeProfile(bundle);
  console.log(`Recorded ${slug} → ${dir}`);
  console.log(
    `  ${profile.fullName} · ${profile.experience.length} positions · ${profile.education.length} education · ${profile.skills.length} skills · ${profile.certifications.length} certs · ${profile.languages.length} languages`,
  );
  if (warnings.length) console.log('  warnings:', warnings);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
