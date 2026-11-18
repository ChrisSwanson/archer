// Mermaid's reading of a state diagram, held to the scan's and turned into
// the state-machine model. Positions and order come from the scan; labels,
// kinds and nesting come from Mermaid, and wherever the two disagree the
// source is refused, so Archer never shows a diagram Mermaid draws otherwise.

import type { StateKind, StateMachine, StateNode, StateNotePosition, StateTransition } from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import type { StateData, StateDbNode } from "./db.ts";
import type { ScannedState, StateScan } from "./scan.ts";

const KINDS: Record<string, StateKind> = {
  rect: "state",
  roundedWithTitle: "state",
  stateStart: "initial",
  stateEnd: "final",
  choice: "choice",
  fork: "fork",
  join: "join",
};

const POSITIONS: Record<string, StateNotePosition> = { "left of": "left-of", "right of": "right-of" };

export interface Adapted {
  model: StateMachine | undefined;
  diagnostics: Diagnostic[];
}

const isNote = (node: StateDbNode): boolean => node.shape === "note" || node.shape === "noteGroup";

class Adapter {
  readonly diagnostics: Diagnostic[] = [];

  constructor(readonly fallback: Span) {}

  disagree(what: string, at: Span = this.fallback): void {
    this.diagnostics.push(
      error(
        "parser_disagreement",
        `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
        at,
      ),
    );
  }

  label(raw: string, at: Span): string {
    const { label, problems } = readLabel(restoreEntities(raw).trim(), at);
    this.diagnostics.push(...problems);
    return label;
  }
}

/** A state first named, by a transition, above the line that declares its kind. */
function usedBeforeDeclared(state: ScannedState): boolean {
  const declared = state.declaredAt;
  return declared !== undefined && state.span.start.line < declared.start.line;
}

export function adaptState(data: StateData, scan: StateScan, fallback: Span): Adapted {
  const adapter = new Adapter(fallback);
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const noteNodes = data.nodes.filter((node) => node.shape === "note");
  const notesOf = new Map<string, StateDbNode[]>();
  for (const note of noteNodes) {
    const owner = /^(.*)----parent$/.exec(note.parentId ?? "")?.[1];
    if (owner === undefined) adapter.disagree(`a note that belongs to no state`);
    else notesOf.set(owner, [...(notesOf.get(owner) ?? []), note]);
  }

  const states: StateNode[] = [];
  const scanned = new Set<string>();
  for (const state of scan.states) {
    scanned.add(state.id);
    const node = nodes.get(state.id);
    const kind = node === undefined ? undefined : KINDS[node.shape];
    if (node === undefined || kind === undefined) {
      adapter.disagree(`state '${state.id}' as something other than a state`, state.span);
      continue;
    }
    if (kind !== state.kind && kind === "state" && usedBeforeDeclared(state)) {
      // Mermaid makes a state of a name at its first mention; a later `<<fork>>` does not change it.
      adapter.diagnostics.push(
        error(
          "parser_disagreement",
          `state '${state.id}' is used before \`state ${state.id} <<${state.kind}>>\` declares it, so Mermaid reads it as a plain state: ` +
            `declare \`state ${state.id} <<${state.kind}>>\` before its first use`,
          state.span,
        ),
      );
    } else if (kind !== state.kind)
      adapter.disagree(`state '${state.id}' as a ${kind}, not a ${state.kind}`, state.span);
    if ((node.parentId ?? undefined) !== state.scope) {
      adapter.disagree(
        `state '${state.id}' inside '${node.parentId ?? "the top level"}', not where it is written`,
        state.span,
      );
    }
    const label =
      kind === "initial"
        ? "start"
        : kind === "final"
          ? "end"
          : adapter.label(node.label, state.labelSpan ?? state.span);
    const model: StateNode = { id: state.id, label };
    if (kind !== "state") model.kind = kind;
    if (state.scope !== undefined) model.parentId = state.scope;
    const notes = notesOf.get(state.id) ?? [];
    if (notes.length !== (state.note === undefined ? 0 : 1)) {
      adapter.disagree(`${notes.length} notes on state '${state.id}'`, state.span);
    } else if (state.note !== undefined && notes[0] !== undefined) {
      const position = POSITIONS[notes[0].position ?? ""];
      if (position !== state.note.position)
        adapter.disagree(`the note on '${state.id}' on its other side`, state.note.span);
      model.note = { position: state.note.position, text: adapter.label(notes[0].label, state.note.span) };
    }
    states.push(model);
  }
  for (const node of data.nodes) {
    if (!isNote(node) && !scanned.has(node.id)) adapter.disagree(`a state '${node.id}' that is not written as one`);
  }

  const noteIds = new Set(data.nodes.filter(isNote).map((node) => node.id));
  const edges = data.edges.filter((edge) => !noteIds.has(edge.start) && !noteIds.has(edge.end));
  const unused = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = `${edge.start}--${edge.end}`;
    unused.set(key, [...(unused.get(key) ?? []), index]);
  });
  const transitions: StateTransition[] = [];
  for (const transition of scan.transitions) {
    const index = unused.get(transition.id)?.shift();
    const edge = index === undefined ? undefined : edges[index];
    if (edge === undefined) {
      adapter.disagree(`no transition from '${transition.source}' to '${transition.target}'`, transition.span);
      continue;
    }
    const model: StateTransition = { id: transition.id, source: transition.source, target: transition.target };
    if (transition.labelSpan !== undefined) model.label = adapter.label(edge.label, transition.labelSpan);
    else if (edge.label.trim() !== "")
      adapter.disagree(
        `a label on the transition from '${transition.source}' to '${transition.target}'`,
        transition.span,
      );
    transitions.push(model);
  }
  // A transition written again between the same two states: Mermaid's edge is matched and its label
  // checked, so nothing Mermaid reads goes unexamined, and it is left out of the model (the scan warns).
  for (const transition of scan.ignored) {
    const index = unused.get(transition.id)?.shift();
    const edge = index === undefined ? undefined : edges[index];
    if (edge === undefined)
      adapter.disagree(`no transition from '${transition.source}' to '${transition.target}'`, transition.span);
    else if (transition.labelSpan !== undefined) adapter.label(edge.label, transition.labelSpan);
  }
  const left = [...unused.values()].reduce((count, indexes) => count + indexes.length, 0);
  if (left > 0) adapter.disagree(`${left} more transition(s) than are written`);

  if (adapter.diagnostics.some(isError)) return { model: undefined, diagnostics: adapter.diagnostics };
  const model: StateMachine = { type: "state-machine", states, transitions };
  if (scan.direction !== undefined) model.direction = scan.direction;
  return { model, diagnostics: adapter.diagnostics };
}
