// list_walkthroughs and write_walkthrough (ADR 0034 §5). The walkthrough files
// are the state (ts/src/walkthroughs/store.ts), written here by the agent's
// side as comments are, without the service. The agent sends ids and text;
// grounding writes every label and line end from the current model.
import { existsSync, statSync } from "node:fs";
import { GitRepository } from "../accuracy/git.ts";
import type { DiagramEnvelope } from "../model/index.ts";
import { resolveInFolder, type Project } from "../project/index.ts";
import { revisionAt } from "../accuracy/history.ts";
import { WALKTHROUGH_ID, type Resolution, type Walkthrough } from "../walkthroughs/contract.ts";
import { deadCode, groundDraft } from "../walkthroughs/ground.ts";
import { refusedHost, resolveWalkthrough } from "../walkthroughs/resolve.ts";
import {
  invalid,
  parseDraft,
  walkthroughsPlaces,
  WalkthroughsStore,
  type WalkthroughsPlace,
} from "../walkthroughs/store.ts";
import { CommentsStore, type WalkthroughSubject } from "../comments/store.ts";
import { inventory, ModelCache, commentPathForView, type ViewEntry } from "./diagrams.ts";
import { nearest } from "../service/emphasis.ts";
import { type OperationError, quoted, toolError } from "./errors.ts";
import type { OperationResult } from "./index.ts";

const result = (text: string, structured: Record<string, unknown>): OperationResult => ({ text, structured });

/** A walkthroughs refusal under its stable code, with the walkthrough (walkthrough_changed) or issues it carries. */
export function walkthroughsFailure(error: import("../walkthroughs/store.ts").WalkthroughsError): OperationError {
  return toolError(error.code, error.message, { ...error.details });
}

/** Where each view's walkthroughs live: every view is considered, so two spelling one sidecar are both refused. */
export function placesOfViews(views: readonly ViewEntry[]): Map<string, WalkthroughsPlace> {
  return walkthroughsPlaces(
    views.map((v) => ({ id: v.id, path: v.source, ...(v.name === undefined ? {} : { embedded: { name: v.name } }) })),
  );
}

/** Where `view`'s walkthroughs live. Pass the `views` already in hand: the default scans the Archer folder. */
export function placeOf(
  project: Project,
  view: ViewEntry,
  views: readonly ViewEntry[] = inventory(project).views,
): WalkthroughsPlace {
  const place = placesOfViews(views).get(view.id);
  if (place === undefined)
    throw toolError(
      "diagram_not_found",
      `no diagram view is named ${quoted(view.id)}. Call list_diagrams to see the views.`,
    );
  return place;
}

/** What a view's model was when HEAD last held it: the revision `commit` vouches for. */
async function headHolds(project: Project, view: ViewEntry, modelRevision: string): Promise<string | undefined> {
  try {
    const git = await GitRepository.open(project.root);
    const head = await git.commit("HEAD");
    const place = { path: view.source, ...(view.name === undefined ? {} : { embedded: view.name }) };
    return (await revisionAt(git, project.folderSetting, head, place)) === modelRevision ? head : undefined;
  } catch {
    // Outside Git, before the first commit, or unreadable: no commit is recorded.
    return undefined;
  }
}

/** The view's walkthroughs as comment anchors see them, or null when the file cannot be read (a thread is then left as it is). */
export function walkthroughSubjects(
  project: Project,
  view: ViewEntry,
  views?: readonly ViewEntry[],
): Map<string, WalkthroughSubject> | null {
  try {
    return new WalkthroughsStore(project).subjects(placeOf(project, view, views));
  } catch {
    return null;
  }
}

/** Open comments on a walkthrough (ADR 0034 §9): unresolved threads the person has sent, on it or on one of its current steps. */
export interface OpenComments {
  /** Threads on the walkthrough itself. */
  readonly walkthrough: number;
  /** Only steps that have some, with their 1-based number. */
  readonly steps: readonly { readonly id: string; readonly step: number; readonly count: number }[];
}

