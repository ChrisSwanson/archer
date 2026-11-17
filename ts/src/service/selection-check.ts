// Which selections the service stores (ADR 0011), ported from Rust's
// `update_selection` and `SelectionContext::resolved_against`.
//
// A selection is stamped with what the view was shown under: the agent's
// presentation (its own id, at its view and revision) or a tab the reader
// picked (`reader:<viewId>`, at the revision served for that view now).
// Anything else is stale. What is stored is ids only: every label and
// endpoint is taken from the model, so a page cannot write what the agent
// reads back as the person's choice.
import type { DiagramEnvelope, DiagramModel, SequenceEvent } from "../model/index.ts";
import { elementsOf } from "../model/index.ts";
import type { SelectionContext } from "./selection.ts";

/** Rust's MAX_SELECTION_ELEMENTS, per kind. */
export const MAX_SELECTION_ELEMENTS = 1024;
export const READER_PRESENTATION_PREFIX = "reader:";
export const readerPresentationId = (viewId: string): string => `${READER_PRESENTATION_PREFIX}${viewId}`;

export interface PresentedModel {
  readonly presentationId: string;
  readonly viewId: string;
  readonly revision: string;
  readonly envelope: DiagramEnvelope;
}

export interface SelectionWorld {
  readonly presentation: PresentedModel | null;
  /** The envelope served for a view now (its last good one), or null. */
  readonly served: (viewId: string) => DiagramEnvelope | null;
}

export interface ResolvedSelection extends SelectionContext {
  readonly presentationId: string;
  readonly selectionRevision?: number;
  readonly nodes: readonly { readonly id: string; readonly label: string }[];
  readonly edges: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly label?: string;
  }[];
}

export type SelectionOutcome =
  | { readonly ok: true; readonly selection: ResolvedSelection }
  /** 409: stale or nothing presented; 422: malformed or naming what the model lacks. */
  | { readonly ok: false; readonly status: 409 | 422; readonly code: string; readonly message: string };

const stale = (message: string): SelectionOutcome => ({ ok: false, status: 409, code: "revision_conflict", message });
const invalid = (message: string, code = "invalid_selection"): SelectionOutcome => ({
  ok: false,
  status: 422,
  code,
  message,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function ids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry["id"] !== "string") return null;
    out.push(entry["id"]);
  }
  return out;
}

export function acceptSelection(raw: unknown, world: SelectionWorld): SelectionOutcome {
  if (!isObject(raw)) return invalid("a selection is an object", "invalid_params");
  const { schemaVersion, viewId, revision, presentationId, selectionRevision } = raw;
  const nodes = ids(raw["nodes"]);
  const edges = ids(raw["edges"]);
  if (
    typeof schemaVersion !== "number" ||
    typeof viewId !== "string" ||
    typeof revision !== "string" ||
    typeof presentationId !== "string" ||
    (selectionRevision !== undefined && typeof selectionRevision !== "number") ||
    nodes === null ||
    edges === null
  )
    return invalid(
      "a selection needs schemaVersion, viewId, revision, presentationId, and nodes and edges as lists of {id}",
      "invalid_params",
    );

  const model = modelStampedOn({ viewId, revision, presentationId }, world);
  if (typeof model === "string") return stale(model);

  if (nodes.length > MAX_SELECTION_ELEMENTS || edges.length > MAX_SELECTION_ELEMENTS) {
    const [count, kind] = nodes.length > MAX_SELECTION_ELEMENTS ? [nodes.length, "nodes"] : [edges.length, "edges"];
    return invalid(
      `the selection names ${count} ${kind}, and a selection holds at most ${MAX_SELECTION_ELEMENTS}. Nothing was stored; select fewer elements.`,
    );
  }
  const selectable = selectableOf(model);
  const resolvedNodes: { id: string; label: string }[] = [];
  const resolvedEdges: { id: string; source: string; target: string; label?: string }[] = [];
  const problem = (kind: string, what: string) =>
    invalid(
      `the selection names ${kind} ${what}. Nothing was stored. A selection may name only elements of the presented model: ` +
        "nodes and edges of a graph, participants and messages of a sequence diagram, each once.",
    );
  const seenNodes = new Set<string>();
  for (const id of nodes) {
    const label = selectable.nodes.get(id);
    if (label === undefined) return problem("node", `'${id}', which the diagram on screen does not hold`);
    if (seenNodes.has(id)) return problem("node", `'${id}' more than once`);
    seenNodes.add(id);
    resolvedNodes.push({ id, label });
  }
  const seenEdges = new Set<string>();
  for (const id of edges) {
    const edge = selectable.edges.get(id);
    if (edge === undefined) return problem("edge", `'${id}', which the diagram on screen does not hold`);
    if (seenEdges.has(id)) return problem("edge", `'${id}' more than once`);
    seenEdges.add(id);
    resolvedEdges.push({
      id,
      source: edge.source,
      target: edge.target,
      ...(edge.label === undefined ? {} : { label: edge.label }),
    });
  }
  return {
    ok: true,
    selection: {
      schemaVersion,
      viewId,
      revision,
      presentationId,
      ...(selectionRevision === undefined ? {} : { selectionRevision }),
      nodes: resolvedNodes,
      edges: resolvedEdges,
    },
  };
}

