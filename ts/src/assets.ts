// Trusted installation assets shared by adapters and exporters. The caller
// names an installation file, never a project-controlled path.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FONT_FACE_ASSETS, FONT_LICENSE_ASSET, type ExportFontFace } from "./export/resources.ts";

/** Every installation asset, by name, with its source in a checkout. A package must ship each one. */
export const DEVELOPMENT_ASSETS: Readonly<Record<string, string>> = {
  // The MCP App's single file (ADR 0003); in a checkout, the tracked copy of ui/dist/mcp/index.html.
  "archer-mcp-app.html": "../assets/archer-mcp-app.html",
  "guidance/authoring.md": "../plugin/skills/archer/references/authoring.md",
  "guidance/cli.md": "../plugin/skills/archer/references/cli.md",
  "guidance/docs-mode.md": "../plugin/skills/archer/references/docs-mode.md",
  "guidance/walkthroughs.md": "../plugin/skills/archer/references/walkthroughs.md",
  "export/theme.css": "../../ui/src/styles.css",
  // The page's own font files: an export is drawn in the face its layout was measured in.
  [`export/${FONT_LICENSE_ASSET}`]: `../../ui/src/theme/fonts/${FONT_LICENSE_ASSET}`,
  ...Object.fromEntries(
    FONT_FACE_ASSETS.map(({ asset }) => [`export/${asset}`, `../../ui/src/theme/fonts/${asset}`] as const),
  ),
  "export/index_bg.wasm": "../../node_modules/@resvg/resvg-wasm/index_bg.wasm",
};

export function installationAsset(relative: string): Buffer {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(relative) ||
    relative.split("/").some((part) => part === ".." || part === ".")
  )
    throw new Error("invalid installation asset name");
  for (const prefix of ["./assets/", "../assets/"]) {
    const path = fileURLToPath(new URL(prefix + relative, import.meta.url));
    if (existsSync(path)) return readFileSync(path);
  }
  const source = DEVELOPMENT_ASSETS[relative];
  if (source !== undefined) {
    const path = fileURLToPath(new URL(source, import.meta.url));
    if (existsSync(path)) return readFileSync(path);
  }
  throw new Error(`Archer installation is missing asset ${relative}`);
}

/** The Fira Sans faces every drawing is set in (400, 600, 700, 400 italic); every installation ships them all. */
export function exportFontFaces(): ExportFontFace[] {
  return FONT_FACE_ASSETS.map(({ asset, weight, style }) => ({
    weight,
    style,
    bytes: installationAsset(`export/${asset}`),
  }));
}