/**
 * Per walkthrough id, its open comments. A thread is open while it is not resolved; a draft is the person's own
 * until they send it, so it is not counted. A thread whose walkthrough or step is gone is not counted either.
 * Null when the comments file cannot be read.
 */
export function openCommentsByWalkthrough(
  project: Project,
  view: ViewEntry,
  walkthroughs: readonly Walkthrough[],
): Map<string, OpenComments> | null {
  let threads;
  try {
    threads = new CommentsStore(project).list({ target: `view:${view.id}`, path: commentPathForView(view) }).threads;
  } catch {
    return null;
  }
  const open = threads.filter((t) => t.status !== "draft" && t.status !== "resolved");
  return new Map(
    walkthroughs.map((w) => {
      const whole = open.filter((t) => t.anchor.kind === "walkthrough" && t.anchor.walkthrough === w.id).length;
      const steps = w.steps.flatMap((s, i) => {
        const count = open.filter(
          (t) => t.anchor.kind === "step" && t.anchor.walkthrough === w.id && t.anchor.step === s.id,
        ).length;
        return count === 0 ? [] : [{ id: s.id, step: i + 1, count }];
      });
      return [w.id, { walkthrough: whole, steps }];
    }),
  );
}

const totalOf = (c: OpenComments): number => c.walkthrough + c.steps.reduce((n, s) => n + s.count, 0);

const summaryOf = (w: Walkthrough, r: Resolution, comments: OpenComments | undefined) => ({
  id: w.id,
  title: w.title,
  ...(w.description === undefined ? {} : { description: w.description }),
  steps: w.steps.length,
  status: r.status,
  outOfDate: r.outOfDate,
  changed: r.changed,
  modelRevision: w.modelRevision,
  revision: w.revision,
  ...(comments === undefined ? {} : { openComments: totalOf(comments) }),
});

const commentsText = (c: OpenComments | undefined): string => {
  if (c === undefined || totalOf(c) === 0) return "";
  const where = [
    c.walkthrough > 0 ? `${c.walkthrough} on the walkthrough` : "",
    ...c.steps.map((s) => `${s.count} on step ${s.step} (${s.id})`),
  ].filter((t) => t !== "");
  return ` Open comments: ${where.join(", ")}; call get_comments for them.`;
};

export function listWalkthroughs(
  project: Project,
  args: Readonly<Record<string, unknown>>,
  envelope: DiagramEnvelope | null,
  view: ViewEntry,
  views?: readonly ViewEntry[],
): OperationResult {
  const store = new WalkthroughsStore(project);
  const { walkthroughs } = store.read(placeOf(project, view, views));
  const unsupported = envelope === null ? null : refusedHost(envelope.model);
  // A diagram that never compiled has nothing to check against: its walkthroughs are unchecked, never "current".
  const resolve = (w: Walkthrough): Resolution =>
    envelope === null
      ? { id: w.id, status: "current", outOfDate: [], changed: [], steps: [] }
      : resolveWalkthrough(w, envelope.model);
  const comments = openCommentsByWalkthrough(project, view, walkthroughs);
  const wanted = args["id"];
  if (wanted !== undefined) {
    const found = walkthroughs.find((w) => w.id === wanted);
    if (found === undefined)
      throw walkthroughsFailure(
        invalid([
          {
            where: "id",
            problem: `no walkthrough ${quoted(String(wanted))} on ${view.id}`,
            fix:
              walkthroughs.length === 0
                ? "This diagram has none; leave id out to check."
                : `Use one of: ${walkthroughs.map((w) => w.id).join(", ")}.`,
          },
        ]),
      );
    const resolution = envelope === null ? null : resolve(found);
    return result(
      `Walkthrough '${found.id}' on '${view.id}': ${found.steps.length} steps, ${resolution === null ? "unchecked: the diagram has never compiled" : resolution.status}${resolution !== null && resolution.outOfDate.length > 0 ? ` (out of date: step ${resolution.outOfDate.join(", ")})` : ""}. Revision ${found.revision}, written against ${found.modelRevision.slice(0, 20)}.${commentsText(comments?.get(found.id))}`,
      {
        viewId: view.id,
        walkthrough: found,
        resolution,
        deadCode: deadCode(project.root, [found]),
        ...(comments?.has(found.id) ? { openComments: comments.get(found.id) } : {}),
      },
    );
  }
  const items = walkthroughs.map((w) => summaryOf(w, resolve(w), comments?.get(w.id)));
  const text =
    unsupported !== null
      ? `'${view.id}' cannot host walkthroughs: ${unsupported}.`
      : walkthroughs.length === 0
        ? `No walkthroughs on '${view.id}'.`
        : `${walkthroughs.length} walkthrough(s) on '${view.id}': ${items.map((i) => `${i.id} (${i.steps} steps, ${envelope === null ? "unchecked: the diagram has never compiled" : i.status})`).join("; ")}.`;
  return result(text, {
    viewId: view.id,
    walkthroughs: items,
    deadCode: deadCode(project.root, walkthroughs),
    ...(unsupported === null ? {} : { unsupported }),
  });
}

