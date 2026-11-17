import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FONT_FACE_ASSETS, FONT_LICENSE_ASSET } from "../../src/export/resources.ts";
import type { ExportFontFace, ExportResources } from "../../src/export/resources.ts";

/** The page's own Fira Sans faces, from the checkout: what an installation ships (`src/assets.ts`). */
export function testFontFaces(): ExportFontFace[] {
  return FONT_FACE_ASSETS.map(({ asset, weight, style }) => ({
    weight,
    style,
    bytes: readFileSync(resolve("../ui/src/theme/fonts", asset)),
  }));
}

export async function testResources(): Promise<ExportResources> {
  return {
    fontLicense: await readFile(resolve("../ui/src/theme/fonts", FONT_LICENSE_ASSET), "utf8"),
    themeCss: await readFile(resolve("../ui/src/styles.css"), "utf8"),
    fontFaces: testFontFaces(),
    wasmBytes: await readFile(resolve("../node_modules/@resvg/resvg-wasm/index_bg.wasm")),
  };
}
