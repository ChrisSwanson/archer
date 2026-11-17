/**
 * A new diagram's starting source, and the service's preview of it (`POST /p/:project/api/authoring/preview`). The
 * editor shows the starter from this answer instead of asking for it: a new draft has nothing authored to compile
 * (performance review 0.11.0, the request that should not happen). `ts/test/authoring/preview.test.ts` holds it
 * equal to what the service answers, so a change to the compiler's envelope fails there, not on the page.
 */
export const STARTER_SOURCE = "flowchart LR\n";
export const STARTER_PREVIEW: { readonly envelope: unknown; readonly diagnostics: readonly unknown[] } = {
  envelope: {
    schemaVersion: 2,
    view: { id: "authoring-preview", kind: "freeform", title: "authoring-preview" },
    revision: "sha256:0388d4f73d3ef2992a8ab9ea5acea6194aabde83d6b9653d67023b00fadefdcd",
    model: { type: "freeform-graph", direction: "lr", nodes: [], edges: [], groups: [] },
  },
  diagnostics: [],
};
