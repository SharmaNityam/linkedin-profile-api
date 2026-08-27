import { describe, expect, it } from 'vitest';
import { EntityGraph } from '../../src/linkedin/voyager/graph.js';

const response = {
  data: { entityUrn: 'urn:li:collectionResponse:root', '*elements': ['urn:li:fsd_profile:1'] },
  included: [
    {
      entityUrn: 'urn:li:fsd_profile:1',
      $type: 'Profile',
      '*company': 'urn:li:fsd_company:9',
      '*skills': 'urn:li:col:s',
    },
    { entityUrn: 'urn:li:fsd_company:9', $type: 'Company', name: 'Acme' },
    {
      entityUrn: 'urn:li:col:s',
      $type: 'Collection',
      paging: { total: 3 },
      '*elements': ['urn:li:skill:1', 'urn:li:skill:MISSING', 'urn:li:skill:2'],
    },
    { entityUrn: 'urn:li:skill:1', $type: 'Skill', name: 'A' },
    { entityUrn: 'urn:li:skill:2', $type: 'Skill', name: 'B' },
    { $type: 'NoUrn' },
  ],
};

describe('EntityGraph', () => {
  const graph = new EntityGraph(response);

  it('indexes entities by URN and ignores ones without a URN', () => {
    expect(graph.size).toBe(5);
    expect(graph.get('urn:li:fsd_company:9')?.name).toBe('Acme');
    expect(graph.get('nope')).toBeUndefined();
    expect(graph.get(undefined)).toBeUndefined();
  });

  it('resolves root elements', () => {
    expect(graph.rootElements().map((e) => e.$type)).toEqual(['Profile']);
  });

  it('follows single references', () => {
    const profile = graph.rootElements()[0];
    expect(graph.ref(profile, 'company')?.name).toBe('Acme');
    expect(graph.ref(profile, 'doesNotExist')).toBeUndefined();
    expect(graph.ref(undefined, 'company')).toBeUndefined();
  });

  it('resolves collections and drops dangling references', () => {
    const { elements, collection } = graph.collection(graph.rootElements()[0], 'skills');
    expect(elements.map((e) => e.name)).toEqual(['A', 'B']);
    expect(collection?.paging?.total).toBe(3);
  });

  it('merges several responses into one graph, first response is root', () => {
    const merged = new EntityGraph(response, {
      included: [{ entityUrn: 'urn:li:skill:MISSING', $type: 'Skill', name: 'C' }],
    });
    expect(
      merged.collection(merged.rootElements()[0], 'skills').elements.map((e) => e.name),
    ).toEqual(['A', 'C', 'B']);
  });

  it('merges the same entity from several responses, earlier response winning on conflict', () => {
    const merged = new EntityGraph(
      { included: [{ entityUrn: 'urn:li:x', $type: 'T', a: 1, shared: 'first' }] },
      { included: [{ entityUrn: 'urn:li:x', $type: 'T', b: 2, shared: 'second' }] },
    );
    expect(merged.get('urn:li:x')).toEqual({
      entityUrn: 'urn:li:x',
      $type: 'T',
      a: 1,
      b: 2,
      shared: 'first',
    });
  });

  it('filters by type', () => {
    expect(graph.ofType('Skill')).toHaveLength(2);
  });
});
