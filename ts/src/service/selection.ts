// What the page reports when the reader selects something: the same record the
// copied Archer page posts to `api/selection` (see ui/src/app/host-bridge.ts,
// `selectionRecord`). Kept opaque beyond the fields every consumer needs.
export interface SelectionContext {
  readonly schemaVersion: number;
  readonly viewId: string;
  readonly revision: string;
  readonly nodes: readonly { readonly id: string; readonly label?: string }[];
  readonly edges: readonly { readonly id: string; readonly label?: string }[];
  readonly [extra: string]: unknown;
}
