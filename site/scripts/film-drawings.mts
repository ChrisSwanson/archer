/**
 * The landing film's drawings (`site/.vitepress/theme/landing-film.mts`): the shop example's Mermaid
 * (`site/diagrams/shop-*.mmd`), compiled by Archer and drawn by its own export painter, in theme tokens so one drawing
 * serves the light and the dark page. Each highlight the film shows is the painter's own emphasis, kept as the
 * attributes it puts on elements and its rules, scoped to the film's state, so the page lights parts by element id.
 *
 * Checked in as JSON (`FILM_DRAWINGS_PATH`); `npm run docs:film` redraws it, and a test keeps it fresh.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addressable, type Emphasis, parseEmphasis, rejection } from "../../shared/emphasis.mts";
import type { ExportPainterInput, ExportPainting } from "../../ts/src/export/contract.ts";
import { compile } from "../../ts/src/mermaid/index.ts";
import { revisionOf } from "../../ts/src/project/index.ts";
import {
  AGENT_HIGHLIGHT,
  FILM_HIGHLIGHTS,
  type FilmDrawing,
  type FilmHighlight,
  SEQUENCE_HIGHLIGHT,
  WALK_TITLE,
  WALKS,
  type WalkStep,
} from "../.vitepress/theme/landing-film.mts";

export const FILM_DRAWINGS_PATH = "site/.vitepress/theme/film-drawings.json";

export const FILM_SOURCES: Record<FilmDrawing, string> = {
  proposal: "site/diagrams/shop-proposal.mmd",
  revised: "site/diagrams/shop-revised.mmd",
  sequence: "site/diagrams/shop-sequence.mmd",
};

export interface FilmState {
  /** The painter's rules for this highlight, each scoped to `[data-film-state="<id>"]`. */
  readonly css: string;
  /** What the painter adds to each element it names, by `channel:id`. */
  readonly attributes: Record<string, Record<string, string>>;
  /** Group numbers, where the app draws them (an agent's highlight in a drawing with family colours). */
  readonly markers: string;
}

export interface FilmDrawingData {
  readonly title: string;
  readonly viewBox: string;
  readonly svg: string;
  /** The drawing's colour rows, as the export draws its Key; absent for a drawing without colour. */
  readonly key?: { readonly svg: string; readonly width: number; readonly height: number } | undefined;
  readonly states: Record<string, FilmState>;
}

type Painter = (input: ExportPainterInput) => Promise<ExportPainting>;
/** The painter is the UI's own module; loaded by address so the site's typecheck stays out of ui/src. */
async function painter(repoRoot: string): Promise<Painter> {
  const module = (await import(new URL("ui/src/export/painter.ts", `file://${repoRoot}/`).href)) as {
    paintExport: Painter;
  };
  return module.paintExport;
}

interface Group {
  id: string;
  style: "flow" | "highlight";
  palette: "teal";
  state: "existing";
  /** `flow` only. */
  speed?: "normal";
  label: string;
  description: string;
  nodes: string[];
  edges: string[];
}

/** A walk step's members: its boxes, and its lines with the boxes at their ends (`ui/src/walkthroughs/walk-render.ts`). */
function members(steps: readonly WalkStep[]): { nodes: string[]; edges: string[] } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const step of steps) {
    for (const node of step.nodes) nodes.add(node);
    for (const edge of step.edges) {
      edges.add(edge.id);
      nodes.add(edge.source);
      nodes.add(edge.target);
    }
  }
  return { nodes: [...nodes], edges: [...edges] };
}

/** The emphasis the page builds for a walkthrough step (`walkGroups`): the current step flowing, earlier ones walked. */
function walkEmphasis(walk: readonly WalkStep[], step: number): Group[] {
  const active = members(walk.slice(step - 1, step));
  const walked = members(walk.slice(0, step - 1));
  return [
    { id: "walk-active", style: "flow" as const, speed: "normal" as const, label: `Step ${step}`, ...active },
    { id: "walk-walked", style: "highlight" as const, label: "Walked", ...walked },
  ]
    .filter((group) => group.nodes.length + group.edges.length > 0)
    .map((group) => ({ ...group, palette: "teal" as const, state: "existing" as const, description: "" }));
}