export interface WriteContext {
  readonly project: Project;
  readonly view: ViewEntry;
  /** The model written against, or null when the view has never compiled. */
  readonly envelope: DiagramEnvelope | null;
  /** The inventory the view came from, so it is not scanned again. */
  readonly views?: readonly ViewEntry[];
}

export async function writeWalkthrough(
  ctx: WriteContext,
  args: Readonly<Record<string, unknown>>,
): Promise<OperationResult> {
  const { project, view, envelope } = ctx;
  const store = new WalkthroughsStore(project);
  const place = placeOf(project, view, ctx.views);
  const expected = args["expectedRevision"] as number | undefined;

  if (args["delete"] === true) {
    const raw = args["walkthrough"];
    const id = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["id"] : undefined;
    if (typeof id !== "string" || !WALKTHROUGH_ID.test(id))
      throw walkthroughsFailure(
        invalid([
          {
            where: "walkthrough.id",
            problem: "is not a walkthrough id",
            fix: "Name the walkthrough to delete by its id from list_walkthroughs.",
          },
        ]),
      );
    if (expected === undefined)
      throw walkthroughsFailure(
        invalid([
          {
            where: "expectedRevision",
            problem: "is missing",
            fix: "Deleting needs the walkthrough's revision from list_walkthroughs, so a change made since is not lost.",
          },
        ]),
      );
    store.remove(place, id, expected);
    return result(`Deleted walkthrough '${id}' from '${view.id}'.`, { viewId: view.id, deleted: id });
  }

  if (envelope === null)
    throw toolError(
      "diagram_not_found",
      `no compiled diagram is available for view '${view.id}': its source has never compiled. Call read_diagram to see why.`,
    );
  const modelRevision = args["modelRevision"];
  if (typeof modelRevision !== "string")
    throw toolError(
      "invalid_arguments",
      "write_walkthrough needs modelRevision (read_diagram's), so the ids you read are the ids checked. Nothing was done.",
      { tool: "write_walkthrough", issues: [{ path: "modelRevision", problem: "is missing" }] },
    );
  if (modelRevision !== envelope.revision)
    throw toolError(
      "revision_conflict",
      `revision conflict: modelRevision ${modelRevision} is not the revision of the model being served, which is ${envelope.revision}. Nothing was written. Read the diagram again (read_diagram returns modelRevision), check the ids, and pass ${envelope.revision}.`,
      { expectedRevision: modelRevision, actualRevision: envelope.revision, modelRevision: envelope.revision },
    );

  const parsed = parseDraft(args["walkthrough"]);
  if (parsed.draft === null) throw walkthroughsFailure(invalid(parsed.issues));
  const grounded = groundDraft(parsed.draft, envelope.model, {
    root: project.root,
    noteExists: (path) => noteExists(project, path),
  });
  if (!grounded.ok) throw walkthroughsFailure(invalid(grounded.issues));

  const commit = await headHolds(project, view, envelope.revision);
  const stored = store.write(place, {
    walkthrough: grounded.walkthrough,
    modelRevision: envelope.revision,
    author: "agent",
    ...(expected === undefined ? {} : { expectedRevision: expected }),
    ...(commit === undefined ? {} : { commit }),
  });
  const resolution = resolveWalkthrough(stored, envelope.model);
  const comments = openCommentsByWalkthrough(project, view, [stored])?.get(stored.id);
  return result(
    `Wrote walkthrough '${stored.id}' on '${view.id}' (revision ${stored.revision}, ${stored.steps.length} steps, ${resolution.status}). Show it with present_diagram walkthrough: { id: "${stored.id}" }. To change it, pass revision ${stored.revision} as expectedRevision.${commentsText(comments)}`,
    { viewId: view.id, walkthrough: stored, resolution, ...(comments === undefined ? {} : { openComments: comments }) },
  );
}

