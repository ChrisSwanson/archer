// Builds ts/dist/: dependency-free ESM that runs with `node dist/archer.js`
// from a copy of dist/ alone (research/02-packaging-and-distribution.md).
//
//   npm --workspace ts run bundle            # into ts/dist
//   tsx scripts/bundle.ts <outdir>
//
// Split chunks keep `archer --version` from compiling the layout engine.
import { build, type BuildOptions } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrecompressed, writePrecompressedPage } from "../src/service/page-version.ts";
import { FONT_FACE_ASSETS, FONT_LICENSE_ASSET } from "../src/export/resources.ts";
import { PAGE_ASSETS_DIR, namedPageAssets } from "../../shared/page-assets.mts";
import { debugMarkersIn } from "../../ui/scripts/check-prod-strip.mjs";

const TS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pages a bundle ships, from this checkout's page build (`npm run build` makes both): the web page the
 * service serves, with its own files beside it, and the MCP App's one self-contained file (ADR 0003). There is
 * no fallback: the tracked `assets/archer-mcp-app.html` holds the MCP shell alone, and the web page cannot be one
 * file. Throws, saying how to build them, when either is missing.
 */
export function builtPages(pages: string): { readonly page: string; readonly mcpPage: string } {
  const page = join(pages, "index.html"),
    mcpPage = join(pages, "mcp", "index.html");
  for (const path of [page, mcpPage]) {
    if (!existsSync(path))
      throw new Error(
        `${path} is missing: build the pages first with \`npm run build\` (it makes the web page and the MCP App together)`,
      );
  }
  return { page, mcpPage };
}

/**
 * The web page's own files (`page-assets/` beside it: the ELK layout worker), each checked against the page:
 * every asset the page names must be there, so a page never ships without its worker.
 */
export function pageAssetFiles(pagePath: string): string[] {
  const dir = join(dirname(pagePath), PAGE_ASSETS_DIR);
  const present = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .sort()
    : [];
  const named = namedPageAssets(readFileSync(pagePath, "utf8"));
  const missing = named.filter((name) => !present.includes(name));
  if (missing.length > 0)
    throw new Error(
      `${pagePath} names ${missing.join(", ")}, missing from ${dir}: rebuild the page with \`npm --workspace ui run build\``,
    );
  return present.map((name) => join(dir, name));
}

