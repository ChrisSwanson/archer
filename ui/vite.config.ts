import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";
import { PAGE_ASSETS_DIR } from "../shared/page-assets.mts";
import { impeccableSameOrigin } from "../tools/impeccable-live.mts";
import { runWritersDir } from "../tools/test-writers-dir.mjs";

export { liveClientAllowed } from "../tools/impeccable-live.mts";

const ARCHER_DEV_SERVER = process.env.ARCHER_DEV_SERVER ?? "http://127.0.0.1:40399";

/**
 * Dev only: load the generated validator as ESM.
 *
 * `envelope-validator.generated.cjs` is CommonJS. The production build
 * converts it; the dev server serves source files as ESM, so its default
 * import is missing and the page fails before it renders. Vitest also runs
 * Vite as `serve` but loads CommonJS itself, so the plugin stays out of tests.
 *
 * Each `require(x)` becomes a namespace import shaped like `module.exports`:
 * the validator reads `require(x).default`, and depending on the interop the
 * namespace's `default` is either that function or the whole exports object.
 */
function generatedValidatorAsEsm(): Plugin {
  return {
    name: "archer:generated-validator-esm",
    apply: (_config, env) => env.command === "serve" && !process.env.VITEST,
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".generated.cjs")) return null;
      const imports: string[] = [];
      const body = code.replace(/require\("([^"]+)"\)/g, (_match, specifier: string) => {
        const name = `__require${imports.length}`;
        imports.push(
          `import * as ${name}Namespace from ${JSON.stringify(specifier)};\n` +
            `const ${name} = { ...${name}Namespace, default: ${name}Namespace.default?.default ?? ${name}Namespace.default };`,
        );
        return name;
      });
      return `${imports.join("\n")}\nconst module = { exports: {} };\n${body}\nexport default module.exports;\n`;
    },
  };
}

/**
 * `__ARCHER_DEBUG__`: development instrumentation (`src/telemetry/`, docs/devkit/CONTRACT.md).
 * On for the dev server and for `ARCHER_DEBUG_UI=1` builds; off for the production build, where every
 * guarded branch is dead code and the telemetry module is never bundled (`scripts/check-prod-strip.mjs`).
 * Vitest runs as `serve` but keeps it off, so component tests see what production runs.
 */
export function archerDebug(command: "serve" | "build", env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ARCHER_DEBUG_UI === "1") return true;
  if (env.ARCHER_DEBUG_UI === "0" || env.VITEST) return false;
  return command === "serve";
}

/** Why a build may not write to `outDir`: a debug page never lands where the production page is packaged from. */
export function debugOutDirRefusal(
  debug: boolean,
  outDir: string,
  uiRoot: string = fileURLToPath(new URL(".", import.meta.url)),
): string | null {
  if (!debug) return null;
  const target = resolve(uiRoot, outDir);
  return target === resolve(uiRoot, "dist") || target === resolve(uiRoot, "dist/mcp")
    ? "a debug build (ARCHER_DEBUG_UI=1) may not write ui/dist or ui/dist/mcp, which ts/scripts/bundle.ts packages; use `npm --workspace ui run build:debug` (dist/debug/)"
    : null;
}

function refuseDebugInProductionDir(debug: boolean): Plugin {
  return {
    name: "archer-refuse-debug-in-production-dir",
    apply: "build",
    configResolved(config) {
      const refusal = debugOutDirRefusal(debug, resolve(config.root, config.build.outDir));
      if (refusal !== null) throw new Error(refusal);
    },
  };
}

/**
 * zod 4 (a dependency of the MCP SDK and ext-apps) re-exports all 51 locale files from two entry
 * modules, so a bundler keeps them: about 147 KB raw, 29 KB gzip, none of it reachable by name from
 * the page. English is imported directly by `classic/external.js` and stays.
 */
