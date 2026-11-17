import { elementsOf } from "../comments/store.ts";
import type { DiagramModel } from "../model/index.ts";
export interface ElementChange {
  readonly added: string[];
  readonly changed: string[];
  readonly removed: {
    readonly id: string;
    readonly label: string;
  }[];
}
/**
 * What moved between two models, by element id: ids only in `after`, ids in
 * both whose label differs (an edge without a label is labelled by its ends,
 * so a re-pointed edge is changed), and ids only in `before` with their last
 * label. In model order.
 */
export function diffElements(before: DiagramModel, after: DiagramModel): ElementChange {
  const old = elementsOf(before);
  const now = elementsOf(after);
  const bare = (key: string): string => key.slice(key.indexOf(":") + 1);
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, label] of now) {
    const was = old.get(key);
    if (was === undefined) added.push(bare(key));
    else if (was !== label) changed.push(bare(key));
  }
  const removed = [...old].filter(([key]) => !now.has(key)).map(([key, label]) => ({ id: bare(key), label }));
  return { added, changed, removed };
}
