// What the production page ships (perf #3): ELK once, as the layout worker, and no main-thread copy.
// Builds the page in a child process (about 6 s), into a temporary directory.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { pageBuildAliases, stripZodLocales } from "../vite.config";

const UI = fileURLToPath(new URL("..", import.meta.url));
const VITE = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "archer-page-bundle-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** A string only ELK's kernel carries; each bundled copy has it once. */
const ELK_KERNEL_MARKER = "org.eclipse.elk.core.labels";
/** A string only the nested view's engine carries (`grow-in-place-v2.ts`): it runs in the layout worker only. */
const NEST_ENGINE_MARKER = "in the layout it would grow from";
/** The streaming server build's own export (the legacy build names it only inside an error message). */
const STREAMING_SERVER_MARKER = ".renderToReadableStream=";
/** Strings only zod's non-English locale files carry (Spanish, Czech, Hungarian); English is the one the page loads. */
const ZOD_LOCALE_MARKERS = ["Entrada inválida", "Neplatný vstup", "Érvénytelen bemenet"];
/** Strings only the web shell (`App.tsx`'s canvas tools) and the HTTP transport (`connectHttpBridge`) carry. */
const WEB_SHELL_MARKERS = ["Open a diagram to compare revisions", "api/bootstrap"];
/**
 * Uncompressed page cap: 3.56 MB when set (5.00 MB before the second ELK copy was dropped); 3.92 MB
 * with the source editor (CodeMirror 6, minimal packages: +372 KB raw, +118 KB gzip, of which
 * @codemirror/view is 186 KB), which is evaluated only when a source is first shown.
 */
const PAGE_BYTES_CAP = 4_250_000;

it("a page build swaps elk.bundled for the worker-backed kernel, debug or not", () => {
  for (const debug of [false, true]) {
    const elk = pageBuildAliases(debug).find(({ find }) => find.test("elkjs/lib/elk.bundled.js"));
    expect(elk?.replacement).toBe(fileURLToPath(new URL("../src/layout/elk-page-kernel.ts", import.meta.url)));
    expect(pageBuildAliases(debug).some(({ find }) => find.test("react-dom/client"))).toBe(debug);
    const server = pageBuildAliases(debug).find(({ find }) => find.test("react-dom/server"));
    expect(server?.replacement).toBe(fileURLToPath(new URL("../src/export/static-markup-page.ts", import.meta.url)));
    const local = pageBuildAliases(debug).find(({ find }) => find.test("./nest-local"));
    expect(local?.replacement).toBe(fileURLToPath(new URL("../src/nesting/nest-local-page.ts", import.meta.url)));
    // Each build mounts its own target's shell (`page-shell.tsx`), and nothing of the other's.
    for (const target of ["web", "mcp"] as const) {
      const shell = pageBuildAliases(debug, target).find(({ find }) => find.test("./app/page-shell"));
      expect(shell?.replacement).toBe(fileURLToPath(new URL(`../src/app/page-shell-${target}.ts`, import.meta.url)));
    }
  }
});

/** Builds the page (`mode` "mcp": the MCP App's single file) into `out/<name>`. */
function build(name: string, mode?: "mcp"): string {
  const { VITEST: _vitest, ARCHER_DEBUG_UI: _debug, NODE_ENV: _mode, ...env } = process.env;
  execFileSync(
    process.execPath,
    [
      VITE,
      "build",
      "--outDir",
      join(out, name),
      "--emptyOutDir",
      "--logLevel",
      "error",
      ...(mode === undefined ? [] : ["--mode", mode]),
    ],
    { cwd: UI, env, stdio: "pipe" },
  );
  return join(out, name);
}
const count = (text: string, marker: string): number => text.split(marker).length - 1;

