/**
 * The mermaid fences of a note, drawn in place (docs/proposals/notes-with-embedded-diagrams.md, slice B).
 *
 * The fence's `pre` stays in the note, hidden, and its figure is drawn in a
 * host element placed right after it. Two texts must agree with the
 * service's: the note's text that passage anchors are found in
 * (`renderedNoteText`) still holds every fence's code, and holds nothing of
 * the figures -- `noteText` and `textNodesOf` pass over every host.
 */
import { MAX_NOTE_DIAGRAMS } from "../../../shared/note-diagrams.mjs";
import type { EmbeddedDiagramContent } from "./contract";

export const FIGURE_HOST_ATTRIBUTE = "data-note-figure";

export type FigureDrawing = { readonly viewBox: string; readonly content: string };
export type FigureLoad =
  | { readonly status: "drawn"; readonly diagram: EmbeddedDiagramContent; readonly drawing: FigureDrawing }
  | { readonly status: "failing"; readonly diagram: EmbeddedDiagramContent }
  | { readonly status: "error"; readonly message: string };
/** A diagram by address, drawn; `revision` is its body's, so a changed fence is fetched again. */
export type FigureLoader = (address: string, revision: string) => Promise<FigureLoad>;

export type Painting = {
  readonly content: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
};

/** The margin the SVG export leaves around a drawing, kept so a figure reads like an export. */
const MARGIN = 20;

/**
 * A loader that fetches and paints each diagram once per address and
 * revision, with the same painter as SVG export. A refusal is not kept: the
 * next figure to ask tries again.
 */
export function figureLoader(
  fetchDiagram: (address: string) => Promise<EmbeddedDiagramContent>,
  paint: (envelope: unknown) => Promise<Painting>,
): FigureLoader {
  const held = new Map<string, Promise<FigureLoad>>();
  let drawn = 0;
  return (address, revision) => {
    const key = `${address}\0${revision}`;
    const known = held.get(key);
    if (known !== undefined) return known;
    const answer = (async (): Promise<FigureLoad> => {
      try {
        const diagram = await fetchDiagram(address);
        // The note named this revision; a diagram that has moved on is not
        // drawn under the note's old words and caption.
        if (diagram.sourceRevision !== revision) {
          held.delete(key);
          return {
            status: "error",
            message: "This diagram changed since the note was opened. Reopen the note to see it.",
          };
        }
        if (diagram.envelope === null) return { status: "failing", diagram };
        const p = await paint(diagram.envelope);
        return {
          status: "drawn",
          diagram,
          drawing: {
            viewBox: `${p.originX - MARGIN} ${p.originY - MARGIN} ${p.width + 2 * MARGIN} ${p.height + 2 * MARGIN}`,
            content: ownIds(p.content, `archer-figure-${++drawn}-`),
          },
        };
      } catch (error) {
        held.delete(key);
        return { status: "error", message: error instanceof Error ? error.message : "The diagram could not be drawn." };
      }
    })();
    held.set(key, answer);
    if (held.size > 256) held.delete(held.keys().next().value!);
    return answer;
  };
}

/**
 * `content` with every id it defines, and every reference to one, given
 * `prefix`: the painter numbers its markers from 0 in every drawing, and in
 * one page two figures would otherwise share -- and draw with -- one marker.
 */
export function ownIds(content: string, prefix: string): string {
  return content
    .replace(/\bid="([^"]*)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)"]*)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(
      /\b((?:xlink:)?href)="#([^"]*)"/g,
      (_m, attribute: string, id: string) => `${attribute}="#${prefix}${id}"`,
    );
}

/** The production painter, loaded when the first figure is drawn. */
export async function paintFigure(envelope: unknown): Promise<Painting> {
  const { paintExport } = await import("../export/painter");
  return paintExport({ envelope, mode: "diagram" });
}

const isMermaid = (code: Element): boolean =>
  [...code.classList].some((name) => name.toLowerCase() === "language-mermaid");

/**
 * Hides each mermaid fence of the rendered note in `root` and puts an empty
 * host after it, in order. When the count is not `expected` -- the page and
 * the service read the note differently -- nothing is changed and no host is
 * made: the fences stay code rather than be drawn as the wrong diagrams. The
 * one exception is a note past the service's cap: its first fences are
 * drawn, and the rest stay code.
 */
export function mountFigureHosts(root: HTMLElement, expected: number): HTMLElement[] {
  const fences = [...root.querySelectorAll("pre > code")].filter(isMermaid).map((code) => code.parentElement!);
  const capped = expected === MAX_NOTE_DIAGRAMS && fences.length > expected;
  if ((fences.length !== expected && !capped) || expected === 0) return [];
  return fences.slice(0, expected).map((pre) => {
    pre.hidden = true;
    const host = root.ownerDocument.createElement("div");
    host.setAttribute(FIGURE_HOST_ATTRIBUTE, "");
    host.className = "archer-note-figure-host";
    pre.after(host);
    return host;
  });
}

const inFigure = (node: Node): boolean => (node.parentElement?.closest(`[${FIGURE_HOST_ATTRIBUTE}]`) ?? null) !== null;

/** The text nodes of the note itself, in order, passing over every figure. */
export function textNodesOf(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (inFigure(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null)
    nodes.push(node);
  return nodes;
}

/** The note's text, as the service reads it: figures left out. */
export function noteText(root: HTMLElement): string {
  return textNodesOf(root)
    .map((node) => node.data)
    .join("");
}

/**
 * Where `range` is in the note's text (`noteText`), or null when it is no
 * passage: when it starts, ends or runs across a figure. A figure stands for
 * a fence whose code is hidden but still in the note's text, so a selection
 * across one would quote code the reader never saw.
 */
export function passageOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (inFigure(range.startContainer) || inFigure(range.endContainer)) return null;
  for (const host of root.querySelectorAll(`[${FIGURE_HOST_ATTRIBUTE}]`)) if (range.intersectsNode(host)) return null;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length - figureTextIn(root, before);
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

/** How much of `range`'s text lies in figures. */
export function figureTextIn(root: HTMLElement, range: Range): number {
  let count = 0;
  for (const host of root.querySelectorAll(`[${FIGURE_HOST_ATTRIBUTE}]`)) {
    if (range.intersectsNode(host)) count += host.textContent?.length ?? 0;
  }
  return count;
}

export const isInFigure = inFigure;
