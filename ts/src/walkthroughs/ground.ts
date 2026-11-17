// Grounding (ADR 0034 §1, §5): a caller's walkthrough checked against the
// current model and the repository, with every label and edge end written by
// Archer from the model, never taken from the caller (as comments' `ground`).
// Code paths go through the doc pack's resolver (ADR 0033 §5).
//
// All or nothing: any problem refuses the whole walkthrough, and the issues
// name every problem with a fix ("Did you mean" for near ids).
import { refProblem, type IdentifierCache } from "../docs/pack.ts";
import type { DiagramModel } from "../model/index.ts";
import { nearest } from "../service/emphasis.ts";
import type { DraftWalkthrough, EdgeRef, Issue, NodeRef, Walkthrough } from "./contract.ts";
import { indexOf, nodeLabel, refusedHost } from "./resolve.ts";
import { parseDraft, type GroundedWalkthrough } from "./store.ts";

export interface GroundContext {
  /** The repository root code references are relative to. */
  readonly root: string;
  /** Whether a folder-relative note exists. */
  readonly noteExists: (path: string) => boolean;
}

/** A caller's walkthrough, shape only (store.ts `parseDraft`). */
export const readDraft = parseDraft;

const quoted = (s: string): string => JSON.stringify(s);

export function groundDraft(
  draft: DraftWalkthrough,
  model: DiagramModel,
  ctx: GroundContext,
): { ok: true; walkthrough: GroundedWalkthrough } | { ok: false; issues: Issue[] } {
  const refused = refusedHost(model);
  const index = indexOf(model);
  if (refused !== null || index === null)
    return {
      ok: false,
      issues: [
        {
          where: "viewId",
          problem: refused ?? "walkthroughs are on graph diagrams",
          fix: "Present the diagram with emphasis instead, or write the walkthrough on a flowchart, C4, state, ER or architecture diagram.",
        },
      ],
    };
  const issues: Issue[] = [];
  const issue = (where: string, problem: string, fix: string) => issues.push({ where, problem, fix });
  const nodeIds = new Set(index.nodes.keys()),
    groupIds = new Set(index.groups.keys()),
    edgeIds = new Set(index.edges.keys());
  const didYouMean = (id: string, among: ReadonlySet<string>, otherwise: string) => {
    const hint = nearest(id, among);
    return hint === null ? otherwise : `Did you mean ${quoted(hint)}?`;
  };
  const cache: IdentifierCache = new Map();

  const steps = draft.steps.map((step, s): GroundedWalkthrough["steps"][number] => {
    const where = `steps[${s}]`;
    const nodes = step.nodes.flatMap((ref, i): NodeRef[] => {
      const at = `${where}.nodes[${i}]`;
      const label = nodeLabel(index, ref.kind, ref.id);
      if (label !== undefined) return [{ kind: ref.kind, id: ref.id, label }];
      const other = ref.kind === "node" ? "group" : "node";
      if (nodeLabel(index, other, ref.id) !== undefined)
        issue(at, `${quoted(ref.id)} is a ${other} in this diagram, not a ${ref.kind}`, `Set kind: ${quoted(other)}.`);
      else if (edgeIds.has(ref.id)) issue(at, `${quoted(ref.id)} is a line, not a box`, "Move it to edges.");
      else
        issue(
          at,
          `no ${ref.kind} ${quoted(ref.id)} in this diagram`,
          didYouMean(
            ref.id,
            ref.kind === "group" ? groupIds : nodeIds,
            "Call read_diagram to list the ids this diagram declares.",
          ),
        );
      return [];
    });
    const edges = step.edges.flatMap((ref, i): EdgeRef[] => {
      const at = `${where}.edges[${i}]`;
      const edge = index.edges.get(ref.id);
      if (edge !== undefined)
        return [
          {
            id: ref.id,
            source: edge.source,
            target: edge.target,
            ...(edge.label === undefined ? {} : { label: edge.label }),
          },
        ];
      if (nodeIds.has(ref.id) || groupIds.has(ref.id))
        issue(at, `${quoted(ref.id)} is a box, not a line`, "Move it to nodes.");
      else
        issue(
          at,
          `no edge ${quoted(ref.id)} in this diagram`,
          didYouMean(
            ref.id,
            edgeIds,
            "Edge ids are the ones read_diagram lists: a flowchart's `a id@--> b`, elsewhere `from--to`.",
          ),
        );
      return [];
    });
    const repeated = (ids: string[], what: string) => {
      if (new Set(ids).size !== ids.length)
        issue(where, `names one ${what} twice`, `Name each ${what} once in a step.`);
    };
    repeated(
      step.nodes.map((n) => `${n.kind}:${n.id}`),
      "box",
    );
    repeated(
      step.edges.map((e) => e.id),
      "line",
    );
    step.messages.forEach((m, i) => {
      for (const end of ["from", "to"] as const)
        if (!nodeIds.has(m[end]))
          issue(
            `${where}.messages[${i}]`,
            `its ${end} ${quoted(m[end])} is not a box in this diagram`,
            didYouMean(
              m[end],
              nodeIds,
              "A message runs between two boxes of this diagram; it needs no line between them.",
            ),
          );
    });
    (step.code ?? []).forEach((ref, i) => {
      const problem = refProblem(ctx.root, ref, cache);
      if (problem !== null)
        issue(
          `${where}.code[${i}]`,
          `${quoted(ref)} ${problem}`,
          "Name only code that exists in the repository, or leave code out.",
        );
    });
    return {
      ...(step.id === undefined ? {} : { id: step.id }),
      title: step.title,
      kind: step.kind,
      what: step.what,
      ...(step.why === undefined ? {} : { why: step.why }),
      ...(step.code === undefined ? {} : { code: step.code }),
      ...(nodes.length === 0 ? {} : { nodes }),
      ...(edges.length === 0 ? {} : { edges }),
      ...(step.messages.length === 0 ? {} : { messages: step.messages }),
    };
  });
  (draft.open ?? []).forEach((id, i) => {
    if (!groupIds.has(id))
      issue(
        `open[${i}]`,
        `${quoted(id)} is not a container in this diagram`,
        didYouMean(id, groupIds, "The starting open set names containers: subgraphs, boundaries or groups."),
      );
  });
  if (draft.note !== undefined && !ctx.noteExists(draft.note))
    issue(
      "note",
      `there is no note ${quoted(draft.note)} in the Archer folder`,
      "Name an existing note, relative to the Archer folder, or leave note out.",
    );
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    walkthrough: {
      id: draft.id,
      title: draft.title,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      ...(draft.note === undefined ? {} : { note: draft.note }),
      ...(draft.open === undefined ? {} : { open: draft.open }),
      steps,
    },
  };
}

/** The code references that no longer resolve, per walkthrough and 1-based step (ADR 0033 §5). */
export function deadCode(
  root: string,
  walkthroughs: readonly Walkthrough[],
  cache: IdentifierCache = new Map(),
): { id: string; step: number; ref: string; reason: string }[] {
  return walkthroughs.flatMap((w) =>
    w.steps.flatMap((step, i) =>
      (step.code ?? []).flatMap((ref) => {
        const reason = refProblem(root, ref, cache);
        return reason === null ? [] : [{ id: w.id, step: i + 1, ref, reason }];
      }),
    ),
  );
}