export function stripZodLocales(): Plugin {
  const entry = /[\\/]zod[\\/]v4[\\/](?:classic[\\/]external|core[\\/]index)\.js$/;
  let seen = 0,
    stripped = 0;
  return {
    name: "archer:strip-zod-locales",
    enforce: "pre",
    apply: "build",
    transform(code, id) {
      if (!entry.test(id.split("?")[0])) return null;
      seen++;
      const result = code.replace(/^export \* as locales from "[^"]*locales\/index\.js";$/m, "");
      if (result === code) return null;
      stripped++;
      return { code: result, map: null };
    },
    // A zod that moved its locale re-exports would put 147 KB back without a word: fail the build instead.
    buildEnd() {
      if (seen > 0 && stripped === 0)
        throw new Error(
          "archer:strip-zod-locales saw zod's entry modules but found no `export * as locales` line to remove; update the pre-transform in ui/vite.config.ts",
        );
    },
  };
}

/**
 * Which page a build makes. `web` (the default, what the service serves): the page as one file, plus the
 * ELK layout worker as its own content-hashed file in `page-assets/` beside it (about 460 KB gzip that
 * only pages laying out a graph fetch, once per browser). `mcp` (`vite build --mode mcp`): the MCP App
 * resource, one self-contained file with the worker inline (ADR 0003).
 */
export type PageTarget = "web" | "mcp";

/**
 * Module replacements for a page build (not the dev server or tests, which keep the real modules).
 * - ELK ships once, as the layout worker: `elk.bundled` (the export painter's main-thread kernel,
 *   1.4 MB) becomes `src/layout/elk-page-kernel.ts`, which lays out through that worker.
 * - `react-dom/server` is `src/export/static-markup-page.ts`: the export painter calls only `renderToStaticMarkup`,
 *   on small static glyphs, and that writes the same markup without React's server renderer (its legacy browser
 *   build alone was about 88 KB raw, 22 KB gzip; the package entry with the streaming renderer about 180 KB).
 *   The service paints in Node with the real one; `static-markup-page.test.tsx` holds the two to the same bytes.
 *   A page build is always a production build (NODE_ENV=production), debug or not.
 * - A debug build uses React's profiling renderer, so `<Profiler>` (render-storm detection) reports in it too.
 * - The page mounts its target's shell (`src/app/page-shell.tsx`): the web build the browser page, the MCP
 *   build the MCP-App view, and neither carries the other's modules.
 */
export function pageBuildAliases(debug: boolean, target: PageTarget = "web"): { find: RegExp; replacement: string }[] {
  return [
    // The MCP App is one file (ADR 0003): its layout worker is inline; the web page loads it from `/-/page-assets/`.
    ...(target === "mcp"
      ? [
          {
            find: /^\.\/elk-worker-script(\.ts)?$/,
            replacement: fileURLToPath(new URL("./src/layout/elk-worker-script-inline.ts", import.meta.url)),
          },
        ]
      : []),
    // Nor has it Expand: its inline worker carries no source-frame placement (ADR 0036 A12; frame-engine-mcp.ts).
    ...(target === "mcp"
      ? [
          {
            find: /^\.\.\/expand\/frame-engine(\.ts)?$/,
            replacement: fileURLToPath(new URL("./src/expand/frame-engine-mcp.ts", import.meta.url)),
          },
        ]
      : []),
    {
      find: /^\.\/app\/page-shell(\.tsx)?$/,
      replacement: fileURLToPath(new URL(`./src/app/page-shell-${target}.ts`, import.meta.url)),
    },
    {
      find: /^elkjs\/lib\/elk\.bundled\.js$/,
      replacement: fileURLToPath(new URL("./src/layout/elk-page-kernel.ts", import.meta.url)),
    },
    {
      find: /^react-dom\/server$/,
      replacement: fileURLToPath(new URL("./src/export/static-markup-page.ts", import.meta.url)),
    },
    // The nested view's in-process engine is for jsdom and Node; the page lays out in its worker.
    {
      find: /^\.\/nest-local(\.ts)?$/,
      replacement: fileURLToPath(new URL("./src/nesting/nest-local-page.ts", import.meta.url)),
    },
    {
      find: /^\.\/frames-local(\.ts)?$/,
      replacement: fileURLToPath(new URL("./src/expand/frames-local-page.ts", import.meta.url)),
    },
    ...(debug ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : []),
  ];
}