/** `version` overrides package.json's, for tests that swap between two builds (hot-swap.e2e.ts). */
export function buildOptions(outdir: string, version?: string): BuildOptions {
  const pkg = JSON.parse(readFileSync(join(TS, "package.json"), "utf8")) as { version: string };
  return {
    absWorkingDir: TS,
    // The workers sit beside archer.js: the service finds them there (thumbnailWorkerLocation, compileWorkerLocation).
    entryPoints: {
      archer: join(TS, "src", "bin", "archer.ts"),
      api: join(TS, "src", "api.ts"),
      "thumbnail-worker": join(TS, "src", "service", "thumbnail-worker.ts"),
      "compile-worker": join(TS, "src", "service", "compile-worker.ts"),
      "layout-worker": join(TS, "src", "measurement", "worker.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22.18",
    chunkNames: "chunks/[name]-[hash]",
    // No DOM shim: DOMPurify is replaced by an identity stub (research 12).
    alias: {
      dompurify: join(TS, "scripts", "dompurify-stub.mjs"),
      "@archer/export-painter": join(TS, "../ui/src/export/painter.ts"),
      "@archer/layout-analysis": join(TS, "../ui/src/layout/analysis.ts"),
    },
    // elkjs probes for this optional package inside a try and falls back
    // without it; nothing else may stay outside the bundle.
    external: ["web-worker"],
    // CommonJS dependencies call `require`; ESM has none, so give each file one.
    banner: {
      js: 'import { createRequire as __archerCreateRequire } from "node:module";\nconst require = __archerCreateRequire(import.meta.url);',
    },
    define: { ARCHER_VERSION: JSON.stringify(version ?? pkg.version) },
    // Not minified: minifying halves the size (3.3 MB to 1.5 MB) but made a draw
    // about 70 ms slower to start (elkjs), and keeps stack traces readable.
    legalComments: "linked",
    logLevel: "warning",
  };
}

/** Refuses a page that carries dev telemetry or the profiling renderer (`ui/scripts/check-prod-strip.mjs`). */
export function assertProductionPage(path: string): void {
  const found = debugMarkersIn(readFileSync(path, "utf8"));
  if (found.length > 0)
    throw new Error(
      `${path} is a debug page (it contains ${found.join(", ")}); rebuild it with \`npm --workspace ui run build\` before bundling`,
    );
}

/**
 * Empties `outdir` and builds the bundle into it. `pages` is a directory laid out as `ui/dist` is
 * (`index.html`, `mcp/index.html`, `page-assets/`) to ship instead of ui/dist: tests pass a
 * private copy, so a page rebuilt meanwhile cannot change what they compare.
 */
export async function bundle(outdir: string, options: { version?: string; pages?: string } = {}): Promise<void> {
  // The pages are checked before anything is built.
  const { page, mcpPage } = builtPages(options.pages ?? UI_DIST);
  assertProductionPage(page);
  assertProductionPage(mcpPage);
  const assets = pageAssetFiles(page);
  rmSync(outdir, { recursive: true, force: true });
  await build(buildOptions(outdir, options.version));
  // dist/ may be copied under a CommonJS package; this keeps its .js files ESM.
  // `archerMcp: "relay"`: this bundle's `archer mcp` is the relay to the service (ADR 0035 §6); the setup of
  // 0.14 and earlier lists MCP processes whose bundle does not say so as sessions to restart.
  writeFileSync(
    join(outdir, "package.json"),
    `${JSON.stringify({ name: "archer", type: "module", exports: { ".": "./api.js" }, bin: { archer: "./archer.js" }, archerMcp: "relay" }, null, 2)}\n`,
  );
  // Read at run time, beside the chunks: the page the service serves, and the
  // reference the MCP server offers as a resource.
  for (const [index, [from, to]] of SHIPPED.entries()) {
    mkdirSync(dirname(join(outdir, to)), { recursive: true });
    copyFileSync(index === 0 ? page : index === 1 ? mcpPage : join(TS, from), join(outdir, to));
  }
  // gzip and brotli copies of the page as it is served (version stamped), keyed by its sha256: the service uses
  // them when the hash matches and compresses at run time otherwise.
  const pkg = JSON.parse(readFileSync(join(TS, "package.json"), "utf8")) as { version: string };
  writePrecompressedPage(join(outdir, "assets", "archer-ui.html"), options.version ?? pkg.version);
  // The page's own files beside it, as the service looks for them (`page-assets.ts`), with their copies too.
  for (const asset of assets) {
    const to = join(outdir, "assets", PAGE_ASSETS_DIR, basename(asset));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(asset, to);
    writePrecompressed(to, readFileSync(to));
  }
}

/** This checkout's page build. */
const UI_DIST = join(TS, "..", "ui", "dist");

/** The skill's references, each also served as `archer docs <name>` and an MCP resource (src/assets.ts guidance/). */
const REFERENCES = "plugin/skills/archer/references";
const guidance = (): (readonly [string, string])[] =>
  readdirSync(join(TS, REFERENCES))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [`${REFERENCES}/${name}`, `assets/guidance/${name}`] as const);

/** Files dist/ needs at run time, from ts/ to dist/; the first two are the pages (`builtPages`). */
export const SHIPPED: readonly (readonly [string, string])[] = [
  ["../ui/dist/index.html", "assets/archer-ui.html"],
  ["../ui/dist/mcp/index.html", "assets/archer-mcp-app.html"],
  ["../node_modules/@resvg/resvg-wasm/index_bg.wasm", "assets/export/index_bg.wasm"],
  // The page's own font files, which every export is drawn in, and their licence.
  ...[...FONT_FACE_ASSETS.map(({ asset }) => asset), FONT_LICENSE_ASSET].map(
    (file) => [`../ui/src/theme/fonts/${file}`, `assets/export/${file}`] as const,
  ),
  ["../ui/src/styles.css", "assets/export/theme.css"],
  ["docs/supported-mermaid.md", "docs/supported-mermaid.md"],
  // Every reference the skill carries, so a new one ships without a line here.
  ...guidance(),
  ["../docs/tls.md", "docs/tls.md"],
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle(resolve(process.argv[2] ?? join(TS, "dist")));
}