/** Whether a stored selection still passes the rule it was stored under. */
export function stillCurrent(selection: SelectionContext, world: SelectionWorld): boolean {
  const presentationId = selection["presentationId"];
  if (typeof presentationId !== "string") return false;
  return (
    typeof modelStampedOn({ viewId: selection.viewId, revision: selection.revision, presentationId }, world) !==
    "string"
  );
}

/** The model a stamp names if it is current, or why not. */
function modelStampedOn(
  stamp: { viewId: string; revision: string; presentationId: string },
  world: SelectionWorld,
): DiagramModel | string {
  const presentation = world.presentation;
  if (presentation !== null && presentation.presentationId === stamp.presentationId) {
    if (presentation.viewId !== stamp.viewId || presentation.revision !== stamp.revision)
      return "the selection names a view or revision that is not the presentation's current one";
    return presentation.envelope.model;
  }
  if (stamp.presentationId === readerPresentationId(stamp.viewId)) {
    const envelope = world.served(stamp.viewId);
    if (envelope === null) return `no view '${stamp.viewId}' is served`;
    if (envelope.revision !== stamp.revision) return "the selection was made on a revision that has since changed";
    return envelope.model;
  }
  if (presentation === null)
    return "nothing is presented, and the selection is not stamped as one on a view the reader picked";
  return "the selection names a presentation that is not current";
}

interface Selectable {
  readonly nodes: Map<string, string>;
  readonly edges: Map<string, { source: string; target: string; label?: string }>;
}

function selectableOf(model: DiagramModel): Selectable {
  if (model.type !== "sequence-trace") {
    const { nodes, links } = elementsOf(model);
    return {
      nodes: new Map(nodes.map((n) => [n.id, n.label])),
      edges: new Map(
        links.map((e) => [
          e.id,
          { source: e.source, target: e.target, ...(e.label == null ? {} : { label: e.label }) },
        ]),
      ),
    };
  }
  const edges: Selectable["edges"] = new Map();
  const pending: (readonly SequenceEvent[])[] = [model.events];
  for (let events = pending.pop(); events !== undefined; events = pending.pop())
    for (const event of events) {
      if (event.type === "message")
        edges.set(event.id, {
          source: event.from,
          target: event.to,
          ...(event.label == null ? {} : { label: event.label }),
        });
      else if (event.type === "fragment") pending.push(...event.sections.map((s) => s.events));
    }
  return { nodes: new Map(model.participants.map((p) => [p.id, p.label])), edges };
}
