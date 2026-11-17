// The doc pack (docs/proposals/doc-pack.md, ADR 0033): small capped files behind a generated
// router, `index.md`. This module finds the pack in the Archer folder, renders the router,
// routes a question to at most three files by plain keywords, and reports the pack's health.
// Everything here is deterministic in the folder's contents: no clock, no Git, no embeddings.
// Staleness, which does read Git, is added by the operation (ts/src/application/docs.ts).
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { readConfined } from "../project/confined-fs.ts";
import {
  listDiagrams,
  listNotes,
  MAX_NOTE_BYTES,
  readInFolderOrNull,
  splitFrontMatter,
  type Project,
} from "../project/index.ts";
import { inlineTargets, referenceTarget } from "../project/inventory.ts";
import { within } from "../project/project.ts";
import { projectDisplayName } from "../project/repository.ts";
import { embeddedDiagrams, walkthroughsPathFor } from "../notes/embedded.ts";
import { WalkthroughsStore } from "../walkthroughs/store.ts";

/** Per-file caps in characters, front matter and embedded diagram source included (Hard rules 2). */
export const CAPS = {
  index: 3_000,
  readme: 1_500,
  intent: 4_000,
  "use-cases": 6_000,
  architecture: 6_000,
  invariants: 3_000,
  glossary: 6_000,
  "threat-model": 6_000,
  lessons: 3_000,
  flow: 4_000,
  detail: 4_000,
  decision: 3_000,
} as const;
/** Budgets per read, in characters (Hard rules 3). */
export const BUDGETS = { firstRead: 3_000, answer: 15_000, onboarding: 16_000, pack: 80_000 } as const;
/** The router lists the core files and the flows, at most this many (Hard rules 4). */
export const MAX_ROUTER_ENTRIES = 12;
/** A question routes to at most this many files. */
export const MAX_MATCHES = 3;
export const ROUTER = "index.md";

export const CORE_TYPES = [
  "intent",
  "use-cases",
  "architecture",
  "invariants",
  "glossary",
  "threat-model",
  "lessons",
] as const;
export type CoreType = (typeof CORE_TYPES)[number];
const FLOW_TYPES = new Set(["user-flow", "data-flow"]);
/** The question each kind of file answers: the router's first column, and a routing field. */
export const QUESTIONS: Readonly<Record<CoreType | "flow" | "decision" | "detail", string>> = {
  intent: "Why does it exist, for whom? What must it not become?",
  "use-cases": "What is it for? Which picture shows X? Is X built?",
  architecture: "What are the parts? Where is the code?",
  invariants: "What must never happen?",
  glossary: "What does a word mean here?",
  "threat-model": "What is trusted? What can go wrong?",
  lessons: "What surprised us, and what rule did it leave?",
  flow: "How does a request or a piece of data move?",
  decision: "Why is it this way, as of a date?",
  detail: "More detail on one part.",
};
/** Out of the route whatever links to them (Hard rules 7). */
const OUT_OF_ROUTE = ["notes/scratch/", "notes/proposals/"];
const RETIRED = new Set(["implemented", "abandoned", "superseded"]);

export interface DocFile {
  /** Relative to the Archer folder. */
  readonly path: string;
  readonly kind: "note" | "diagram";
  readonly text: string;
  readonly chars: number;
  readonly type?: string;
  readonly status?: string;
  readonly description?: string;
  readonly title?: string;
  readonly checked?: string;
  readonly refs: readonly string[];
  readonly useCases: readonly string[];
  /** Folder-relative files this one links to (Markdown links and `diagrams:`), existing or not. */
  readonly links: readonly string[];
  /** The diagrams listNotes resolved for this note (`diagrams:` and `.mmd` links). */
  readonly diagrams: readonly string[];
  /** What listNotes could not follow: a missing or ambiguous diagram link. */
  readonly problems: readonly string[];
}

export type Role = "core" | "flow" | "detail";
export interface PackEntry {
  readonly file: DocFile;
  readonly role: Role;
  readonly question: string;
  readonly cap: number;
  /** For a core file, its type; for a flow note, the flow diagrams folded under it. */
  readonly coreType?: CoreType;
  readonly flowDiagrams?: readonly string[];
  /** For a flow: how many walkthroughs its diagrams have (ADR 0034 §8). Absent when none. */
  readonly walkthroughs?: number;
}

