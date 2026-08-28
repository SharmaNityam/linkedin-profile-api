import type { CollectionResponse, VoyagerEntity, VoyagerResponse } from './types.js';

export class EntityGraph {
  private readonly byUrn = new Map<string, VoyagerEntity>();
  readonly root: VoyagerEntity | undefined;

  constructor(...responses: VoyagerResponse[]) {
    for (const res of responses) {
      for (const entity of res.included ?? []) {
        if (!entity.entityUrn) continue;
        const existing = this.byUrn.get(entity.entityUrn);
        this.byUrn.set(entity.entityUrn, existing ? { ...entity, ...existing } : entity);
      }
    }
    this.root = responses[0]?.data;
  }

  get size(): number {
    return this.byUrn.size;
  }

  get(urn: string | undefined | null): VoyagerEntity | undefined {
    return urn ? this.byUrn.get(urn) : undefined;
  }

  /** Follows a `*field` reference on an entity to the entity it points at. */
  ref(entity: VoyagerEntity | undefined, field: string): VoyagerEntity | undefined {
    const urn = entity?.[`*${field}`];
    return typeof urn === 'string' ? this.get(urn) : undefined;
  }

  /** Follows a `*field` that holds a list of URNs. */
  refs(entity: VoyagerEntity | undefined, field: string): VoyagerEntity[] {
    const urns = entity?.[`*${field}`];
    if (!Array.isArray(urns)) return [];
    return urns.map((u) => this.get(typeof u === 'string' ? u : undefined)).filter(isEntity);
  }

  /**
   * Resolves a `*field` that points at a CollectionResponse and returns its
   * elements. Returns the collection too so callers can check `paging.total`.
   */
  collection(
    entity: VoyagerEntity | undefined,
    field: string,
  ): { elements: VoyagerEntity[]; collection: CollectionResponse | undefined } {
    const collection = this.ref(entity, field) as CollectionResponse | undefined;
    return { elements: this.refs(collection, 'elements'), collection };
  }

  /** The entities returned by the top-level `data['*elements']`. */
  rootElements(): VoyagerEntity[] {
    return this.refs(this.root, 'elements');
  }

  ofType(type: string): VoyagerEntity[] {
    return [...this.byUrn.values()].filter((e) => e.$type === type);
  }
}

function isEntity(e: VoyagerEntity | undefined): e is VoyagerEntity {
  return e !== undefined;
}
