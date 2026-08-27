import { existsSync, readFileSync } from 'node:fs';
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