it("the web page loads ELK from its own hashed file, carries it nowhere else, and stays under its size cap", () => {
  const dir = build("web");
  const page = readFileSync(join(dir, "index.html"), "utf8");
  // The page's own files beside it, each named by its content hash: among them the layout worker, the one
  // file that carries ELK.
  const assets = readdirSync(join(dir, "page-assets"));
  for (const name of assets) expect(name).toMatch(/^[\w-]+-[\w-]{8,}\.js$/);
  const workers = assets.filter((name) => /^elk-layout-worker-[\w-]{8,}\.js$/.test(name));
  expect(workers).toHaveLength(1);
  const worker = readFileSync(join(dir, "page-assets", workers[0]!), "utf8");
  for (const name of assets)
    if (name !== workers[0])
      expect(count(readFileSync(join(dir, "page-assets", name), "utf8"), ELK_KERNEL_MARKER), name).toBe(0);
  expect(count(worker, ELK_KERNEL_MARKER)).toBe(1);
  expect(count(page, ELK_KERNEL_MARKER)).toBe(0);
  // The page always has a Worker: the in-process engine (tests, Node) is not shipped beside the worker's copy.
  expect(count(worker, NEST_ENGINE_MARKER)).toBe(1);
  expect(count(page, NEST_ENGINE_MARKER)).toBe(0);
  // The page names the file; the service serves it under the page's credential (`/-/page-assets/`).
  expect(page).toContain(workers[0]!);
  // The export painter needs only `renderToStaticMarkup`: React's streaming server build stays out.
  expect(page).not.toContain(STREAMING_SERVER_MARKER);
  // zod ships 51 locale files (about 147 KB) that nothing selects; the build drops the re-exports.
  for (const marker of ZOD_LOCALE_MARKERS) expect(page, marker).not.toContain(marker);
  expect(Buffer.byteLength(page)).toBeLessThan(PAGE_BYTES_CAP);
}, 180_000);

it("the MCP App page is one self-contained file with ELK inline (ADR 0003)", () => {
  const dir = build("mcp", "mcp");
  expect(readdirSync(dir)).toEqual(["index.html"]);
  const page = readFileSync(join(dir, "index.html"), "utf8");
  expect(count(page, ELK_KERNEL_MARKER)).toBe(1);
  expect(page).not.toContain("page-assets");
  expect(existsSync(join(dir, "page-assets"))).toBe(false);
  // The MCP shell alone: an MCP host never shows the web shell, and the file is never served over http(s).
  for (const marker of WEB_SHELL_MARKERS) expect(count(page, marker), marker).toBe(0);
}, 180_000);

it("every hashed file ships the bytes its name was computed from, so an immutable name follows its bytes", () => {
  // Rolldown names a file from its bytes after `renderChunk`, so a transform there is fine. A rewrite after naming
  // (`generateBundle`, `writeBundle`) would ship new bytes under the old immutable name (pass 1's ASCII step did).
  // A recorder that runs first in `generateBundle` (the page's and the worker's builds) keeps each file's bytes as
  // named; the files written must match.
  const dir = join(out, "named");
  const recorded = join(out, "named.json");
  const script = `
    import { build } from ${JSON.stringify(pathToFileURL(join(UI, "../node_modules/vite/dist/node/index.js")).href)};
    import { writeFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const named = {};
    const recorder = { name: "test:named-bytes", enforce: "pre", generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) named[file.fileName] = createHash("sha256").update(file.type === "chunk" ? file.code : file.source).digest("hex");
    } };
    await build({ root: ${JSON.stringify(UI)}, configFile: ${JSON.stringify(join(UI, "vite.config.ts"))}, logLevel: "error", plugins: [recorder], worker: { plugins: () => [recorder] }, build: { outDir: ${JSON.stringify(dir)}, emptyOutDir: true } });
    writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(named));
  `;
  const { VITEST: _vitest, ARCHER_DEBUG_UI: _debug, NODE_ENV: _mode, ...env } = process.env;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: UI, env, stdio: "pipe" });
  const named = JSON.parse(readFileSync(recorded, "utf8")) as Record<string, string>;
  const hashed = readdirSync(join(dir, "page-assets")).map((name) => `page-assets/${name}`);
  expect(hashed.length).toBeGreaterThan(0);
  for (const file of hashed)
    expect([
      file,
      createHash("sha256")
        .update(readFileSync(join(dir, file)))
        .digest("hex"),
    ]).toEqual([file, named[file]]);
}, 180_000);

it("stripZodLocales removes only the locales re-export, in the two zod entry files", () => {
  const plugin = stripZodLocales();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
  const core =
    'export * from "./api.js";\nexport * as locales from "../locales/index.js";\nexport * from "./registries.js";\n';
  expect(transform(core, "/n/zod/v4/core/index.js")?.code).toBe(
    'export * from "./api.js";\n\nexport * from "./registries.js";\n',
  );
  const classic =
    'import en from "../locales/en.js";\nconfig(en());\nexport * as locales from "../locales/index.js";\nexport * as iso from "./iso.js";\n';
  expect(transform(classic, "C:\\n\\zod\\v4\\classic\\external.js?v=1")?.code).toBe(
    'import en from "../locales/en.js";\nconfig(en());\n\nexport * as iso from "./iso.js";\n',
  );
  // Any other file, or one without the line, is left alone.
  expect(transform(core, "/n/other/index.js")).toBeNull();
  expect(transform("export {};", "/n/zod/v4/core/index.js")).toBeNull();
});