/**
 * The dev server forwards only the page's telemetry upload to the service; `false` answers 404 here.
 * Logs, events, reset, profiles and snapshots are read from the service directly, with its token,
 * so a client reaching this server (perhaps from the LAN) never borrows its loopback address.
 */
export function debugProxyBypass(method: string | undefined, url: string | undefined): false | undefined {
  const path = (url ?? "").split("?", 1)[0];
  return method === "POST" && path === "/-/debug/events" ? undefined : false;
}

/**
 * The service refuses a change whose Origin is not its own. The dev page's own
 * requests carry this server's origin, so those -- and only those -- are
 * presented as the service's; a page on any other origin keeps its Origin and
 * is still refused.
 */
const presentDevOriginAsService: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyReq", (proxyReq, req, res) => {
    // A reloaded page leaves its event stream; close the service's side too, or each reload holds one
    // of the link's connections (the service allows 8) until the dev server stops.
    res.on("close", () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
    const origin = req.headers.origin;
    // HTTP/2 names the host in `:authority`, not `Host`.
    const host = req.headers.host ?? (req.headers as Record<string, string | undefined>)[":authority"];
    if (origin !== undefined && host !== undefined && (origin === `http://${host}` || origin === `https://${host}`)) {
      proxyReq.setHeader("origin", new URL(ARCHER_DEV_SERVER).origin);
    }
  });
};