export interface Pack {
  readonly project: Project;
  readonly files: ReadonlyMap<string, DocFile>;
  readonly core: readonly PackEntry[];
  readonly flows: readonly PackEntry[];
  /** Core and flows the router lists (at most MAX_ROUTER_ENTRIES). */
  readonly listed: readonly PackEntry[];
  /** Core and flows past the router's limit. */
  readonly overflow: readonly PackEntry[];
  readonly details: readonly PackEntry[];
  /** Flow diagrams folded under their flow notes: in the pack, not listed apart. */
  readonly pictures: readonly PackEntry[];
  readonly unrouted: readonly string[];
  /** Files in the folder too large (or unable) to be read: never silently left out. */
  readonly unread: readonly string[];
  readonly router: string;
}

const chars = (text: string): number => [...text].length;

function readText(project: Project, path: string): string | null {
  // The confined seam (G6): no link followed, one name, read from the descriptor.
  return readInFolderOrNull(project, path, MAX_NOTE_BYTES)?.toString("utf8") ?? null;
}

/** Front-matter fields the pack reads beyond the inventory's own (`refs`, `checked`, `use-cases`). */
export function packFields(text: string): { checked?: string; refs: string[]; useCases: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { refs: [], useCases: [] };
  const close = lines.findIndex((line, i) => i > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."));
  if (close < 0) return { refs: [], useCases: [] };
  // Only these keys, compared exactly: a key like `constructor` names nothing here.
  const refs: string[] = [],
    useCases: string[] = [];
  const listOf = (key: string | null): string[] | null =>
    key === "refs" ? refs : key === "use-cases" ? useCases : null;
  let checked: string | undefined;
  let current: string | null = null;
  for (const line of lines.slice(1, close)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line.trimEnd());
    if (pair?.[1] !== undefined) {
      current = pair[1];
      const value = (pair[2] ?? "").trim();
      const list = listOf(current);
      if (current === "checked") checked = value || undefined;
      else if (list !== null && value !== "") {
        const inner = value.startsWith("[") ? value.replace(/^\[/, "").replace(/\]$/, "") : value;
        for (const item of inner.split(",")) {
          const entry = unquote(item);
          if (entry !== "") list.push(entry);
        }
      }
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    const list = listOf(current);
    if (item?.[1] !== undefined && list !== null) list.push(unquote(item[1]));
  }
  return { ...(checked === undefined ? {} : { checked }), refs, useCases };
}

const unquote = (raw: string): string => raw.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");

/** Markdown inline-link targets outside code fences, resolved against `from`'s folder; not URLs. */
export function linkTargets(from: string, body: string): string[] {
  const targets: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // The inventory's linear scanners: inline links and reference definitions.
    for (const raw of [...inlineTargets(line), ...referenceTarget(line)]) {
      let target = raw;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("#")) continue;
      target = target.split("#")[0]!.split("?")[0]!;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* kept as written */
      }
      if (target === "") continue;
      targets.push(target.startsWith("/") ? target : posix.normalize(posix.join(posix.dirname(from), target)));
    }
  }
  return [...new Set(targets)];
}

function titleOf(body: string): string | undefined {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return heading?.[1];
}