/**
 * The agent's highlight as the agent sends it (`set_emphasis`) for the drawing's view: the film draws it only once
 * Archer's own parser accepts it.
 */
export function filmEmphasis(id: FilmHighlight, drawing: FilmDrawing): { viewId: string; payload: unknown } {
  const viewId = `shop-${drawing}`;
  if (id === "sequence-agent")
    return {
      viewId,
      payload: {
        id,
        title: SEQUENCE_HIGHLIGHT.title,
        groups: SEQUENCE_HIGHLIGHT.groups.map((group) => ({
          ...group,
          nodes: [...group.nodes],
          edges: [...group.edges],
        })),
      },
    };
  return {
    viewId,
    payload: {
      id,
      title: AGENT_HIGHLIGHT.title,
      groups: [
        {
          id: "agent",
          style: "highlight",
          label: AGENT_HIGHLIGHT.title,
          nodes: [...AGENT_HIGHLIGHT.nodes],
          edges: [...AGENT_HIGHLIGHT.edges],
        },
      ],
    },
  };
}

/** The element `<g>` the painter opens at `from`, through its matching close. */
function balancedGroup(markup: string, from: number): string {
  const tag = /<(\/?)g\b[^>]*?(\/?)>/g;
  tag.lastIndex = from;
  let depth = 0;
  for (let match = tag.exec(markup); match; match = tag.exec(markup)) {
    if (match[2]) continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return markup.slice(from, tag.lastIndex);
  }
  throw new Error("film-drawings: unbalanced group in the painter's output");
}

/** Rules as `selector, selector{body}`; every selector gains the state's scope. */
function scoped(css: string, state: string, recolour: (selector: string, body: string) => string): string {
  return css
    .split("}")
    .filter((rule) => rule.trim() !== "")
    .map((rule) => {
      const open = rule.indexOf("{");
      const selectors = rule.slice(0, open);
      const body = rule.slice(open + 1);
      return `${selectors
        .split(",")
        .map((selector) => `[data-film-state="${state}"] ${selector.trim()}`)
        .join(",")}{${recolour(selectors, body)}}`;
    })
    .join("");
}

/** Distinct marker ids per drawing: the page holds more than one at a time while one fades into the next. */
const ownIds = (markup: string, name: FilmDrawing) =>
  markup
    .replaceAll('id="export-edge-', `id="film-${name}-edge-`)
    .replaceAll("url(#export-edge-", `url(#film-${name}-edge-`);

