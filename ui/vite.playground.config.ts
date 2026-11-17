import { fileURLToPath } from "node:url";
import type { InlineConfig, Plugin } from "vite";
import { pageBuildAliases, stripZodLocales } from "./vite.config.ts";
import { PAGE_ASSETS_DIR } from "../shared/page-assets.mts";

/** Placeholder the font faces name until the bundle is written; outside the bundle, so never inlined. */
const FONT_PLACEHOLDER = "https://archer-shared-fonts.invalid/";

/**
 * The page's own font faces (`src/theme/current-font.css`), pointed at the docs site's shared copies
 * instead of being bundled: one cached file per face for the docs and the playground (ADR 0037, amended).
 */
function sharedFonts(fontsUrl: string): Plugin {
  return {
    name: "archer:playground-shared-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/src/theme/current-font.css")) return null;
      const result = code.replace(/url\("\.\/fonts\/([a-z0-9-]+\.woff2)"\)/g, `url("${FONT_PLACEHOLDER}$1")`);
      if (result === code) throw new Error("archer:playground-shared-fonts found no font faces to share");
      return { code: result, map: null };
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle))
        if (output.type === "asset" && output.fileName.endsWith(".css") && typeof output.source === "string")
          output.source = output.source.replaceAll(FONT_PLACEHOLDER, fontsUrl);
    },
  };
}

/**
 * The public playground: the same App core as the live page, as an ordinary multi-asset build (hashed,
 * cacheable chunks) with a relative base, so one build works under any docs base. Its entry selects the
 * static runtime and address codec at mount; only the layout worker's URL is a build-time module swap.
 * Service and MCP targets never import the static runtime or its data.
 */
export function playgroundBuildConfig(outDir: string, options: { fontsUrl: string }): InlineConfig {
  const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
  return {
    configFile: false,
    root: source("."),
    base: "./",
    publicDir: false,
    cacheDir: source("./node_modules/.vite-playground"),
    logLevel: "warn",
    // Always the published build, even when a test (NODE_ENV=test) runs it.
    mode: "production",
    define: {
      __ARCHER_DEBUG__: "false",
      "import.meta.env.ARCHER_TARGET": '"web"',
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: [
        { find: /^\.\/elk-worker-script(?:\.ts)?$/, replacement: source("./src/playground/worker.ts") },
        ...pageBuildAliases(false, "web"),
      ],
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      manifest: true,
      // Fonts are shared files; nothing else is worth a data URI beside cacheable chunks.
      assetsInlineLimit: 0,
      rolldownOptions: { input: source("./playground.html") },
    },
    worker: {
      rolldownOptions: { output: { entryFileNames: `${PAGE_ASSETS_DIR}/[name]-[hash].js` } },
    },
    plugins: [sharedFonts(options.fontsUrl), stripZodLocales()],
  };
}
