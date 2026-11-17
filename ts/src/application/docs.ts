// docs_index (docs/proposals/doc-pack.md, Tools; ADR 0033): route a question to the doc pack, return
// the router, regenerate it, and report the pack's health. Read-only except `write`, which replaces
// index.md, the one generated file, through the confined writer.
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { listStaleDiagrams } from "../accuracy/index.ts";
import { buildPack, packHealth, route, ROUTER, writeCap, type Health, type Pack } from "../docs/pack.ts";
import { toolError } from "./errors.ts";
import { writeConfined, type Project } from "../project/index.ts";
import { withSourceWriterLock } from "../project/source-writer.ts";
import type { OperationResult } from "./index.ts";
import { staleWalkthroughs, type StaleWalkthrough } from "./walkthroughs.ts";

interface Staleness {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly views: readonly {
    readonly viewId: string;
    readonly source: string;
    readonly status: string;
    readonly changed: number;
  }[];
}

/** `.mmd` staleness for the pack's registered diagrams; reported, never a failure (covered code moves often). */
async function packStaleness(project: Project, pack: Pack): Promise<Staleness> {
  const inPack = new Set([...pack.listed, ...pack.details, ...pack.pictures].map((entry) => entry.file.path));
  const views = project.views.filter((view) => inPack.has(view.source));
  if (views.length === 0) return { status: "available", views: [] };
  const result = await listStaleDiagrams(project);
  const bySource = new Map(views.map((view) => [view.id, view.source]));
  return {
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    views: result.views
      .filter((view) => bySource.has(view.viewId))
      .map((view) => ({
        viewId: view.viewId,
        source: bySource.get(view.viewId)!,
        status: view.status,
        changed: view.changedPaths.length,
      })),
  };
}

const entrySummary = (pack: Pack) =>
  [...pack.listed, ...pack.details].map((entry) => ({
    path: entry.file.path,
    role: entry.role,
    question: entry.question,
    chars: entry.file.chars,
    cap: entry.cap,
    ...(entry.file.status === undefined ? {} : { status: entry.file.status }),
    ...(entry.file.description === undefined ? {} : { description: entry.file.description }),
    ...(entry.flowDiagrams?.length ? { diagrams: entry.flowDiagrams } : {}),
  }));

function healthText(health: Health, stale: Staleness, walkthroughs: readonly StaleWalkthrough[]): string {
  const lines = [
    `Pack health: ${health.status}${health.failures.length ? ` (${health.failures.length} failure(s))` : ""}. Pack ${health.budgets.pack.chars}/${health.budgets.pack.budget} characters; router ${health.router.status}.`,
  ];
  for (const failure of health.failures.slice(0, 20)) lines.push(`- fail: ${failure}`);
  if (health.failures.length > 20) lines.push(`- … ${health.failures.length - 20} more in the structured result`);
  for (const warning of health.warnings.slice(0, 10)) lines.push(`- warn: ${warning}`);
  if (stale.status === "unavailable") lines.push(`- diagram staleness unavailable (${stale.reason ?? "no Git"})`);
  for (const view of stale.views.filter((view) => view.status === "stale"))
    lines.push(
      `- stale: ${view.source} (${view.changed} covered file(s) changed since its last commit): reread the code, then fix it or update its checked line`,
    );
  // Reports, as a stale .mmd is: never a failure (ADR 0034 §8).
  for (const w of walkthroughs) {
    const said = [
      w.outOfDate.length > 0 ? `step ${w.outOfDate.join(", ")} out of date` : "",
      w.changed.length > 0 ? `step ${w.changed.join(", ")} reworded on the diagram` : "",
      ...w.deadCode.map((d) => `step ${d.step} cites ${d.ref}, which ${d.reason}`),
    ].filter((t) => t !== "");
    lines.push(
      `- walkthrough: ${w.viewId}/${w.id} is ${w.status.replace(/-/g, " ")} (${said.join("; ")}): offer to repair it with write_walkthrough, never unasked`,
    );
  }
  lines.push("- note staleness: unavailable (slice 2, from refs)");
  return lines.join("\n");
}