/** Every Markdown note and `.mmd` diagram in the Archer folder, read for the pack; `unread` collects what could not be. */
export function readFiles(project: Project, unread: string[] = []): Map<string, DocFile> {
  const files = new Map<string, DocFile>();
  const views = new Map(project.views.map((view) => [view.source, view]));
  for (const note of listNotes(project)) {
    const text = readText(project, note.path);
    if (text === null) {
      unread.push(note.path);
      continue;
    }
    const { fields, body } = splitFrontMatter(text);
    const extra = packFields(text);
    const title = titleOf(body);
    files.set(note.path, {
      path: note.path,
      kind: "note",
      text,
      chars: chars(text),
      ...(fields.type === undefined ? {} : { type: fields.type }),
      ...(fields.status === undefined ? {} : { status: fields.status }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(title === undefined ? {} : { title }),
      ...(extra.checked === undefined ? {} : { checked: extra.checked }),
      refs: extra.refs,
      useCases: extra.useCases,
      links: [...new Set([...linkTargets(note.path, body), ...note.diagrams])],
      diagrams: note.diagrams,
      problems: note.problems,
    });
  }
  for (const diagram of listDiagrams(project)) {
    const text = readText(project, diagram.path);
    if (text === null) {
      unread.push(diagram.path);
      continue;
    }
    const description = /^\s*%%\s*description:\s*(.+?)\s*$/m.exec(text)?.[1];
    const title = views.get(diagram.path)?.title;
    files.set(diagram.path, {
      path: diagram.path,
      kind: "diagram",
      text,
      chars: chars(text),
      ...(description === undefined ? {} : { description }),
      ...(title === undefined ? {} : { title }),
      refs: [],
      useCases: [],
      links: [],
      diagrams: [],
      problems: [],
    });
  }
  return files;
}

const outOfRoute = (file: DocFile): boolean =>
  OUT_OF_ROUTE.some((prefix) => file.path.startsWith(prefix)) || RETIRED.has(file.status ?? "");
const isRoot = (path: string): boolean => !path.includes("/");
const isFlowDiagram = (file: DocFile): boolean => file.kind === "diagram" && file.path.startsWith("diagrams/flows/");
const isFlowNote = (file: DocFile): boolean =>
  file.kind === "note" &&
  (FLOW_TYPES.has(file.type ?? "") || (file.type === undefined && file.path.startsWith("notes/flows/")));

/** The cap of a file in the pack, by its place and its type. */
export function capFor(file: Pick<DocFile, "path" | "kind" | "type">, role: Role = "detail"): number {
  if (file.path === ROUTER) return CAPS.index;
  if (file.path === "README.md") return CAPS.readme;
  if (file.kind === "diagram") return CAPS.flow;
  const type = typeOfNote(file);
  if (type === "architecture") return role === "core" && isRoot(file.path) ? CAPS.architecture : CAPS.detail;
  if (type !== undefined && (CORE_TYPES as readonly string[]).includes(type)) return CAPS[type as CoreType];
  if (FLOW_TYPES.has(file.type ?? "") || file.path.startsWith("notes/flows/")) return CAPS.flow;
  if (file.type === "decision" || file.path.startsWith("notes/decisions/")) return CAPS.decision;
  return CAPS.detail;
}

/** A note's pack type: its `type`, or for a root file without one, its name (`intent.md`). */
function typeOfNote(file: Pick<DocFile, "path" | "type">): string | undefined {
  if (file.type !== undefined) return file.type;
  const stem = file.path.replace(/\.md$/, "");
  return isRoot(file.path) && (CORE_TYPES as readonly string[]).includes(stem) ? stem : undefined;
}

/** The cap a write to `path` is held to in a docs-mode project, or null when the file is no pack file. */
export function writeCap(project: Project, path: string, text: string): number | null {
  const kind = path.endsWith(".mmd") ? "diagram" : "note";
  const fields = kind === "note" ? splitFrontMatter(text).fields : {};
  const type = fields.type;
  const probe = { path, kind, ...(type === undefined ? {} : { type }) } as const;
  if (OUT_OF_ROUTE.some((prefix) => path.startsWith(prefix)) || RETIRED.has(fields.status ?? "")) return null;
  const pack = buildPack(project);
  const entry = [...pack.listed, ...pack.overflow, ...pack.details, ...pack.pictures].find((e) => e.file.path === path);
  if (entry !== undefined) return entry.cap;
  if (path === ROUTER || path === "README.md") return capFor(probe);
  // A file that would join the pack by its place or type.
  if (kind === "diagram") return path.startsWith("diagrams/flows/") ? CAPS.flow : null;
  const noteType = typeOfNote(probe);
  if (noteType !== undefined && ((CORE_TYPES as readonly string[]).includes(noteType) || FLOW_TYPES.has(noteType)))
    return capFor(probe, isRoot(path) ? "core" : "detail");
  return null;
}

/** The pack as the folder holds it now, with the router rendered from it. */
export function buildPack(project: Project): Pack {
  const unread: string[] = [];
  const files = readFiles(project, unread);
  const candidates = [...files.values()].filter(
    (file) => !outOfRoute(file) && file.path !== ROUTER && file.path !== "README.md",
  );
  const core: PackEntry[] = [];
  for (const type of CORE_TYPES) {
    const ofType = candidates.filter((file) => file.kind === "note" && typeOfNote(file) === type);
    // One core file per type: the root `<type>.md`, else the shallowest, then the first by path.
    const chosen =
      ofType.find((file) => file.path === `${type}.md`) ??
      [...ofType].sort(
        (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
      )[0];
    if (chosen !== undefined)
      core.push({ file: chosen, role: "core", coreType: type, question: QUESTIONS[type], cap: capFor(chosen, "core") });
  }
  const coreSet = new Set(core.map((entry) => entry.file.path));
  const flowNotes = candidates.filter((file) => isFlowNote(file) && !coreSet.has(file.path)).sort(byPath);
  const folded = new Set(
    flowNotes.flatMap((note) =>
      note.diagrams.filter((path) => files.get(path) !== undefined && isFlowDiagram(files.get(path)!)),
    ),
  );
  const flowDiagrams = candidates.filter((file) => isFlowDiagram(file) && !folded.has(file.path)).sort(byPath);
  const counted = (entry: PackEntry, sidecars: readonly string[]): PackEntry => {
    const walkthroughs = walkthroughCount(project, sidecars);
    return walkthroughs === 0 ? entry : { ...entry, walkthroughs };
  };
  const flows: PackEntry[] = [
    ...flowNotes.map((file) => {
      const diagrams = file.diagrams.filter((path) => folded.has(path));
      const embedded = embeddedDiagrams(project, file.path).diagrams.map((d) => walkthroughsPathFor(file.path, d.name));
      return counted(
        { file, role: "flow" as const, question: QUESTIONS.flow, cap: capFor(file, "flow"), flowDiagrams: diagrams },
        [...diagrams.map((path) => walkthroughsPathFor(path)), ...embedded],
      );
    }),
    ...flowDiagrams.map((file) =>
      counted({ file, role: "flow" as const, question: QUESTIONS.flow, cap: capFor(file, "flow") }, [
        walkthroughsPathFor(file.path),
      ]),
    ),
  ].sort((a, b) => byPath(a.file, b.file));
  const all = [...core, ...flows];
  const listed = all.slice(0, MAX_ROUTER_ENTRIES);
  const overflow = all.slice(MAX_ROUTER_ENTRIES);
  // Detail: what a listed file links to, one hop, inside the folder and in the route.
  const routed = new Set([...listed.map((entry) => entry.file.path), ...folded]);
  const detailPaths = new Set<string>();
  for (const entry of listed) {
    for (const link of entry.file.links) {
      const target = files.get(link);
      if (target === undefined || routed.has(link) || outOfRoute(target) || link === ROUTER || link === "README.md")
        continue;
      detailPaths.add(link);
    }
  }
  const details = [...detailPaths].sort().map((path) => {
    const file = files.get(path)!;
    const role: Role = "detail";
    const question =
      file.type === "decision" || path.startsWith("notes/decisions/")
        ? QUESTIONS.decision
        : file.kind === "diagram" && isFlowDiagram(file)
          ? QUESTIONS.flow
          : QUESTIONS.detail;
    return { file, role, question, cap: capFor(file, role) };
  });
  const listedFolded = new Set(listed.flatMap((entry) => entry.flowDiagrams ?? []));
  const pictures = [...listedFolded]
    .sort()
    .map((path) => ({ file: files.get(path)!, role: "flow" as const, question: QUESTIONS.flow, cap: CAPS.flow }));
  const inPack = new Set([...listed, ...details, ...pictures].map((entry) => entry.file.path));
  const unrouted = [...files.keys()]
    .filter((path) => !inPack.has(path) && path !== ROUTER && path !== "README.md")
    .sort();
  const partial = {
    project,
    files,
    core,
    flows,
    listed,
    overflow,
    details,
    pictures,
    unrouted,
    unread: unread.filter((path) => !OUT_OF_ROUTE.some((prefix) => path.startsWith(prefix))).sort(),
  };
  return { ...partial, router: renderRouter(partial) };
}

/** The walkthroughs in these sidecar files, read from the folder without resolving them; an unreadable file counts none. */
function walkthroughCount(project: Project, sidecars: readonly string[]): number {
  const store = new WalkthroughsStore(project);
  return sidecars.reduce((sum, path) => {
    const read = store.peek({ viewId: "", path });
    return sum + (read.kind === "ok" ? read.file.walkthroughs.length : 0);
  }, 0);
}

const byPath = (a: DocFile, b: DocFile): number => a.path.localeCompare(b.path);

const kilo = (n: number): string => `${(n / 1000).toFixed(1)}k`;
const capText = (n: number): string => `${Number.isInteger(n / 1000) ? n / 1000 : (n / 1000).toFixed(1)}k`;
/** One line of table text from untrusted note text: no newlines, no cell breaks. */
const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const link = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

function stateOf(file: DocFile): string {
  const commit = /^([0-9a-f]{7,64})\b/.exec(file.checked ?? "")?.[1];
  return [file.status, commit === undefined ? undefined : commit.slice(0, 7)].filter(Boolean).join(" ") || "—";
}

/** The routed pack's size: the router, the files it lists and their detail notes. */
export function packChars(pack: Pick<Pack, "listed" | "details" | "pictures">, routerChars: number): number {
  return (
    routerChars + [...pack.listed, ...pack.details, ...pack.pictures].reduce((sum, entry) => sum + entry.file.chars, 0)
  );
}

function renderRouter(pack: Omit<Pack, "router">): string {
  const name = projectDisplayName(pack.project);
  const render = (total: number): string => {
    const lines = [
      "---",
      "author: agent",
      "description: Read this first. Which doc answers which question, and how big each is.",
      "type: index",
      "---",
      `# ${cell(name)} docs: start here`,
      "",
      "> Generated by `archer docs index --write` (the `docs_index` tool); never edit it by hand. Read only the file your question needs. Rules for keeping these docs: `archer docs docs-mode`.",
      "",
    ];
    const core = pack.listed.filter((entry) => entry.role === "core");
    const flows = pack.listed.filter((entry) => entry.role === "flow");
    if (core.length === 0 && flows.length === 0)
      lines.push("No docs yet. Ask your agent to set up the architecture docs.", "");
    if (core.length > 0) {
      lines.push("| Question | Read | Size | State |", "|---|---|---|---|");
      for (const entry of core)
        lines.push(
          `| ${entry.question} | [${cell(entry.file.path)}](${link(entry.file.path)}) | ${kilo(entry.file.chars)}/${capText(entry.cap)} | ${cell(stateOf(entry.file))} |`,
        );
      lines.push("");
    }
    if (flows.length > 0) {
      lines.push("## Flows", "");
      for (const entry of flows) {
        const title = cell(entry.file.title ?? posix.basename(entry.file.path).replace(/\.(md|mmd)$/, ""));
        const pictures = (entry.flowDiagrams ?? []).map((path) => ` ([picture](${link(path)}))`).join("");
        const about = entry.file.description === undefined ? "" : `: ${cell(entry.file.description)}`;
        const walks =
          entry.walkthroughs === undefined
            ? ""
            : ` · ${entry.walkthroughs} walkthrough${entry.walkthroughs === 1 ? "" : "s"}`;
        lines.push(
          `- [${title}](${link(entry.file.path)})${pictures}${about} ${kilo(entry.file.chars)}/${capText(entry.cap)}, ${cell(stateOf(entry.file))}${walks}`,
        );
      }
      lines.push("");
    }
    const folders = new Map<string, { notes: number; diagrams: number }>();
    for (const entry of pack.details) {
      const folder = `${posix.dirname(entry.file.path)}/`;
      const count = folders.get(folder) ?? { notes: 0, diagrams: 0 };
      if (entry.file.kind === "note") count.notes++;
      else count.diagrams++;
      folders.set(folder, count);
    }
    if (folders.size > 0) {
      lines.push("## Detail", "");
      for (const [folder, count] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
        const parts = [
          count.notes ? `${count.notes} note${count.notes === 1 ? "" : "s"}` : "",
          count.diagrams ? `${count.diagrams} diagram${count.diagrams === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        lines.push(
          `- \`${cell(folder)}\`: ${parts.join(", ")}, linked from the files above; find one with \`docs_index\``,
        );
      }
      lines.push("");
    }
    lines.push(`Pack ${kilo(total)}/${capText(BUDGETS.pack)} characters. Health: \`archer docs index --check\`.`, "");
    return lines.join("\n");
  };
  // The total counts the router itself: settle it (a digit more or less changes its length).
  let text = render(packChars(pack, 0));
  for (let i = 0; i < 3; i++) {
    const next = render(packChars(pack, chars(text)));
    if (next === text) break;
    text = next;
  }
  return text;
}

// ---- routing ----------------------------------------------------------------

const STOP = new Set([
  "the",
  "and",
  "for",
  "how",
  "does",
  "what",
  "why",
  "who",
  "when",
  "where",
  "which",
  "this",
  "that",
  "with",
  "from",
  "into",
  "are",
  "is",
  "was",
  "can",
  "you",
  "our",
  "its",
  "about",
  "work",
  "works",
  "show",
  "tell",
  "explain",
  "archer",
  "there",
  "here",
  "have",
  "has",
  "should",
  "would",
  "will",
  "get",
  "use",
  "used",
  "doc",
  "docs",
]);

/** Lower-case keywords of a text, lightly stemmed, without stop words. */
export function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP.has(word))
        .map(stem),
    ),
  ];
}
function stem(word: string): string {
  for (const suffix of ["ing", "ies", "es", "ed", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix))
      return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
  }
  return word;
}

