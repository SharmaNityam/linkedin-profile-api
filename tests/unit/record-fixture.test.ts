import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, record, recordToDir, strip, USAGE } from '../../scripts/record-fixture.js';
import type { VoyagerTransport } from '../../src/linkedin/voyager/client.js';
import type { VoyagerResponse } from '../../src/linkedin/voyager/types.js';
import { loadEntityFixture, loadFixture } from '../helpers/fixtures.js';

/** Serves recorded fixtures by path pattern so the recorder never hits LinkedIn. */
class FakeVoyager implements VoyagerTransport {
  readonly name = 'fake';
  readonly paths: string[] = [];
  constructor(private readonly routes: [RegExp, VoyagerResponse][]) {}
  get(path: string): Promise<VoyagerResponse> {
    this.paths.push(path);
    const hit = this.routes.find(([pattern]) => pattern.test(path));
    if (!hit) throw new Error(`unexpected path: ${path}`);
    return Promise.resolve(hit[1]);
  }
}

describe('parseArgs', () => {
  it('treats a bare argument as a profile slug', () => {
    expect(parseArgs(['sharmanityam'])).toEqual({ kind: 'profile', slug: 'sharmanityam' });
  });

  it('reads the company and posts sub-commands', () => {
    expect(parseArgs(['company', 'anthropicresearch'])).toEqual({
      kind: 'company',
      slug: 'anthropicresearch',
    });
    expect(parseArgs(['posts', 'sharmanityam'])).toEqual({ kind: 'posts', slug: 'sharmanityam' });
  });

  it('rejects a missing argument with the usage line', () => {
    expect(() => parseArgs([])).toThrow(USAGE);
    expect(() => parseArgs(['company'])).toThrow(USAGE);
    expect(() => parseArgs(['posts'])).toThrow(USAGE);
  });

  it('rejects a bare slug that shadows a sub-command name', () => {
    expect(() => parseArgs(['profile'])).toThrow(USAGE);
    expect(() => parseArgs(['company'])).toThrow(USAGE);
    expect(() => parseArgs(['posts'])).toThrow(USAGE);
  });

  it('rejects the mistaken "profile <slug>" form and more than two args', () => {
    expect(() => parseArgs(['profile', 'sharmanityam'])).toThrow(USAGE);
    expect(() => parseArgs(['company', 'acme', 'extra'])).toThrow(USAGE);
  });
});

describe('strip', () => {
  it('removes tracking and anti-abuse noise at every depth', () => {
    expect(
      strip({
        keep: 1,
        trackingId: 'x',
        trackingUrn: 'urn:li:x',
        $anti_abuse_metadata: {},
        $recipeTypes: ['a'],
        multiLocaleFirstName: { en_US: 'Jane' },
        nested: [{ trackingId: 'y', keep: 2 }],
      }),
    ).toEqual({ keep: 1, nested: [{ keep: 2 }] });
  });

  it('leaves scalars alone', () => {
    expect(strip('a')).toBe('a');
    expect(strip(null)).toBeNull();
  });
});

describe('record', () => {
  it('records a company page as company.json', async () => {
    const client = new FakeVoyager([
      [/^\/organization\/companies/, loadEntityFixture('company', 'minimal', 'company.json')],
    ]);

    const result = await record(client, { kind: 'company', slug: 'acme' }, 'queryid');

    expect(result.dir.endsWith('/tests/fixtures/voyager/company/acme')).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['company.json']);
    expect(result.summarize()).toBe('Acme · Software Development · 1234 followers');
    expect(client.paths).toHaveLength(1);
  });

  it('records posts as topcard.json plus posts.json', async () => {
    const client = new FakeVoyager([
      [/^\/identity\/dash\/profiles/, loadEntityFixture('posts', 'minimal', 'topcard.json')],
      [/^\/graphql/, loadEntityFixture('posts', 'minimal', 'posts.json')],
    ]);

    const result = await record(client, { kind: 'posts', slug: 'jane-doe' }, 'queryid');

    expect(result.dir.endsWith('/tests/fixtures/voyager/posts/jane-doe')).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['topcard.json', 'posts.json']);
    expect(result.summarize()).toMatch(/^\d+ posts, \d+ reshares$/);
    // count 10 and the query id reach the GraphQL call.
    expect(client.paths[1]).toContain('count:10');
    expect(client.paths[1]).toContain('queryId=voyagerFeedDashProfileUpdates.queryid');
  });

  it('still records a profile into the un-namespaced directory', async () => {
    const client = new FakeVoyager([
      [/decorationId=[^&]*WebTopCardCore/, loadFixture('minimal', 'topcard.json')],
      [/^\/identity\/dash\/profiles/, loadFixture('minimal', 'full.json')],
      [/^\/identity\/dash\/profileSkills/, loadFixture('minimal', 'skills-page.json')],
    ]);

    const result = await record(client, { kind: 'profile', slug: 'minimal' }, 'queryid');

    expect(result.dir.endsWith('/tests/fixtures/voyager/minimal')).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['full.json', 'topcard.json', 'skills-1.json']);
    expect(result.summarize()).toContain('positions');
  });

  it('strips noise from every recorded file', async () => {
    const noisy = {
      data: { '*elements': ['urn:li:fs_normalized_company:1'], trackingId: 'nope' },
      included: [
        {
          entityUrn: 'urn:li:fs_normalized_company:1',
          $type: 'com.linkedin.voyager.organization.Company',
          $recipeTypes: ['x'],
          name: 'Acme',
          universalName: 'acme',
          multiLocaleName: { en_US: 'Acme' },
        },
      ],
    } as unknown as VoyagerResponse;
    const client = new FakeVoyager([[/^\/organization\/companies/, noisy]]);

    const result = await record(client, { kind: 'company', slug: 'acme' }, 'queryid');

    const json = JSON.stringify(result.files[0]?.body);
    expect(json).not.toContain('trackingId');
    expect(json).not.toContain('$recipeTypes');
    expect(json).not.toContain('multiLocale');
    expect(json).toContain('Acme');
  });
});

describe('recordToDir', () => {
  const tempDir = () => mkdtempSync(join(tmpdir(), 'record-fixture-'));

  it('writes files to disk and reports a summary on success', async () => {
    const client = new FakeVoyager([
      [/^\/organization\/companies/, loadEntityFixture('company', 'minimal', 'company.json')],
    ]);
    const dir = tempDir();

    const result = await recordToDir(client, { kind: 'company', slug: 'acme' }, 'queryid', dir);

    expect(readdirSync(dir)).toEqual(['company.json']);
    expect(result.summary).toBe('Acme · Software Development · 1234 followers');
    expect(result.normalizeError).toBeNull();
  });

  it('writes the fixture to disk even when normalisation throws on schema drift', async () => {
    // A response with no entity of the expected type: fetching succeeds, but
    // normalizeCompany has nothing to find a root Company entity in.
    const driftedBody = { data: {}, included: [] } as unknown as VoyagerResponse;
    const client = new FakeVoyager([[/^\/organization\/companies/, driftedBody]]);
    const dir = tempDir();

    const result = await recordToDir(client, { kind: 'company', slug: 'acme' }, 'queryid', dir);

    expect(readdirSync(dir)).toEqual(['company.json']);
    expect(JSON.parse(readFileSync(join(dir, 'company.json'), 'utf8'))).toEqual(driftedBody);
    expect(result.summary).toBeNull();
    expect(result.normalizeError).toContain('root Company entity');
  });
});
