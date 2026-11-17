// The rename plan (ADR 0036 §10, A14, O9): project-wide ids for an existing project, by renaming
// element ids view by view. A plan is built and dry-run first: every planned diagram write goes
// through validate_diagram (the production checks, write refusals included), every walkthrough
// rewrite is grounded against the renamed model, and the plan is ready only when all of them pass.
// Applied, it is one revision-checked write_diagram per view, each followed by write_walkthrough for
// the walkthroughs on it that name a renamed id; each diagram is read again just before its write
// (a note's other blocks may have been written a moment before), and the first failure stops it
// with a report of what was written and what was not. No trail of old ids is kept.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../mermaid/index.ts";
import type { DiagramEnvelope, DiagramModel } from "../model/index.ts";
import { isStableId, modelForKind } from "../model/index.ts";
import { elementsOf } from "../model/elements.ts";
import { resolveInFolder, type Project } from "../project/index.ts";
import { projectReport, similarPairs } from "../project-model/advice.ts";
import {
  mergeProjectModel,
  type ModelElement,
  type ModelInputView,
  type ProjectModel,
} from "../project-model/merge.ts";
import {
  derivesEdgeIds,
  isRenameOf,
  renameModel,
  renameSource,
  renameWalkthrough,
  unrenamable,
} from "../project-model/rename.ts";
import type { DraftWalkthrough, Walkthrough, WalkthroughStatus } from "../walkthroughs/contract.ts";
import { groundDraft } from "../walkthroughs/ground.ts";
import { resolveWalkthrough } from "../walkthroughs/resolve.ts";
import type { Application } from "./index.ts";
import { capBreach, capOver } from "./docs.ts";
import { ProjectModelCache } from "./project-model.ts";
import { MAX_SUMMARY_CHARS } from "../service/protocol.ts";

/** One rename: `from` becomes `to` in `views`, or in every view that draws `from` as an element. */
export interface RenameEntry {
  readonly from: string;
  readonly to: string;
  readonly views?: readonly string[];
  /** One line for the person: why (the finding it settles). */
  readonly why?: string;
}

export interface PlannedDiagramWrite {
  readonly kind: "diagram";
  readonly viewId: string;
  readonly renames: readonly (readonly [string, string])[];
  /** The source revision the plan was built on: the write's expectedRevision. */
  readonly sourceRevision: string;
  readonly source: string;
}

export interface PlannedWalkthroughWrite {
  readonly kind: "walkthrough";
  readonly viewId: string;
  readonly walkthroughId: string;
  readonly expectedRevision: number;
  readonly draft: DraftWalkthrough;
  readonly status: WalkthroughStatus;
}

export type PlannedWrite = PlannedDiagramWrite | PlannedWalkthroughWrite;

export interface PlanProblem {
  readonly viewId?: string;
  readonly walkthroughId?: string;
  readonly entry?: RenameEntry;
  readonly problem: string;
}

/** The model findings a plan is for: conflicts and possible duplicates, by element. */
export interface Tally {
  readonly kindConflicts: readonly string[];
  readonly parentConflicts: readonly string[];
  readonly duplicates: readonly string[];
}

export interface RenamePlan {
  readonly entries: readonly RenameEntry[];
  readonly writes: readonly PlannedWrite[];
  readonly problems: readonly PlanProblem[];
  /** Every planned write passed its dry run: the plan may be offered. */
  readonly ready: boolean;
  readonly before: Tally;
  /** The model as it would be after the plan, from the dry run's compiled models. */
  readonly after: Tally;
}

const text = (r: { structured: Record<string, unknown> }, key: string): string => String(r.structured[key]);

function tally(model: ProjectModel, inputs: readonly ModelInputView[]): Tally {
  const report = projectReport(model, inputs);
  const of = (code: string) =>
    report.model
      .filter((a) => a.code === code)
      .map((a) => (code === "possible_duplicate" ? `${a.element} ~ ${a.other}` : a.element!));
  return {
    kindConflicts: of("element_kind_conflict"),
    parentConflicts: of("element_parent_conflict"),
    duplicates: of("possible_duplicate"),
  };
}

