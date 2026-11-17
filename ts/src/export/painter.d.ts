declare module "@archer/export-painter" {
  import type { ExportPainterInput, ExportPainting } from "./contract.ts";
  export function paintExport(input: ExportPainterInput): Promise<ExportPainting>;
}
