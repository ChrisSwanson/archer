import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The family every drawing names: the page's own face (`ui/src/theme/current-font.css`). */
export const FONT_FAMILY = "Fira Sans";

/** One static face of the family, as bytes (a woff2, which browsers and resvg both read). */
export interface ExportFontFace {
  readonly weight: 400 | 600 | 700;
  readonly style: "normal" | "italic";
  readonly bytes: Uint8Array;
}

/**
 * The faces a drawing is set in, by asset name (inside the export asset directory): the page's
 * own files, so an export is drawn in the face the layout measured. One static face per weight
 * and slant the painter uses; resvg matches a face by its weight and style, so without one it
 * draws a neighbour's.
 */
export const FONT_FACE_ASSETS = [
  { asset: "fira-sans-latin-400.woff2", weight: 400, style: "normal" },
  { asset: "fira-sans-latin-600.woff2", weight: 600, style: "normal" },
  { asset: "fira-sans-latin-700.woff2", weight: 700, style: "normal" },
  { asset: "fira-sans-latin-400-italic.woff2", weight: 400, style: "italic" },
] as const;

/** The family's licence (SIL OFL 1.1), embedded in every SVG beside the faces. */
export const FONT_LICENSE_ASSET = "FiraSans-OFL.txt";

/** Assets are read only at the package boundary; the renderer never knows a checkout path. */
export interface ExportResources {
  readonly themeCss: string;
  readonly fontLicense: string;
  /** Every face in `FONT_FACE_ASSETS`; at least the regular one, or nothing is drawn. */
  readonly fontFaces: readonly ExportFontFace[];
  readonly wasmBytes: Uint8Array;
}

export async function loadExportResources(assetDirectory: string): Promise<ExportResources> {
  const [themeCss, wasmBytes, fontLicense, fontFaces] = await Promise.all([
    readFile(join(assetDirectory, "theme.css"), "utf8"),
    readFile(join(assetDirectory, "index_bg.wasm")),
    readFile(join(assetDirectory, FONT_LICENSE_ASSET), "utf8"),
    Promise.all(
      FONT_FACE_ASSETS.map(async ({ asset, weight, style }) => ({
        weight,
        style,
        bytes: await readFile(join(assetDirectory, asset)),
      })),
    ),
  ]);
  return { themeCss, fontFaces, wasmBytes, fontLicense };
}