function noteExists(project: Project, path: string): boolean {
  try {
    const absolute = resolveInFolder(project, path);
    return path.endsWith(".md") && existsSync(absolute) && statSync(absolute).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------- write_diagram's report

/** The view's walkthroughs, or none when it has no readable file (a malformed file is the agent's to hear of elsewhere). */
export function heldWalkthroughs(project: Project, view: ViewEntry, views?: readonly ViewEntry[]): Walkthrough[] {
  try {
    return [...new WalkthroughsStore(project).read(placeOf(project, view, views)).walkthroughs];
  } catch {
    return [];
  }
}

export interface WalkthroughChange {
  readonly id: string;
  readonly status: Resolution["status"];
  readonly outOfDate: readonly number[];
  readonly changed: readonly number[];
}

/**
 * The walkthroughs a write moved (ADR 0034 §3): those whose status, or whose
 * out-of-date or changed steps, differ between the model before and the one
 * after. Empty when nothing moved, so the caller omits the key.
 */
export function walkthroughChange(
  held: readonly Walkthrough[],
  before: DiagramEnvelope | null,
  after: DiagramEnvelope | null,
): WalkthroughChange[] {
  if (before === null || after === null) return [];
  const key = (r: Resolution) => `${r.status}|${r.outOfDate.join(",")}|${r.changed.join(",")}`;
  return held.flatMap((w) => {
    const now = resolveWalkthrough(w, after.model);
    return key(resolveWalkthrough(w, before.model)) === key(now)
      ? []
      : [{ id: w.id, status: now.status, outOfDate: now.outOfDate, changed: now.changed }];
  });
}

/** The sentence that tells the agent what its write did to the walkthroughs, and what to do (never unasked). */
export function walkthroughChangeText(changes: readonly WalkthroughChange[]): string {
  const parts = changes.map((c) => {
    const said = [
      c.outOfDate.length > 0 ? `step ${c.outOfDate.join(", ")} out of date` : "",
      c.changed.length > 0 ? `step ${c.changed.join(", ")} reworded on the diagram` : "",
    ].filter((t) => t !== "");
    return `'${c.id}' is ${c.status}${said.length > 0 ? ` (${said.join("; ")})` : ""}`;
  });
  return `This write moved walkthrough(s): ${parts.join("; ")}. The write stands; offer to repair them with write_walkthrough, never unasked.`;
}

// ---------------------------------------------------- list_stale_diagrams

export interface StaleWalkthrough {
  readonly viewId: string;
  readonly id: string;
  readonly status: Resolution["status"];
  readonly outOfDate: readonly number[];
  readonly changed: readonly number[];
  readonly deadCode: readonly { readonly step: number; readonly ref: string; readonly reason: string }[];
}

/**
 * Every walkthrough that needs attention, on any diagram (covered by code or
 * not): not current, or with a reworded step or a dead code path. Nothing is
 * written; a diagram that has never compiled is skipped.
 */
export async function staleWalkthroughs(project: Project, viewId?: string): Promise<StaleWalkthrough[]> {
  const models = new ModelCache();
  const stale: StaleWalkthrough[] = [];
  const views = inventory(project).views;
  for (const view of views) {
    if (viewId !== undefined && view.id !== viewId) continue;
    const held = heldWalkthroughs(project, view, views);
    if (held.length === 0) continue;
    const { envelope } = await models.compile(project, view);
    if (envelope === null) continue;
    const dead = deadCode(project.root, held);
    for (const w of held) {
      const r = resolveWalkthrough(w, envelope.model);
      const code = dead.filter((d) => d.id === w.id).map(({ step, ref, reason }) => ({ step, ref, reason }));
      if (r.status !== "current" || r.changed.length > 0 || code.length > 0)
        stale.push({
          viewId: view.id,
          id: w.id,
          status: r.status,
          outOfDate: r.outOfDate,
          changed: r.changed,
          deadCode: code,
        });
    }
  }
  return stale;
}

// ---------------------------------------------------------- list_diagrams

/** How many walkthroughs each view has, read from the files without resolving them (ADR 0034 §3). Views with none are absent. */
export function walkthroughCounts(project: Project, views: readonly ViewEntry[]): Map<string, number> {
  const store = new WalkthroughsStore(project);
  const places = placesOfViews(views);
  const counts = new Map<string, number>();
  for (const place of places.values()) {
    if (place.conflict !== undefined) continue;
    const read = store.peek(place);
    if (read.kind === "ok" && read.file.walkthroughs.length > 0)
      counts.set(place.viewId, read.file.walkthroughs.length);
  }
  return counts;
}

// ------------------------------------------------------------ present_diagram

export interface PresentedWalkthrough {
  readonly id: string;
  readonly step: number;
  readonly status: Resolution["status"];
  readonly steps: number;
}

/**
 * present_diagram's `walkthrough: {id, step?}`, checked against the stored walkthrough and the model
 * being presented. An archived one is presented too: the page opens it as a whole (no step) and offers the
 * version it was written for (slice 7b).
 */
export function presentableWalkthrough(
  project: Project,
  view: ViewEntry,
  envelope: DiagramEnvelope,
  ask: { readonly id: string; readonly step?: number },
): PresentedWalkthrough {
  const { walkthroughs } = new WalkthroughsStore(project).read(placeOf(project, view));
  const found = walkthroughs.find((w) => w.id === ask.id);
  if (found === undefined) {
    const hint = nearest(ask.id, new Set(walkthroughs.map((w) => w.id)));
    throw walkthroughsFailure(
      invalid([
        {
          where: "walkthrough.id",
          problem: `no walkthrough ${quoted(ask.id)} on '${view.id}'`,
          fix:
            hint !== null
              ? `Did you mean ${JSON.stringify(hint)}?`
              : walkthroughs.length === 0
                ? "This diagram has none: call list_walkthroughs, or present it with emphasis."
                : `Use one of: ${walkthroughs.map((w) => w.id).join(", ")}.`,
        },
      ]),
    );
  }
  const step = ask.step ?? 1;
  const resolution = resolveWalkthrough(found, envelope.model);
  const issues = [];
  if (step > found.steps.length)
    issues.push({
      where: "walkthrough.step",
      problem: `step ${step} is past the end: '${found.id}' has ${found.steps.length} steps`,
      fix: `Use a step from 1 to ${found.steps.length}.`,
    });
  if (issues.length > 0) throw walkthroughsFailure(invalid(issues));
  return { id: found.id, step, status: resolution.status, steps: found.steps.length };
}