function noteExists(project: Project, path: string): boolean {
  try {
    const absolute = resolveInFolder(project, path);
    return path.endsWith(".md") && existsSync(absolute) && statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * Entries for the report's possible duplicates (§10): the C4 id survives, else the most-drawn one,
 * else the first by id. Kind and parent conflicts need a name the person agrees, so none is guessed.
 */
export function suggestedEntries(model: ProjectModel): RenameEntry[] {
  return similarPairs(model).map(({ a, b }) => {
    const keep = survivor(a, b);
    return entryFor(keep === a ? b : a, keep);
  });
}

/** Which of two look-alike elements keeps its id (§10): the C4 one, else the more drawn, else the first by id. */
export function survivor(x: ModelElement, y: ModelElement): ModelElement {
  const c4 = (e: ModelElement) => e.occurrences.some((o) => o.family === "c4");
  const drawn = (e: ModelElement) => new Set([...e.drawnIn, ...e.opensIn]).size;
  return c4(x) !== c4(y)
    ? c4(x)
      ? x
      : y
    : drawn(x) !== drawn(y)
      ? drawn(x) > drawn(y)
        ? x
        : y
      : x.id < y.id
        ? x
        : y;
}

/** The plan entry that renames `lose` to `keep`: one line, with why. */
export const entryFor = (lose: ModelElement, keep: ModelElement, views?: readonly string[]): RenameEntry => ({
  from: lose.id,
  to: keep.id,
  ...(views === undefined ? {} : { views }),
  why: `'${lose.id}' (${lose.name}) and '${keep.id}' (${keep.name}) look like one thing`,
});

/** Builds and dry-runs a plan. Writes nothing. */
export async function planRenames(
  app: Application,
  project: Project,
  entries: readonly RenameEntry[],
  cache = new ProjectModelCache(),
): Promise<RenamePlan> {
  const built = await cache.build(project);
  const problems: PlanProblem[] = [];
  const writes: PlannedWrite[] = [];
  const perView = new Map<string, Map<string, string>>();
  const entryOf = new Map<string, RenameEntry>();
  for (const entry of entries) {
    if (!isStableId(entry.to)) {
      problems.push({ entry, problem: `'${entry.to}' is not an id (letters, digits, "-" and "_")` });
      continue;
    }
    if (entry.from === entry.to) {
      problems.push({ entry, problem: "renames an id to itself" });
      continue;
    }
    const drawn = [
      ...new Set(built.model.index.find((e) => e.id === entry.from)?.occurrences.map((o) => o.viewId) ?? []),
    ];
    const views = entry.views ?? drawn;
    if (views.length === 0) {
      problems.push({ entry, problem: `no diagram draws '${entry.from}' as an element` });
      continue;
    }
    for (const viewId of views) {
      const map = perView.get(viewId) ?? new Map<string, string>();
      if (map.has(entry.from) && map.get(entry.from) !== entry.to)
        problems.push({ viewId, entry, problem: `'${entry.from}' is renamed twice in this view` });
      map.set(entry.from, entry.to);
      perView.set(viewId, map);
      entryOf.set(`${viewId}\0${entry.from}`, entry);
    }
  }
  const inputs = new Map(built.inputs.map((v) => [v.id, v]));
  const order = built.inputs.map((v) => v.id).filter((id) => perView.has(id));
  /** Per file, its planned text edits (old block source → new), for the cap check across a note's blocks. */
  const edits = new Map<string, { viewId: string; was: string; next: string; renames: Map<string, string> }[]>();
  for (const missing of [...perView.keys()].filter((id) => !inputs.has(id)))
    problems.push({ viewId: missing, problem: "no such view" });
  for (const viewId of order) {
    const renames = perView.get(viewId)!;
    const read = await app.call("read_diagram", { viewId });
    const envelope = read.structured["envelope"] as DiagramEnvelope | null;
    const source = (read.structured["source"] as { status: string; text?: string } | undefined)?.text;
    if (envelope === null || source === undefined) {
      problems.push({ viewId, problem: "its source does not compile now; fix it first" });
      continue;
    }
    const model = envelope.model;
    const refused = unrenamable(model);
    if (refused !== null) {
      problems.push({ viewId, problem: refused });
      continue;
    }
    const at = (from: string) => ({ viewId, entry: entryOf.get(`${viewId}\0${from}`)! });
    const collisions = renameCollisions(idsOf(model), renames);
    for (const c of collisions) problems.push({ ...at(c.from), problem: c.problem });
    if (collisions.length > 0) continue;
    const next = renameSource(source, model, renames);
    // Compiled as the view carries it: a flowchart in a c4-* view is an architecture graph (O260).
    const retyped = async (text: string): Promise<DiagramModel | null> => {
      const { model: compiled } = await compile(text);
      return compiled === null ? null : modelForKind(compiled, envelope.view.kind);
    };
    const compiled = { model: await retyped(next) };
    if (compiled.model === null || !isRenameOf(model, compiled.model, renames)) {
      // Name the renames that fail on their own, so the rest of the plan can be offered without them.
      for (const [from, to] of renames) {
        const alone = new Map([[from, to]]);
        const one = await retyped(renameSource(source, model, alone));
        if (one === null || !isRenameOf(model, one, alone))
          problems.push({
            ...at(from),
            problem: `'${from}' cannot be renamed here by text without changing more than ids; rename it by hand`,
          });
      }
      if (!problems.some((p) => p.viewId === viewId))
        problems.push({ viewId, problem: "these renames cannot be made together by text; rename them by hand" });
      continue;
    }
    const checked = await app.call("validate_diagram", { viewId, source: next });
    // write_diagram refuses a docs-mode file past its cap; validate_diagram only warns of it.
    const overCap = (checked.structured["diagnostics"] as { code: string }[]).some((d) => d.code === "doc_over_cap");
    if (overCap) {
      for (const from of renames.keys())
        problems.push({
          ...at(from),
          problem: `the renamed file is over its docs-mode cap: ${checked.text.split("\n").find((l) => l.includes("over its")) ?? "doc_over_cap"}`,
        });
      continue;
    }
    const file = viewId.includes("#") ? viewId.slice(0, viewId.indexOf("#")) : null;
    if (file !== null) edits.set(file, [...(edits.get(file) ?? []), { viewId, was: source, next, renames }]);
    if (checked.structured["valid"] !== true) {
      const errors = (
        checked.structured["diagnostics"] as { severity: string; code: string; message: string }[]
      ).filter((d) => d.severity === "error");
      problems.push({
        viewId,
        problem: `validate_diagram refuses it: ${errors.map((d) => `${d.code}: ${d.message}`).join("; ") || checked.text}`,
      });
      continue;
    }
    writes.push({
      kind: "diagram",
      viewId,
      renames: [...renames],
      sourceRevision: text(read, "sourceRevision"),
      source: next,
    });
    writes.push(...(await walkthroughWrites(app, project, viewId, model, compiled.model, renames, problems)));
  }
  // A note's blocks each fit on their own but may not together: check the note as the plan leaves it.
  for (const [file, planned] of edits) {
    if (planned.length < 2) continue;
    let before: string;
    try {
      before = readFileSync(join(project.folder, ...file.split("/")), "utf8");
    } catch {
      continue;
    }
    const after = planned.reduce((text, e) => text.replace(e.was, e.next), before);
    const breach = capBreach(project, file, before, after);
    if (breach === null) continue;
    for (const e of planned) {
      for (const from of e.renames.keys())
        problems.push({
          viewId: e.viewId,
          entry: entryOf.get(`${e.viewId}\0${from}`)!,
          problem: `together with the plan's other writes to ${file}: ${capOver(breach)}`,
        });
    }
  }
  const afterInputs = built.inputs.map((v) => {
    const write = writes.find((w): w is PlannedDiagramWrite => w.kind === "diagram" && w.viewId === v.id);
    return write === undefined || v.envelope === null
      ? v
      : { ...v, envelope: { ...v.envelope, model: renameModel(v.envelope.model, new Map(write.renames)) } };
  });
  return {
    entries,
    writes,
    problems,
    ready: problems.length === 0,
    before: tally(built.model, built.inputs),
    after: tally(mergeProjectModel(afterInputs), afterInputs),
  };
}

/** Every id a drawing holds: its elements, unkinded nodes, groups and boundaries share one namespace. */
export const idsOf = (model: DiagramModel): Set<string> => new Set(elementsOfAny(model));

/** One rename of a view that cannot be made: its source id, why, and the other source it competes with. */
export interface RenameCollision {
  readonly from: string;
  readonly problem: string;
  readonly with?: string;
}

/**
 * The plan's preflight for one view whose ids are `ids` (rename suggestions run it too, P44): a source
 * not in the view; a target already in it (a merge, not a rename), unless the same renames move that id
 * away (a swap: svc → service, service → serviceModule); two sources onto one target, each named.
 */
export function renameCollisions(ids: ReadonlySet<string>, renames: ReadonlyMap<string, string>): RenameCollision[] {
  const out: RenameCollision[] = [];
  const onto = new Map<string, string[]>();
  for (const [from, to] of renames) {
    if (!ids.has(from)) out.push({ from, problem: `'${from}' is not in this view` });
    if (ids.has(to) && !renames.has(to))
      out.push({
        from,
        problem: `'${to}' is already in this view: two of its elements would share one id (a merge, not a rename)`,
      });
    onto.set(to, [...(onto.get(to) ?? []), from]);
  }
  for (const [to, froms] of onto)
    if (froms.length > 1)
      for (const from of froms)
        for (const other of froms)
          if (other !== from)
            out.push({
              from,
              with: other,
              problem: `'${from}' and '${other}' would both become '${to}' in this view: two of its elements would share one id (a merge, not a rename)`,
            });
  return out;
}

const elementsOfAny = (model: DiagramModel): string[] =>
  model.type === "sequence-trace"
    ? model.participants.map((p) => p.id)
    : model.type === "user-journey"
      ? []
      : [
          ...elementsOf(model).nodes.map((n) => n.id),
          ...("groups" in model && Array.isArray(model.groups) ? model.groups.map((g: { id: string }) => g.id) : []),
        ];

async function walkthroughWrites(
  app: Application,
  project: Project,
  viewId: string,
  before: DiagramModel,
  after: DiagramModel,
  renames: ReadonlyMap<string, string>,
  problems: PlanProblem[],
): Promise<PlannedWalkthroughWrite[]> {
  const listed = await app.call("list_walkthroughs", { viewId });
  if (listed.structured["unsupported"] !== undefined) return [];
  const out: PlannedWalkthroughWrite[] = [];
  for (const item of listed.structured["walkthroughs"] as { id: string }[]) {
    const one = await app.call("list_walkthroughs", { viewId, id: item.id });
    const walkthrough = one.structured["walkthrough"] as Walkthrough;
    const was = resolveWalkthrough(walkthrough, before).status;
    const { draft, touched } = renameWalkthrough(walkthrough, renames, derivesEdgeIds(before));
    if (!touched) {
      // It names no renamed id; it must still read the same after the rename.
      const now = resolveWalkthrough(walkthrough, after).status;
      if (now !== was)
        problems.push({
          viewId,
          walkthroughId: item.id,
          problem: `would go from ${was} to ${now} without naming a renamed id`,
        });
      continue;
    }
    const grounded = groundDraft(draft, after, { root: project.root, noteExists: (path) => noteExists(project, path) });
    if (!grounded.ok) {
      problems.push({
        viewId,
        walkthroughId: item.id,
        problem: `its rewrite does not ground: ${grounded.issues.map((i) => `${i.where}: ${i.problem}`).join("; ")}`,
      });
      continue;
    }
    const now = resolveWalkthrough({ ...walkthrough, ...grounded.walkthrough } as Walkthrough, after).status;
    if (was === "current" && now !== "current") {
      problems.push({ viewId, walkthroughId: item.id, problem: `would be ${now} after the rename` });
      continue;
    }
    out.push({
      kind: "walkthrough",
      viewId,
      walkthroughId: item.id,
      expectedRevision: walkthrough.revision,
      draft,
      status: now,
    });
  }
  return out;
}

export interface PlanRun {
  readonly completed: boolean;
  readonly done: readonly PlannedWrite[];
  readonly failed?: { readonly write: PlannedWrite; readonly code: string; readonly message: string };
  readonly notDone: readonly PlannedWrite[];
  /** What was done, for the person, in a few lines. */
  readonly text: string;
}

export interface ApplyHooks {
  /** Called before each write: tests inject a concurrent edit here. */
  readonly beforeWrite?: (write: PlannedWrite, index: number) => void | Promise<void>;
}

/** The write's summary for the person's change list, within its cap. */
function summaryOf(write: PlannedDiagramWrite): string {
  const all = `Rename plan: ${write.renames.map(([a, b]) => `${a} → ${b}`).join(", ")}`;
  return all.length <= MAX_SUMMARY_CHARS ? all : `Rename plan: ${write.renames.length} ids renamed`;
}

const describe = (w: PlannedWrite): string =>
  w.kind === "diagram"
    ? `${w.viewId} (${w.renames.map(([a, b]) => `${a} → ${b}`).join(", ")})`
    : `walkthrough ${w.walkthroughId} on ${w.viewId}`;

/** Applies a ready plan in order; stops at the first failure and says what it did. */
export async function applyRenamePlan(app: Application, plan: RenamePlan, hooks: ApplyHooks = {}): Promise<PlanRun> {
  if (!plan.ready) throw new Error("the plan has problems: it is not offered, and not applied");
  const done: PlannedWrite[] = [];
  const modelRevision = new Map<string, string>();
  let failed: PlanRun["failed"];
  for (const [index, write] of plan.writes.entries()) {
    try {
      await hooks.beforeWrite?.(write, index);
      if (write.kind === "diagram") {
        // Read again just before writing: an earlier write to the same note, or an editor, may have moved it.
        const now = await app.call("read_diagram", { viewId: write.viewId });
        if (text(now, "sourceRevision") !== write.sourceRevision)
          throw Object.assign(
            new Error(
              `${write.viewId} changed since the plan was made (source revision ${text(now, "sourceRevision").slice(0, 15)}, planned on ${write.sourceRevision.slice(0, 15)})`,
            ),
            { data: { code: "revision_conflict" } },
          );
        const written = await app.call("write_diagram", {
          viewId: write.viewId,
          source: write.source,
          expectedRevision: write.sourceRevision,
          summary: summaryOf(write),
        });
        if (written.structured["status"] !== "compiled")
          throw Object.assign(new Error(`${write.viewId} was written but does not compile`), {
            data: { code: "invalid_source" },
          });
        modelRevision.set(write.viewId, text(written, "modelRevision"));
      } else {
        const revision =
          modelRevision.get(write.viewId) ??
          text(await app.call("read_diagram", { viewId: write.viewId }), "modelRevision");
        const written = await app.call("write_walkthrough", {
          viewId: write.viewId,
          modelRevision: revision,
          walkthrough: write.draft,
          expectedRevision: write.expectedRevision,
        });
        const status = (written.structured["resolution"] as { status: string } | undefined)?.status;
        if (status !== write.status)
          throw Object.assign(
            new Error(`walkthrough ${write.walkthroughId} was written but is ${status}, not ${write.status}`),
            { data: { code: "walkthrough_out_of_date" } },
          );
      }
      done.push(write);
    } catch (error) {
      const e = error as { message?: string; data?: { code?: string } };
      failed = { write, code: e.data?.code ?? "internal", message: e.message ?? String(error) };
      break;
    }
  }
  const notDone = plan.writes.slice(done.length + (failed === undefined ? 0 : 1));
  const lines: string[] = [];
  if (failed === undefined)
    lines.push(
      `Rename plan applied: ${done.filter((w) => w.kind === "diagram").length} diagrams and ${done.filter((w) => w.kind === "walkthrough").length} walkthroughs written.`,
    );
  else {
    lines.push(
      `Rename plan stopped at ${describe(failed.write)}: ${failed.code}: ${failed.message}. Nothing after it was written; nothing before it was undone.`,
    );
    lines.push(done.length === 0 ? "Written: nothing." : `Written: ${done.map(describe).join("; ")}.`);
    lines.push(`Not written: ${[failed.write, ...notDone].map(describe).join("; ")}.`);
    const behind = [failed.write, ...notDone].filter(
      (w): w is PlannedWalkthroughWrite =>
        w.kind === "walkthrough" && done.some((d) => d.kind === "diagram" && d.viewId === w.viewId),
    );
    if (behind.length > 0)
      lines.push(
        `Out of date until written: ${behind.map((w) => `walkthrough ${w.walkthroughId} on ${w.viewId}`).join("; ")}.`,
      );
    lines.push("Build the plan again from the project as it is now to finish.");
  }
  return {
    completed: failed === undefined,
    done,
    ...(failed === undefined ? {} : { failed }),
    notDone,
    text: lines.join("\n"),
  };
}
