import { parseDiagramAddress } from "../../../shared/note-diagrams.mjs";
import { diagramTypeLabel } from "../app/file-index";
import { kindLabel, type DiagramView } from "../app/inventory";

export type TypePiece = { readonly model: { readonly type: string; readonly level?: unknown } } | null;

export type SourceMetadata = { readonly type: string; readonly description?: string; readonly cue?: string };

/** Inventory lookup by canonical source ID, including embedded blocks and sources with no addable piece. */
export function sourceMetadata(source: string, views: readonly DiagramView[], piece: TypePiece = null): SourceMetadata {
  const view = views.find((v) => v.id === source);
  if (view === undefined) return { type: "Diagram" };
  const duplicate = views.some((v) => v.id !== source && v.title === view.title);
  const at = parseDiagramAddress(source);
  const note = view.note ?? at?.notePath;
  const name = view.name ?? at?.name;
  const cue = note === undefined ? (view.sourcePath ?? source) : `${note} · ${name ?? source}`;
  return {
    type:
      view.kind === "c4"
        ? piece?.model.type === "c4-model" && ["context", "container", "component"].includes(String(piece.model.level))
          ? diagramTypeLabel(`c4-${String(piece.model.level)}`)
          : "Diagram"
        : view.kind === "freeform" || kindLabel(view.kind) !== undefined
          ? diagramTypeLabel(view.kind)
          : "Diagram",
    ...(view.description ? { description: view.description } : {}),
    ...(duplicate ? { cue } : {}),
  };
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** A short plain-text description at a Unicode word boundary; a single long word stays whole. */
export function descriptionExcerpt(description: string, max = 100): string {
  const text = description.trim().replace(/\s+/gu, " ");
  if (Array.from(text).length <= max) return text;
  let head = "";
  for (const { segment } of words.segment(text)) {
    if (Array.from(head + segment).length > max) {
      // No useful boundary before the first word: keep it intact, even beyond the preferred length.
      if (head === "") head = segment;
      break;
    }
    head += segment;
  }
  head = head.trimEnd();
  return head === text ? head : `${head}…`;
}
