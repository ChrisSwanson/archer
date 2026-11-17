export type SourceDocument = {
  readonly source: { readonly path: string };
  readonly kind: "markdown" | "mermaid";
  readonly title: string;
  readonly legacy?: { readonly notePath?: string; readonly viewId?: string };
  readonly capabilities: {
    readonly read: true;
    readonly sourceWrite: false;
    readonly comments: boolean;
    readonly emphasis: boolean;
  };
  readonly description?: string;
  readonly descriptionFrom?: "frontmatter" | "comment" | "derived";
  readonly revision?: string;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function sourceDocumentPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\\\u0000-\u001f\u007f:]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export function parseSourceDocuments(value: unknown): readonly SourceDocument[] | null {
  if (!Array.isArray(value) || value.length > 10000) return null;
  const paths = new Set<string>();
  const documents: SourceDocument[] = [];
  for (const item of value) {
    if (
      !record(item) ||
      !record(item.source) ||
      !sourceDocumentPath(item.source.path) ||
      paths.has(item.source.path) ||
      (item.kind !== "markdown" && item.kind !== "mermaid") ||
      typeof item.title !== "string" ||
      item.title.length > 512 ||
      !record(item.capabilities) ||
      item.capabilities.read !== true ||
      item.capabilities.sourceWrite !== false ||
      typeof item.capabilities.comments !== "boolean" ||
      typeof item.capabilities.emphasis !== "boolean"
    )
      return null;
    if (
      item.description !== undefined &&
      (typeof item.description !== "string" || item.description.length > 1000 || [...item.description].length > 500)
    )
      return null;
    if (
      item.revision !== undefined &&
      (typeof item.revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.revision))
    )
      return null;
    if (
      item.legacy !== undefined &&
      (!record(item.legacy) ||
        (item.legacy.notePath !== undefined && !sourceDocumentPath(item.legacy.notePath)) ||
        (item.legacy.viewId !== undefined &&
          (typeof item.legacy.viewId !== "string" || item.legacy.viewId.length > 1200)))
    )
      return null;
    paths.add(item.source.path);
    documents.push({
      source: { path: item.source.path },
      kind: item.kind,
      title: item.title,
      capabilities: {
        read: true,
        sourceWrite: false,
        comments: item.capabilities.comments,
        emphasis: item.capabilities.emphasis,
      },
      ...(item.legacy === undefined
        ? {}
        : {
            legacy: {
              ...(typeof item.legacy.notePath === "string" ? { notePath: item.legacy.notePath } : {}),
              ...(typeof item.legacy.viewId === "string" ? { viewId: item.legacy.viewId } : {}),
            },
          }),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(item.descriptionFrom === "frontmatter" ||
      item.descriptionFrom === "comment" ||
      item.descriptionFrom === "derived"
        ? { descriptionFrom: item.descriptionFrom }
        : {}),
      ...(typeof item.revision === "string" ? { revision: item.revision } : {}),
    });
  }
  return documents;
}