export async function runDocsIndex(
  project: Project,
  args: Readonly<Record<string, unknown>>,
): Promise<OperationResult> {
  let pack = buildPack(project);
  let written: boolean | undefined;
  if (args["write"] === true) {
    written = pack.files.get(ROUTER)?.text !== pack.router;
    if (written) {
      const text = pack.router;
      withSourceWriterLock(project, ROUTER, () => {
        writeConfined(project, ROUTER, text, "notes");
      });
      pack = buildPack(project);
    }
  }
  const structured: Record<string, unknown> = {
    schemaVersion: 1,
    mode: project.mode ?? null,
    router: { path: ROUTER, text: pack.router },
    entries: entrySummary(pack),
    unrouted: pack.unrouted,
    ...(written === undefined ? {} : { written }),
  };
  const parts: string[] = [];
  if (written !== undefined)
    parts.push(written ? `Wrote ${ROUTER}.` : `${ROUTER} is already current; nothing written.`);
  const question = typeof args["question"] === "string" ? args["question"].trim() : "";
  if (question !== "") {
    const matches = route(pack, question);
    structured["matches"] = matches;
    parts.push(
      matches.length === 0
        ? `No doc in the pack matches that question (${pack.listed.length + pack.details.length} routed files). Answer from the code, then offer one proposed use case and flow.`
        : `Read ${matches.length === 1 ? "this file" : `these ${matches.length} files`}, best first; check stale or dead refs before trusting one:\n${matches.map((m) => `- ${m.path}${m.diagrams ? ` (picture: ${m.diagrams.join(", ")})` : ""}: ${m.why}`).join("\n")}`,
    );
  }
  if (args["check"] === true) {
    const health = packHealth(pack);
    const stale = await packStaleness(project, pack);
    const walkthroughs = await staleWalkthroughs(project);
    structured["health"] = {
      ...health,
      staleness: stale,
      walkthroughs,
      noteStaleness: { status: "unavailable", reason: "note staleness from refs is slice 2" },
    };
    parts.push(healthText(health, stale, walkthroughs));
    // A pack not yet set up: the agent may not have the docs-mode rules loaded.
    if (health.required.length > 0)
      parts.push(
        "To set the pack up, read archer://docs/docs-mode (`archer docs docs-mode`) first: draft intent.md from the code, then ask the person one question at a time; then architecture.md, use-cases.md and two to five flows, each presented for the person to check.",
      );
  }
  if (question === "" && args["check"] !== true && written === undefined) parts.push(pack.router.trimEnd());
  else if (question === "" && args["check"] !== true)
    parts.push(
      `${pack.listed.length} file(s) listed, ${pack.details.length} detail file(s), ${pack.unrouted.length} unrouted.`,
    );
  return { text: parts.join("\n"), structured };
}

/** The cap a write would break: the file it lands in, its size after, its cap, and what to free. */
export interface CapBreach {
  readonly landing: string;
  readonly chars: number;
  readonly cap: number;
  readonly free: number;
}

/**
 * Hard rules 2 and 5: in a docs-mode project, a write that would take a pack file past its cap and
 * make it larger than it is. Null when it fits, shrinks the file, or the project is not in docs mode.
 */
export function capBreach(project: Project, path: string, before: string | undefined, after: string): CapBreach | null {
  if (project.mode !== "docs") return null;
  // The file it lands in, not the path it was named by: a directory link must not dodge a cap.
  let landing = path;
  try {
    const folder = realpathSync(project.folder);
    const target = join(realpathSync(dirname(join(project.folder, ...path.split("/")))), basename(path));
    if (target.startsWith(`${folder}${sep}`)) landing = relative(folder, target).split(sep).join("/");
  } catch {
    /* a path that does not resolve is refused by the writer itself */
  }
  const cap = writeCap(project, landing, after);
  if (cap === null) return null;
  const chars = [...after].length;
  const was = before === undefined ? 0 : [...before].length;
  if (chars <= cap || chars <= was) return null;
  return { landing, chars, cap, free: chars - cap };
}

/** The breach in the terms write_diagram refuses it in, and validate_diagram warns of it in. */
export const capOver = (b: CapBreach): string =>
  `${b.landing} would be ${b.chars} characters, over its ${b.cap} cap (docs mode).`;
export const capRemedy = (b: CapBreach): string =>
  `Free ${b.free} characters: shorten or merge entries, or split part of it into its own file with a one-line link, then write again. After two failed attempts to fit, stop and tell the person what is over and why.`;

/** A write past its pack file's cap is refused with how much to free (`doc_over_cap`). Nothing is truncated. */
export function refuseOverCap(
  project: Project,
  path: string,
  before: string | undefined,
  after: string,
  tool: string,
): void {
  const b = capBreach(project, path, before, after);
  if (b === null) return;
  throw toolError("doc_over_cap", `${capOver(b)} Nothing was written. ${capRemedy(b)}`, {
    tool,
    path,
    chars: b.chars,
    cap: b.cap,
    free: b.free,
  });
}