export interface Match {
  readonly path: string;
  readonly role: Role;
  readonly score: number;
  readonly why: string;
  /** The flow diagram a flow note folds, to present. */
  readonly diagrams?: readonly string[];
}

/** Use-case names: the first cell of each table row in a use-cases file. */
function caseNames(body: string): string[] {
  return body.split(/\r?\n/).flatMap((line) => {
    const cellText = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1];
    return cellText === undefined || /^-+$/.test(cellText) || cellText === "Case" ? [] : [cellText];
  });
}

/** At most three files for a question, each with why it matched; plain keywords over a few fields. */
export function route(pack: Pack, question: string): Match[] {
  const terms = keywords(question);
  if (terms.length === 0) return [];
  const entries = [...pack.listed, ...pack.details];
  const scored = entries.map((entry, order) => {
    const { file } = entry;
    const body = file.kind === "note" ? splitFrontMatter(file.text).body : "";
    const headings = body
      .split(/\r?\n/)
      .filter((line) => /^#{2,3}\s/.test(line))
      .map((line) => line.replace(/^#+\s*/, ""));
    const fields: [string, number, string][] = [
      ["description", 3, file.description ?? ""],
      ["title", 3, file.title ?? ""],
      ["file name", 2, file.path.replace(/[/._-]/g, " ")],
      ["headings", 2, headings.join(" ")],
      ["use cases", 2, [...file.useCases, ...(entry.coreType === "use-cases" ? caseNames(body) : [])].join(" ")],
      ["question", 1, entry.question],
    ];
    const words = fields.map(([, , text]) => new Set(keywords(text)));
    let score = 0;
    const reasons = new Map<string, string[]>();
    for (const term of terms) {
      const best = fields.find((_, i) => words[i]!.has(term));
      if (best === undefined) continue;
      score += best[1];
      reasons.set(best[0], [...(reasons.get(best[0]) ?? []), term]);
    }
    const why = [...reasons].map(([field, words]) => `${words.join(", ")} in its ${field}`).join("; ");
    return { entry, order, score, why };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_MATCHES)
    .map(({ entry, score, why }) => ({
      path: entry.file.path,
      role: entry.role,
      score,
      why,
      ...(entry.flowDiagrams?.length ? { diagrams: entry.flowDiagrams } : {}),
    }));
}

// ---- health -------------------------------------------------------------------

export interface DeadRef {
  readonly file: string;
  readonly ref: string;
  readonly reason: string;
}

/** Backticked code references in a body, outside fences: `a/b.ts`, `a/`, `a/b.ts#name` (and `path:line@commit`). */
export function bodyRefs(body: string): string[] {
  const refs: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/`([^`\s]+)`/g)) {
      const token = match[1] ?? "";
      if (/^[\w.@-]+(?:\/[\w.@-]*)+(?:#[\w$.-]+)?(?::\d+(?:@[0-9a-f]{7,64})?)?$/.test(token)) refs.push(token);
    }
  }
  return [...new Set(refs)];
}

const MAX_SYMBOL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOL_CHARS = 256;
const SYMBOL = /^[\w$.-]{1,256}$/;

/** The identifiers (`[\w$]+` runs) of a file, in one linear pass. */
export function identifiers(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/[\w$]+/g)) found.add(match[0]);
  return found;
}

/** Each file's identifiers, read once per health run. */
export type IdentifierCache = Map<string, Set<string>>;

/** Why a repository-root-relative code reference does not resolve, or null when it does. */
export function refProblem(root: string, ref: string, cache: IdentifierCache = new Map()): string | null {
  const [location = "", symbol, ...rest] = ref.replace(/:\d+(?:@[0-9a-f]+)?$/, "").split("#");
  // A symbol is untrusted note text: it is matched literally, and only in this grammar.
  if (
    rest.length > 0 ||
    (symbol !== undefined &&
      (!SYMBOL.test(symbol) || symbol.split(".").some((part) => part === "" || part.length > MAX_SYMBOL_CHARS)))
  )
    return "is not a valid code reference (a symbol is letters, digits, _, $, . and -)";
  const parts = location.split("/").filter(Boolean);
  if (location.startsWith("/") || parts.includes("..") || parts.includes(".") || parts.length === 0)
    return "not a path inside the repository";
  const path = join(root, ...parts);
  if (!existsSync(path)) return "does not exist";
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "cannot be resolved";
  }
  if (!within(realpathSync(root), real)) return "leads outside the repository";
  const stats = statSync(real);
  if (location.endsWith("/") && !stats.isDirectory()) return "is not a directory";
  if (symbol !== undefined) {
    if (!stats.isFile()) return "names a symbol in something that is not a file";
    // The resolved file's size: a link's own size says nothing about what it leads to.
    if (stats.size > MAX_SYMBOL_FILE_BYTES) return "is too large to look for the symbol in";
    let words = cache.get(real);
    if (words === undefined) {
      // The confined seam (G6): the file is read from its descriptor under the repository root, reached by no link, with one name.
      const realRoot = realpathSync(root);
      let text: string;
      try {
        text = readConfined(realRoot, relative(realRoot, real).split(sep), {
          shown: location,
          limit: MAX_SYMBOL_FILE_BYTES,
        }).toString("utf8");
      } catch {
        return "cannot be read as a plain file inside the repository";
      }
      words = identifiers(text);
      cache.set(real, words);
    }
    // Each part must be an identifier in the file; a qualified name is not checked as a path.
    if (symbol.split(".").some((part) => !words.has(part))) return `has no ${symbol}`;
  }
  return null;
}

/** Whether a body reference is meant as one into the repository: its first segment exists at the root. */
function isCodeRef(root: string, ref: string): boolean {
  const first = ref.split("/")[0] ?? "";
  return first !== "" && existsSync(join(root, first));
}

/** Whether `ref` is covered by one of `refs`: the same path, an ancestor directory, or the file of a symbol. */
function covered(ref: string, refs: readonly string[]): boolean {
  const path = ref.replace(/:\d+(?:@[0-9a-f]+)?$/, "").split("#")[0] ?? "";
  return refs.some((entry) => {
    const base = entry.split("#")[0] ?? "";
    return entry === ref || base === path || (base.endsWith("/") && path.startsWith(base));
  });
}

export interface CapResult {
  readonly path: string;
  readonly chars: number;
  readonly cap: number;
  readonly over: boolean;
  readonly near: boolean;
}
export interface BudgetResult {
  readonly chars: number;
  readonly budget: number;
  readonly over: boolean;
}

export interface Health {
  readonly status: "pass" | "fail";
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly caps: readonly CapResult[];
  readonly budgets: Readonly<Record<keyof typeof BUDGETS, BudgetResult>>;
  readonly deadRefs: readonly DeadRef[];
  readonly uncoveredRefs: readonly DeadRef[];
  readonly router: { readonly status: "fresh" | "stale" | "missing" };
  readonly required: readonly string[];
}

/** The pack's health from its files alone (caps, budgets, references, router, required files). */
export function packHealth(pack: Pack): Health {
  const failures: string[] = [];
  const warnings: string[] = [];
  const docs = pack.project.mode === "docs";
  const onDisk = pack.files.get(ROUTER)?.text;
  const router = {
    status:
      onDisk === undefined ? ("missing" as const) : onDisk === pack.router ? ("fresh" as const) : ("stale" as const),
  };
  if (router.status === "stale")
    failures.push(`${ROUTER} is out of date: run \`archer docs index --write\` (docs_index with write).`);
  if (router.status === "missing" && docs)
    failures.push(`${ROUTER} is missing: run \`archer docs index --write\` (docs_index with write).`);

  const routerChars = chars(pack.router);
  const capped = [
    { path: ROUTER, chars: routerChars, cap: CAPS.index },
    ...(pack.files.has("README.md")
      ? [{ path: "README.md", chars: pack.files.get("README.md")!.chars, cap: CAPS.readme }]
      : []),
    ...[...pack.listed, ...pack.details, ...pack.pictures].map((entry) => ({
      path: entry.file.path,
      chars: entry.file.chars,
      cap: entry.cap,
    })),
  ];
  const caps = capped.map((item) => ({ ...item, over: item.chars > item.cap, near: item.chars > item.cap * 0.8 }));
  for (const item of caps) {
    if (item.over)
      failures.push(
        `${item.path} is ${item.chars} characters, over its ${item.cap} cap by ${item.chars - item.cap}: consolidate or split it.`,
      );
    else if (item.near)
      warnings.push(
        `${item.path} is over 80% of its cap (${item.chars}/${item.cap}): consolidate at the end of the task.`,
      );
  }

  const size = (path: string | undefined): number => (path === undefined ? 0 : (pack.files.get(path)?.chars ?? 0));
  const coreOf = (type: CoreType) => pack.core.find((entry) => entry.coreType === type)?.file.path;
  const largestFlow = Math.max(
    0,
    ...pack.flows.map(
      (entry) => entry.file.chars + (entry.flowDiagrams ?? []).reduce((sum, path) => sum + size(path), 0),
    ),
  );
  const budget = (value: number, limit: number): BudgetResult => ({ chars: value, budget: limit, over: value > limit });
  const budgets = {
    firstRead: budget(routerChars, BUDGETS.firstRead),
    answer: budget(routerChars + size(coreOf("use-cases")) + largestFlow, BUDGETS.answer),
    onboarding: budget(
      routerChars + size(coreOf("intent")) + size(coreOf("architecture")) + size(coreOf("invariants")),
      BUDGETS.onboarding,
    ),
    pack: budget(packChars(pack, routerChars), BUDGETS.pack),
  };
  const names = {
    firstRead: "first read (the router)",
    answer: "answer (router, use cases, the largest flow)",
    onboarding: "onboarding (router, intent, architecture, invariants)",
    pack: "routed pack",
  };
  for (const [key, value] of Object.entries(budgets) as [keyof typeof BUDGETS, BudgetResult][])
    if (value.over)
      failures.push(
        `The ${names[key]} is ${value.chars} characters, over its ${value.budget} budget.${key === "pack" ? " Ask the person whether to split the pack by context, one index.md per area." : ""}`,
      );

  for (const path of pack.unread)
    failures.push(
      `${path} is over ${MAX_NOTE_BYTES} bytes or unreadable, so the pack cannot check it: shrink or split it.`,
    );
  if (pack.flows.length > 5)
    warnings.push(
      `The pack has ${pack.flows.length} flows; docs mode asks for two to five: consolidate where two show one path.`,
    );
  if (pack.overflow.length > 0)
    failures.push(
      `The router lists at most ${MAX_ROUTER_ENTRIES} core files and flows; ${pack.overflow.length} more are missing from it (${pack.overflow.map((entry) => entry.file.path).join(", ")}): consolidate flows or split the pack by context.`,
    );

  const deadRefs: DeadRef[] = [];
  const uncoveredRefs: DeadRef[] = [];
  const root = pack.project.root;
  const cache: IdentifierCache = new Map();
  const checkedFiles = [...pack.listed, ...pack.details]
    .map((entry) => entry.file)
    .concat(pack.files.has("README.md") ? [pack.files.get("README.md")!] : []);
  for (const file of checkedFiles) {
    for (const ref of file.refs) {
      const problem = refProblem(root, ref, cache);
      if (problem !== null) deadRefs.push({ file: file.path, ref, reason: `refs entry ${problem}` });
    }
    if (file.kind !== "note") continue;
    const body = splitFrontMatter(file.text).body;
    for (const ref of bodyRefs(body)) {
      if (!isCodeRef(root, ref)) continue;
      const problem = refProblem(root, ref, cache);
      if (problem !== null) deadRefs.push({ file: file.path, ref, reason: problem });
      else if (file.refs.length > 0 && !covered(ref, file.refs))
        uncoveredRefs.push({ file: file.path, ref, reason: "cited in the body but not covered by refs" });
    }
    for (const link of file.links) {
      if (link.startsWith("/") || link === ".." || link.startsWith("../")) continue;
      if (!pack.files.has(link) && !existsSync(join(pack.project.folder, ...link.split("/"))))
        deadRefs.push({
          file: file.path,
          ref: link,
          reason: "link to a file that does not exist in the Archer folder",
        });
    }
    for (const problem of file.problems) deadRefs.push({ file: file.path, ref: "diagram link", reason: problem });
  }
  for (const dead of deadRefs) failures.push(`${dead.file}: \`${dead.ref}\` ${dead.reason}.`);
  for (const loose of uncoveredRefs)
    warnings.push(`${loose.file}: \`${loose.ref}\` is ${loose.reason}; upkeep matches on refs.`);

  const required: string[] = [];
  if (docs) {
    if (!pack.files.has("README.md")) required.push("README.md");
    for (const type of ["intent", "use-cases", "architecture"] as const)
      if (coreOf(type) === undefined) required.push(`${type}.md`);
    if (pack.flows.length < 2) required.push(`two to five flows (${pack.flows.length} found)`);
    for (const item of required) failures.push(`Docs mode requires ${item}.`);
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    warnings,
    caps,
    budgets,
    deadRefs,
    uncoveredRefs,
    router,
    required,
  };
}