export default defineConfig(({ command, mode }) => {
  const debug = archerDebug(command);
  const target: PageTarget = mode === "mcp" ? "mcp" : "web";
  return {
    // The page target as a build constant (app/host-bridge.ts `BUILT_FOR`); undefined in dev and tests.
    define: {
      __ARCHER_DEBUG__: JSON.stringify(debug),
      ...(command === "build" ? { "import.meta.env.ARCHER_TARGET": JSON.stringify(target) } : {}),
    },
    resolve: command === "build" ? { alias: pageBuildAliases(debug, target) } : {},
    build: {
      target: "es2022",
    },
    worker: {
      // The web page's worker file, by content hash: a new build never reuses an old name (`page-assets.ts` in ts/).
      rolldownOptions: { output: { entryFileNames: `${PAGE_ASSETS_DIR}/[name]-[hash].js` } },
    },
    plugins: [
      stripZodLocales(),
      viteSingleFile(),
      impeccableSameOrigin({ serverJson: new URL("./.impeccable/live/server.json", import.meta.url) }),
      generatedValidatorAsEsm(),
      refuseDebugInProductionDir(debug),
    ],
    // `vite` in this directory: the page with hot reload, talking to a running
    // Archer service. Open the link `get_ui_url` reports with this server's origin
    // (`/projects/<project>/?follow&token=…`): the service redeems the token and
    // sends the browser back here, signed in, and every request that reaches an
    // `api/` path is forwarded unchanged to `ARCHER_DEV_SERVER`.
    server: {
      // `ARCHER_DEV_TLS_CERT`/`_KEY` (the service's own pair) serve the page over
      // HTTPS on the service's host, so the browser sends its `__Host-` access
      // cookie here too and editing works through the proxy.
      ...(process.env.ARCHER_DEV_TLS_CERT && process.env.ARCHER_DEV_TLS_KEY
        ? {
            https: {
              cert: readFileSync(process.env.ARCHER_DEV_TLS_CERT),
              key: readFileSync(process.env.ARCHER_DEV_TLS_KEY),
            },
          }
        : {}),
      proxy: {
        // A sign-in link (`?token=`) is redeemed by the service, which sets its cookie and sends the
        // browser back here to the clean address: one link signs the dev page in.
        "^/[^?#]*\\?(?:[^#]*&)?token=[a-f0-9]{32}": {
          target: ARCHER_DEV_SERVER,
          changeOrigin: true,
          configure: presentDevOriginAsService,
        },
        // Pathname only (no query or fragment), and never `/-/debug/` (that has its own, narrower rule):
        // a project's `api/` and the page's own at the root (`/api/browser-projects`, `/api/connection`).
        "^/(?!-/debug/)(?:[^/?#]+/([^?#]*/)?)?api/": {
          target: ARCHER_DEV_SERVER,
          changeOrigin: true,
          configure: presentDevOriginAsService,
        },
        // Dev telemetry upload only (`POST /-/debug/events`, which needs the browser's own grant cookie,
        // forwarded as sent). Every other debug route stays on the service: through this proxy every
        // client would arrive from loopback (debugProxyBypass).
        "^/-/debug/": {
          target: ARCHER_DEV_SERVER,
          changeOrigin: true,
          configure: presentDevOriginAsService,
          bypass: (req) => debugProxyBypass(req.method, req.url),
        },
      },
    },
    test: {
      // Default stays node so that fixture-loading tests keep a real file:// URL
      // for `import.meta.url`. Component tests opt into the DOM per file with
      // `// @vitest-environment jsdom`.
      environment: "node",
      setupFiles: ["./tests/setup.ts"],
      // Writer claims are private per-user runtime state (ts/src/comments/lock.ts): a test that starts the real
      // service writes them to the run's own scratch root (tools/test-writers-dir.mjs), removed when the run ends,
      // never the person's own state directory. Made for every Vitest run, whatever its --mode, and not for a
      // build or the dev server.
      ...(process.env.VITEST ? { env: { ARCHER_WRITERS_DIR: runWritersDir() } } : {}),
      // Hold off macOS idle sleep for the run (tools/keep-awake.mjs); name a per-run file for the example
      // snapshot (`tests/support/playground-snapshot.ts`).
      globalSetup: [fileURLToPath(new URL("../tools/keep-awake.mjs", import.meta.url)), "./tests/global-setup.ts"],
      // The service's export painter, by the alias `ts/vitest.config.ts` gives it: a jsdom test that starts the
      // real service (`tests/support/ts-service.ts`) transforms `ts/src` here, where the bare name has no package.
      alias: {
        "@archer/export-painter": fileURLToPath(new URL("./src/export/painter.ts", import.meta.url)),
        "@archer/layout-analysis": fileURLToPath(new URL("./src/layout/analysis.ts", import.meta.url)),
      },

      // Cap the worker pool, because the CI container is killed without one.
      //
      // Vitest sizes its pool from the CPU count, and every worker carries its
      // own V8 heap, so peak memory is the SUM across workers rather than the
      // cost of the suite. Measured on a 10-core host: 1493 MB uncapped, 520 MB
      // at 2, 314 MB at 1. The CI image is SIGKILLed (exit 137) somewhere below
      // 1.25 GB, which is why UI gates failed intermittently on changes that
      // touched no UI code at all -- including documentation-only ones.
      //
      // 2 costs about three seconds locally and leaves roughly 700 MB of head
      // room. The suite itself is not heavy: 376 tests in 3.5s.
      //
      // It is `maxWorkers`, not `poolOptions.forks.maxForks`. The latter is the
      // vitest 1/2 spelling and is silently ignored on vitest 4 -- setting it
      // measures 1486 MB, i.e. no effect whatsoever. An earlier investigation
      // used it, concluded that capping workers does not help, and recorded that
      // the only fix was more runner capacity or a lighter suite. Both
      // conclusions followed from a cap that never applied.
      maxWorkers: 2,

      // Ceilings, not waits. The defaults (5s a test, 10s a hook) are sized for
      // an idle machine; the CI container shares its host with other runners,
      // and a test that is merely slow there is reported as a failure. A hung
      // test now takes 30 seconds to say so, which is the price. See the
      // matching `asyncUtilTimeout` in `tests/setup.ts`.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
