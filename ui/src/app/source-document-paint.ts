import { paintFigure, type Painting } from "../comments/note-figures";
import { validateEnvelope } from "../protocol/validate";
const kinds: Readonly<Record<string, string>> = {
  "architecture-graph": "c4-context",
  "data-flow-graph": "data-flow",
  "freeform-graph": "freeform",
  "sequence-trace": "sequence",
  "state-machine": "state",
  "entity-relationship": "entity-relationship",
  "c4-model": "c4",
  "service-architecture": "architecture",
  "user-journey": "journey",
};
/** Private export-painter metadata only; this ID never enters service identity, navigation or annotations. */
export function sourcePreviewEnvelope(content: unknown, title: string): unknown | null {
  if (content === null || typeof content !== "object") return null;
  const record = content as Record<string, unknown>,
    model = record.model;
  if (model === null || typeof model !== "object" || typeof record.revision !== "string") return null;
  const type = (model as Record<string, unknown>).type;
  if (typeof type !== "string" || !Object.hasOwn(kinds, type)) return null;
  const envelope = {
    schemaVersion: 2,
    view: { id: "document-preview", kind: kinds[type], title: title.slice(0, 200) },
    revision: record.revision,
    model,
  };
  return validateEnvelope(envelope).ok ? envelope : null;
}
export async function paintSourceDocument(content: unknown, title: string): Promise<Painting> {
  const envelope = sourcePreviewEnvelope(content, title);
  if (envelope === null) throw new Error("This diagram could not be compiled.");
  return paintFigure(envelope);
}
