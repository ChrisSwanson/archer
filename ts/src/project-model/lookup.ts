// Reading the project model by element: its relationships both ways, its neighbours, and the
// roll-up (ADR 0036 §6), worked out when read and never stored. Roll-up uses only unambiguous
// ancestry: an element with more than one parent reading, or a cycle, rolls up to nothing (O2).
import type { ModelElement, ModelRelationship, ProjectModel } from "./merge.ts";

/** An edge a view does not draw, implied by relationships between parts of what it draws. */
export interface DerivedRelationship {
  readonly from: string;
  readonly to: string;
  readonly derivedFrom: readonly ModelRelationship[];
}

export class ModelLookup {
  readonly #elements: ReadonlyMap<string, ModelElement>;
  readonly #out = new Map<string, ModelRelationship[]>();
  readonly #in = new Map<string, ModelRelationship[]>();

  constructor(readonly model: ProjectModel) {
    this.#elements = new Map(model.elements.map((e) => [e.id, e]));
    for (const r of model.relationships) {
      this.#out.set(r.from, [...(this.#out.get(r.from) ?? []), r]);
      this.#in.set(r.to, [...(this.#in.get(r.to) ?? []), r]);
    }
  }

  element(id: string): ModelElement | undefined {
    return this.#elements.get(id);
  }

  /** Pairs from the element and pairs to it, each sorted by the other end. */
  relationshipsOf(id: string): {
    readonly out: readonly ModelRelationship[];
    readonly in: readonly ModelRelationship[];
  } {
    return {
      out: this.#out.get(id) ?? [],
      in: [...(this.#in.get(id) ?? [])].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
    };
  }

  /** Every element related to this one, either way, sorted. */
  neighbours(id: string): string[] {
    const { out, in: incoming } = this.relationshipsOf(id);
    return [...new Set([...out.map((r) => r.to), ...incoming.map((r) => r.from)])].filter((n) => n !== id).sort();
  }

  /** The edges `viewId` implies but does not draw, between its nearest drawn ancestors of each end. */
  rollUp(viewId: string): DerivedRelationship[] {
    const drawn = new Set(
      this.model.elements.filter((e) => e.drawnIn.includes(viewId) || e.opensIn.includes(viewId)).map((e) => e.id),
    );
    if (drawn.size === 0) return [];
    const drawsPair = new Set(
      this.model.relationships.filter((r) => r.drawnIn.includes(viewId)).map((r) => `${r.from}\0${r.to}`),
    );
    /** The end itself if drawn, else its nearest drawn ancestor; null when ancestry is ambiguous or none is drawn. */
    const nearest = (id: string): { at: string; chain: readonly string[] } | null => {
      const element = this.#elements.get(id);
      if (element?.path === undefined || element.parents.length > 1) return null;
      const chain = [...element.path, id];
      for (let i = chain.length - 1; i >= 0; i--) if (drawn.has(chain[i]!)) return { at: chain[i]!, chain };
      return null;
    };
    const derived = new Map<string, { from: string; to: string; derivedFrom: ModelRelationship[] }>();
    for (const r of this.model.relationships) {
      const a = nearest(r.from),
        b = nearest(r.to);
      if (a === null || b === null) continue;
      if (a.at === r.from && b.at === r.to) continue; // drawn as it is: not a roll-up
      if (a.at === b.at || a.chain.includes(b.at) || b.chain.includes(a.at)) continue; // one contains the other
      const key = `${a.at}\0${b.at}`;
      if (drawsPair.has(key)) continue;
      const entry = derived.get(key) ?? { from: a.at, to: b.at, derivedFrom: [] };
      entry.derivedFrom.push(r);
      derived.set(key, entry);
    }
    return [...derived.values()].sort((x, y) =>
      x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0,
    );
  }
}
