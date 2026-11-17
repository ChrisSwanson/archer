/** Structural so the semantic model and its projected drawing share the same walk. */
export interface SequenceWalkEvent<T> {
  readonly type: string;
  readonly sections?: readonly { readonly events: readonly T[] }[];
}

/** Depth-first written order, including each fragment before its sections. Never mutates the source. */
export function* eachSequenceEvent<T extends SequenceWalkEvent<T>>(events: readonly T[]): Generator<T> {
  const pending = [...events].reverse();
  for (let event = pending.pop(); event !== undefined; event = pending.pop()) {
    yield event;
    if (event.type !== "fragment") continue;
    for (const section of [...(event.sections ?? [])].reverse()) pending.push(...[...section.events].reverse());
  }
}