export async function renderFilmDrawings(repoRoot: string): Promise<Record<FilmDrawing, FilmDrawingData>> {
  const paint = await painter(repoRoot);
  const result = {} as Record<FilmDrawing, FilmDrawingData>;
  for (const name of Object.keys(FILM_SOURCES) as FilmDrawing[]) {
    const source = await readFile(join(repoRoot, FILM_SOURCES[name]), "utf8");
    const compiled = await compile(source);
    if (!compiled.model || compiled.diagnostics.some((d) => d.severity === "error"))
      throw new Error(`film-drawings: ${FILM_SOURCES[name]} does not compile: ${JSON.stringify(compiled.diagnostics)}`);
    const title = name === "sequence" ? "Checkout Sequence" : "Payment Worker";
    const envelope = {
      schemaVersion: 2,
      revision: revisionOf(new TextEncoder().encode(source)),
      view: { id: `shop-${name}`, kind: compiled.model.type === "sequence-trace" ? "sequence" : "freeform", title },
      model: compiled.model,
    };
    const drawn = await paint({ envelope, mode: "diagram" });
    const svg = ownIds(
      `<g fill="var(--node-bg)" stroke="var(--node-border)" color="var(--node-text)">${drawn.content}</g>`,
      name,
    );
    // The Key's colour rows, as the export draws them beside a drawing.
    const keyed = await paint({ envelope, mode: "presentation", presentation: { diagramKey: true } });
    const keyAt = keyed.content.indexOf('<g data-export-palette-key="true"');
    let key: FilmDrawingData["key"];
    if (keyAt >= 0) {
      const group = balancedGroup(keyed.content, keyAt).replace(
        /^<g data-export-palette-key="true" transform="[^"]*">/,
        '<g data-export-palette-key="true">',
      );
      // The rows' extent, from the samples and the words the painter placed (13px words, 16px samples).
      const bottoms = [
        ...[...group.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map(
          (m) => Number(m[1]) + Number(m[2]) + 1,
        ),
        ...[...group.matchAll(/<tspan x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]) + 5),
      ];
      key = { svg: group, width: keyed.width - drawn.width - 32, height: Math.ceil(Math.max(...bottoms)) };
    }
    const states: Record<string, FilmState> = {};
    for (const id of Object.keys(FILM_HIGHLIGHTS) as FilmHighlight[]) {
      if (FILM_HIGHLIGHTS[id].drawing !== name) continue;
      const { step } = FILM_HIGHLIGHTS[id];
      const walk = step !== undefined;
      let emphasis: Emphasis | { id: string; viewId: string; title: string; groups: Group[] };
      if (walk) {
        if (compiled.model.type === "sequence-trace")
          throw new Error(`film-drawings: ${id}: a sequence cannot host a walkthrough`);
        emphasis = { id, viewId: envelope.view.id, title: WALK_TITLE, groups: walkEmphasis(WALKS.proposal, step) };
      } else {
        const { viewId, payload } = filmEmphasis(id, name);
        const parsed = parseEmphasis(payload, viewId, addressable(compiled.model));
        if (!parsed.ok) throw new Error(`film-drawings: ${id}: ${rejection(parsed.issues)}`);
        emphasis = parsed.emphasis;
      }
      const groups = emphasis.groups;
      const lit = await paint({
        envelope,
        mode: "presentation",
        presentation: { emphases: [emphasis], activeEmphasisId: id, diagramKey: false },
      });
      const content = ownIds(lit.content, name);
      const css = content.startsWith("<style>") ? content.slice(7, content.indexOf("</style>")) : "";
      const attributes: Record<string, Record<string, string>> = {};
      const classOf = new Map<string, string>();
      for (const match of content.matchAll(
        /data-element-id="([^"]+)" data-element-channel="(node|edge)"((?: (?:data-emphasis|data-emphasis-context|class)="[^"]*")+)/g,
      )) {
        const extra: Record<string, string> = {};
        for (const pair of match[3]!.matchAll(/ ([\w-]+)="([^"]*)"/g)) extra[pair[1]!] = pair[2]!;
        attributes[`${match[2]}:${match[1]}`] = extra;
        if (extra.class) classOf.set(`${match[2]}:${match[1]}`, extra.class);
      }
      // A walkthrough as the canvas draws it (`ui/src/emphasis/surface.tsx`, ADR 0034 §4), where the export does not:
      // the steps before the current one in the quieter walked tone (`.archer-emph--walked`, whatever the group's slot), and no group numbers (no legend says them).
      const walkedClasses = new Set<string>();
      if (walk && groups.length > 1) {
        const active = groups[0]!;
        const walked = groups[1]!;
        for (const node of walked.nodes)
          if (!active.nodes.includes(node)) walkedClasses.add(classOf.get(`node:${node}`) ?? "");
        for (const edge of walked.edges)
          if (!active.edges.includes(edge)) walkedClasses.add(classOf.get(`edge:${edge}`) ?? "");
        walkedClasses.delete("");
      }
      const recolour = (selectors: string, body: string) =>
        [...walkedClasses].some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(selectors))
          ? body.replace(/var\(--g\d\)/g, "var(--walked)")
          : body;
      const markers = walk
        ? ""
        : [...content.matchAll(/<g class="export-emph-marker"[^>]*>.*?<\/g>/g)].map((m) => m[0]).join("");
      states[id] = { css: scoped(css, id, recolour), attributes, markers };
    }
    result[name] = {
      title,
      viewBox: `${drawn.originX - 20} ${drawn.originY - 20} ${drawn.width + 40} ${drawn.height + 40}`,
      svg,
      key,
      states,
    };
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  renderFilmDrawings(repoRoot)
    .then((drawings) => writeFile(join(repoRoot, FILM_DRAWINGS_PATH), `${JSON.stringify(drawings, null, 2)}\n`))
    .then(() => console.info(`Film drawings written to ${FILM_DRAWINGS_PATH}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
