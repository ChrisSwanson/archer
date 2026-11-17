import type { ProjectedSequence, ProjectedSequenceEvent } from "../diagrams/projection";

/**
 * What can be selected in a sequence view, in the shape a graph selection has.
 *
 * PARTICIPANTS ARE NODES AND MESSAGES ARE EDGES (`source` = from, `target` =
 * to, `label` = the message text). That is a mapping, not a new contract: the
 * published `SelectionContext` keeps its shape, so the host stores a sequence
 * selection exactly as it stores a graph one and needed no change to do it.
 *
 * Fragments are absent on purpose. A fragment is a frame around messages --
 * structure, like a graph group -- and neither canvas selects its containers.
 */
export type SequenceSelectionModel = {
  readonly nodeDetails: ReadonlyMap<string, { label: string }>;
  readonly edgeDetails: ReadonlyMap<string, { source: string; target: string; label?: string }>;
};

/**
 * Every message in source order, reaching into fragments.
 *
 * Reads only messages and the fragments that hold them, and SKIPS the rest.
 * A `note` is skipped on purpose: it is an annotation, never a target, and
 * its id must not reach the published selection (ADR 0009). An event type
 * this build does not know never gets here -- `projectEnvelope` refuses the
 * envelope -- but the walk stays total rather than exhaustive, so it cannot
 * be the thing that throws.
 */
function collectMessages(
  events: readonly ProjectedSequenceEvent[],
  into: Map<string, { source: string; target: string; label?: string }>,
): void {
  for (const event of events) {
    if (event.type === "message") {
      into.set(event.id, { source: event.from, target: event.to, label: event.label });
    } else if (event.type === "fragment") {
      for (const section of event.sections) {
        collectMessages(section.events, into);
      }
    }
  }
}

export function sequenceSelectionModel(view: ProjectedSequence): SequenceSelectionModel {
  const edgeDetails = new Map<string, { source: string; target: string; label?: string }>();
  collectMessages(view.events, edgeDetails);
  return {
    nodeDetails: new Map(view.participants.map((p) => [p.id, { label: p.label }] as const)),
    edgeDetails,
  };
}
