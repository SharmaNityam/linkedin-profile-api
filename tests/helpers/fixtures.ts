import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoyagerResponse } from '../../src/linkedin/voyager/types.js';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'voyager');

export function fixturePath(slug: string, file: string): string {
  return join(ROOT, slug, file);
}

export function hasFixture(slug: string): boolean {
  return existsSync(fixturePath(slug, 'full.json'));
}

export function loadFixture(slug: string, file: string): VoyagerResponse {
  return JSON.parse(readFileSync(fixturePath(slug, file), 'utf8')) as VoyagerResponse;
}

export function loadOptionalFixture(slug: string, file: string): VoyagerResponse | undefined {
  return existsSync(fixturePath(slug, file)) ? loadFixture(slug, file) : undefined;
}

/**
 * Profile fixtures live at `voyager/<slug>/`; every other entity is namespaced
 * under `voyager/<kind>/<slug>/` so the profile fixture walker ignores them.
 */
export type FixtureKind = 'profile' | 'company' | 'posts';

export function entityFixturePath(kind: FixtureKind, slug: string, file = ''): string {
  return kind === 'profile' ? fixturePath(slug, file) : join(ROOT, kind, slug, file);
}

export function loadEntityFixture(kind: FixtureKind, slug: string, file: string): VoyagerResponse {
  return JSON.parse(readFileSync(entityFixturePath(kind, slug, file), 'utf8')) as VoyagerResponse;
}

export function listEntityFixtures(kind: 'company' | 'posts'): string[] {
  const dir = join(ROOT, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'minimal')
    .map((e) => e.name);
}
