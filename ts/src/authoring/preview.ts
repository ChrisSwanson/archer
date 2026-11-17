/** Ephemeral server-side compilation and bounded source-preserving edit requests. */
import { compileDiagramBytes } from "../project/envelope.ts";
import { editDiagram } from "./diagram-edit.ts";
import { compileCached } from "./compile-cache.ts";
import { parseAuthoringPreview } from "./preview-input.ts";
export { parseAuthoringPreview } from "./preview-input.ts";
export async function previewAuthoring(value: unknown, editing = false): Promise<unknown> {
  const input = parseAuthoringPreview(value, editing);
  let source = input.source;
  if (input.edit) {
    const edited = await editDiagram(source, input.edit);
    if (!edited.ok) return edited;
    source = edited.source;
  }
  // The edit's verifying compile was of exactly this text: reuse it (and the next edit starts from it) instead of
  // compiling a third time. The answer is serialized and dropped, never kept or changed.
  const { envelope, diagnostics } = await compileDiagramBytes(
    { path: "authoring-preview.mmd" },
    Buffer.from(source),
    compileCached,
  );
  return editing ? { ok: true, source, envelope, diagnostics } : { envelope, diagnostics };
}
