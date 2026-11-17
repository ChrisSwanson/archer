// The shipped bundle stands alone: dist/ copied anywhere runs with `node`,
// with no node_modules beside it, and is ready for Mermaid's DOMPurify import.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { assertProductionPage, buildOptions, builtPages, bundle, pageAssetFiles } from "../../scripts/bundle.ts";
import { readPrecompressed } from "../../src/service/page-version.ts";
import { isolatedProcessEnv, apiBase, openPage, ownerFetch, pageWorkers } from "../service/support.ts";
import { REPO } from "../terminal/models.ts";
import { snapshotUiDist } from "../package/ui-dist.ts";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { FONT_FACE_ASSETS } from "../../src/export/resources.ts";
import { exportThumbnail } from "../../src/export/index.ts";

const TS = join(REPO, "ts");
let scratch: string;
let dist: string;
/** The bundled pages: a private copy of ui/dist (a bundle needs the page build: `npm run build`). */
let pages: string;

const expectedUi = (): string => join(pages, "index.html");
const expectedMcpUi = (): string => join(pages, "mcp", "index.html");

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "archer-bundle-"));
  const copied = await snapshotUiDist(join(scratch, "ui-dist"));
  if (copied === undefined)
    throw new Error("ui/dist is missing: the bundle ships the page build, so run `npm run build` first");
  pages = copied;
  await bundle(join(scratch, "build"), { pages });
  // Only dist/ travels: no node_modules, no sources, no package.json above it.
  dist = join(scratch, "elsewhere", "dist");
  cpSync(join(scratch, "build"), dist, { recursive: true });
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const node = (...args: string[]) =>
  spawnSync(process.execPath, [join(dist, "archer.js"), ...args], {
    encoding: "utf8",
    cwd: scratch,
    env: isolatedProcessEnv(scratch),
  });

test("the copied bundle prints its version from package.json", () => {
  const pkg = JSON.parse(readFileSync(join(TS, "package.json"), "utf8")) as { version: string };
  const { status, stdout } = node("--version");
  expect(status).toBe(0);
  expect(stdout).toBe(`${pkg.version}\n`);
});

test("the copied bundle draws a model", () => {
  const { status, stdout, stderr } = node(
    "draw",
    "--model",
    join(REPO, "fixtures", "flowchart", "shapes.json"),
    "--width",
    "120",
  );
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(stdout.split("\n")[0]).toBe("shapes.json");
  expect(stdout).toContain("Subroutine");
  expect(stdout).toMatch(/^Legend:/m);
});

test("the copied bundle's thumbnail worker draws the same bytes as the painter in process", async () => {
  const source = 'flowchart LR\n a["Request & response"]\n b[API]\n a calls@--> b\n';
  const compiled = await compile(source);
  const envelope = {
    schemaVersion: 2,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id: "drawing", kind: "freeform", title: "Drawing" },
    model: compiled.model,
  };
  const themeCss = readFileSync(join(REPO, "ui", "src", "styles.css"), "utf8");
  const expected = Buffer.from((await exportThumbnail(envelope, { theme: "dark", themeCss })).bytes);
  writeFileSync(join(scratch, "thumb-job.json"), JSON.stringify({ envelope, themeCss }));
  // From dist/ alone: the worker sits beside archer.js, where the service's chunks look for it.
  writeFileSync(
    join(scratch, "thumb-probe.mjs"),
    `import { Worker } from "node:worker_threads"; import { readFileSync } from "node:fs";
const { envelope, themeCss } = JSON.parse(readFileSync(process.argv[3], "utf8"));
const worker = new Worker(process.argv[2], { workerData: { themeCss, raster: null } });
worker.on("message", (message) => {
  if (message.ready) return worker.postMessage({ id: 1, envelope, theme: "dark" });
  process.stdout.write(message.error ?? Buffer.from(message.drawing.svg).toString("base64")); void worker.terminate();
});`,
  );
  const result = spawnSync(
    process.execPath,
    [join(scratch, "thumb-probe.mjs"), join(dist, "thumbnail-worker.js"), join(scratch, "thumb-job.json")],
    { encoding: "utf8", cwd: scratch, env: isolatedProcessEnv(scratch), timeout: 30_000 },
  );
  expect(result.stderr).toBe("");
  expect(Buffer.from(result.stdout, "base64").equals(expected)).toBe(true);
});

test("the copied bundle's compile worker compiles as compile() does in process", async () => {
  const source = "flowchart LR\n a[A]\n b[B]\n a ab@--> b\n";
  writeFileSync(
    join(scratch, "compile-probe.mjs"),
    `import { Worker } from "node:worker_threads";
const worker = new Worker(process.argv[2]);
worker.on("message", (message) => {
  if (message.ready) return worker.postMessage({ id: 1, source: ${JSON.stringify(source)}, options: {} });
  process.stdout.write(JSON.stringify(message.result ?? message.error)); void worker.terminate();
});`,
  );
  const result = spawnSync(process.execPath, [join(scratch, "compile-probe.mjs"), join(dist, "compile-worker.js")], {
    encoding: "utf8",
    cwd: scratch,
    env: isolatedProcessEnv(scratch),
    timeout: 30_000,
  });
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(await compile(source))));
});

test("the copied bundle refuses other commands with exit 2", () => {
  const { status, stderr } = node("frobnicate");
  expect(status).toBe(2);
  expect(stderr).toBe("archer frobnicate: unknown command; archer --help lists them\n");
});

test("the copied bundle carries the page and the supported-Mermaid reference", () => {
  expect(readFileSync(join(dist, "assets", "archer-ui.html")).equals(readFileSync(expectedUi()))).toBe(true);
  // The MCP App's page is one self-contained file (ADR 0003); the web page's worker sits beside it.
  expect(readFileSync(join(dist, "assets", "archer-mcp-app.html")).equals(readFileSync(expectedMcpUi()))).toBe(true);
  // The page's own scripts; the browser e2e setup may leave compressed copies beside them, which the packager does not copy.
  const workers = readdirSync(join(pages, "page-assets")).filter((name) => name.endsWith(".js"));
  expect(workers).toEqual([expect.stringMatching(/^elk-layout-worker-[\w-]+\.js$/)]);
  for (const name of workers) {
    const shipped = join(dist, "assets", "page-assets", name);
    expect(readFileSync(shipped).equals(readFileSync(join(pages, "page-assets", name)))).toBe(true);
    expect(readPrecompressed(shipped, readFileSync(shipped))).not.toBeNull();
    expect(readFileSync(join(dist, "assets", "archer-ui.html"), "utf8")).toContain(name);
  }
  expect(readFileSync(join(dist, "docs", "supported-mermaid.md"), "utf8")).toBe(
    readFileSync(join(TS, "docs", "supported-mermaid.md"), "utf8"),
  );
});

test("packaging refuses a page carrying dev telemetry or React's profiling renderer", () => {
  const page = join(scratch, "page.html");
  writeFileSync(page, "<html><script>const x = 1;</script></html>");
  expect(() => assertProductionPage(page)).not.toThrow();
  for (const marker of ["window.__archerTelemetry = {}", 'fetch("/-/debug/events")', 'track("Cascading Update")']) {
    writeFileSync(page, `<html><script>${marker}</script></html>`);
    expect(() => assertProductionPage(page)).toThrow(/is a debug page/);
  }
});

test("bundling refuses a checkout without its page build, and says how to make it", () => {
  // The web page and the MCP App come from one build; neither has a tracked stand-in.
  const fixture = join(scratch, "ui-source-selection");
  mkdirSync(join(fixture, "mcp"), { recursive: true });
  expect(() => builtPages(fixture)).toThrow(/index\.html is missing: build the pages first with `npm run build`/);
  writeFileSync(join(fixture, "index.html"), "built");
  expect(() => builtPages(fixture)).toThrow(/mcp\/index\.html is missing: build the pages first with `npm run build`/);
  writeFileSync(join(fixture, "mcp", "index.html"), "built");
  expect(builtPages(fixture)).toEqual({
    page: join(fixture, "index.html"),
    mcpPage: join(fixture, "mcp", "index.html"),
  });
});

test("packaging refuses a web page whose worker file is missing beside it", () => {
  const dir = join(scratch, "page-assets-check");
  mkdirSync(join(dir, "page-assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    "<script>new URL(`page-assets/elk-layout-worker-AbC12345.js`,import.meta.url)</script>",
  );
  expect(() => pageAssetFiles(join(dir, "index.html"))).toThrow(/elk-layout-worker-AbC12345\.js, missing/);
  writeFileSync(join(dir, "page-assets", "elk-layout-worker-AbC12345.js"), "worker");
  expect(pageAssetFiles(join(dir, "index.html"))).toEqual([join(dir, "page-assets", "elk-layout-worker-AbC12345.js")]);
  // A single-file page names none and ships none.
  writeFileSync(join(dir, "single.html"), "<script>inline</script>");
  rmSync(join(dir, "page-assets"), { recursive: true });
  expect(pageAssetFiles(join(dir, "single.html"))).toEqual([]);
});

test("the copied distribution reads the exact skill guidance offline through CLI and MCP", async () => {
  // Offline: with no service allowed to start, the relay serves in its own process (ADR 0035 §6).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "archer.js"), "mcp"],
    cwd: scratch,
    env: isolatedProcessEnv(scratch, { ARCHER_AUTO_START: "false" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "guidance-test", version: "0" });
  await client.connect(transport);
  try {
    const { resources } = await client.listResources();
    for (const id of ["authoring", "cli"]) {
      const canonical = readFileSync(join(TS, "plugin/skills/archer/references", `${id}.md`), "utf8");
      const result = node("docs", id);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(canonical);
      const uri = `archer://docs/${id}`;
      expect(resources.map((resource) => resource.uri)).toContain(uri);
      const read = await client.readResource({ uri });
      expect((read.contents[0] as { text: string }).text).toBe(canonical);
    }
  } finally {
    await client.close();
  }
});

test("the copied distribution carries portable export runtime and the exact UI font with license", () => {
  expect(
    readFileSync(join(dist, "assets/export/index_bg.wasm")).equals(
      readFileSync(join(REPO, "node_modules/@resvg/resvg-wasm/index_bg.wasm")),
    ),
  ).toBe(true);
  for (const { asset } of FONT_FACE_ASSETS)
    expect(
      readFileSync(join(dist, "assets/export", asset)).equals(readFileSync(join(REPO, "ui/src/theme/fonts", asset))),
      asset,
    ).toBe(true);
  expect(readFileSync(join(dist, "assets/export/FiraSans-OFL.txt"), "utf8")).toContain(
    "SIL OPEN FONT LICENSE Version 1.1",
  );
});

test("the copied distribution reads complete note prose through CLI and SDK without a service", async () => {
  const project = join(scratch, "note-project");
  mkdirSync(join(project, ".archer/notes"), { recursive: true });
  mkdirSync(join(project, ".git"));
  const source =
    "\uFEFF---\r\nstatus: proposed\r\n---\r\n# Policy\r\nKeep proofs for 43 days.\r\n```mermaid\r\ninvalid\r\n```\r\n";
  writeFileSync(join(project, ".archer/notes/policy.md"), source);
  const argsPath = join(project, "read-args.json");
  writeFileSync(argsPath, JSON.stringify({ notePath: "notes/policy.md" }));
  const state = join(scratch, "note-state");
  const env = isolatedProcessEnv(scratch, { ARCHER_STATE_DIR: state, ARCHER_SOCKET: join(state, "absent.sock") });
  const cli = spawnSync(
    process.execPath,
    [join(dist, "archer.js"), "call", "read_note", "--file", argsPath, "--json"],
    { cwd: project, env, encoding: "utf8" },
  );
  expect(cli.status, cli.stderr).toBe(0);
  const result = JSON.parse(cli.stdout);
  expect(result).toMatchObject({
    notePath: "notes/policy.md",
    source: { status: "text", text: source },
    complete: true,
    sourceRevision: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    bytes: Buffer.byteLength(source),
  });
  const cliText = spawnSync(
    process.execPath,
    [join(dist, "archer.js"), "call", "read_note", "--file", argsPath, "--format", "text"],
    { cwd: project, env, encoding: "utf8" },
  );
  expect(cliText.status, cliText.stderr).toBe(0);
  expect(cliText.stdout.split("--- BEGIN EXACT NOTE SOURCE ---\n")[1]).toBe(source);
  // `archer mcp` relays to the service and would start one (ADR 0035 §6); with none allowed to start it
  // serves in its own process, where a note read needs no service either.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "archer.js"), "mcp"],
    cwd: project,
    env: { ...env, ARCHER_AUTO_START: "false" },
    stderr: "pipe",
  });
  const client = new Client({ name: "note-bundle-test", version: "0" });
  await client.connect(transport);
  try {
    const read = await client.callTool({ name: "read_note", arguments: { notePath: "notes/policy.md" } });
    expect(read.structuredContent).toEqual(result);
    const text = await client.callTool({
      name: "read_note",
      arguments: { notePath: "notes/policy.md", outputFormat: "text" },
    });
    expect(text.structuredContent).toBeUndefined();
    const content = text.content as { type: string; text: string }[];
    expect(content[0]!.text.split("--- BEGIN EXACT NOTE SOURCE ---\n")[1]).toBe(source);
    expect(existsSync(join(state, "service.json"))).toBe(false);
  } finally {
    await client.close();
  }
});

test("the copied bundle's MCP server reads the reference, starts the service on present, and stop ends it", async () => {
  const project = join(scratch, "project");
  mkdirSync(join(project, ".archer"), { recursive: true });
  mkdirSync(join(project, ".git"));
  writeFileSync(join(project, ".archer", "arch.mmd"), "flowchart LR\n  a[Client] e1@--> b[API]\n");
  const env = isolatedProcessEnv(scratch, {
    ARCHER_FORCE_HTTP: "true",
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_RUNTIME_DIR: "",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "archer.js"), "mcp"],
    cwd: project,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const profile = await client.readResource({ uri: "archer://docs/supported-mermaid" });
    expect((profile.contents[0] as { text: string }).text).toContain("# Supported Mermaid");
    const presented = await client.callTool({
      name: "present_diagram",
      arguments: { viewId: "arch", annotation: "From the bundle" },
    });
    const url = (presented.structuredContent as { ui: { url: string } }).ui.url;
    const page = await openPage(url);
    expect(page.status).toBe(200);
    // The served page names its application version (ADR 0032); otherwise it is the shipped page byte for byte.
    expect(page.body).toMatch(/<meta name="archer-application-version" content="\d+\.\d+\.\d+[^"]*">/);
    expect(
      page.body.replace(/<meta name="archer-application-version" content="[^"]*">/, "") ===
        readFileSync(expectedUi(), "utf8"),
    ).toBe(true);
    expect(await (await ownerFetch(`${apiBase(url)}api/bootstrap`)).json()).toMatchObject({
      presentation: { viewId: "arch", annotation: "From the bundle" },
    });
    // The worker the page names is served beside it, compressed from the packaged copy.
    const { workers } = await pageWorkers(url);
    expect(workers.map((worker) => [worker.status, worker.contentType, worker.encoding])).toEqual([
      [200, "text/javascript; charset=utf-8", "br"],
    ]);
    // The MCP App resource is the single file.
    const resource = await client.readResource({ uri: "ui://archer/diagram" });
    expect((resource.contents[0] as { text: string }).text).toBe(readFileSync(expectedMcpUi(), "utf8"));
  } finally {
    await client.close();
    const stopped = spawnSync(process.execPath, [join(dist, "archer.js"), "stop"], {
      encoding: "utf8",
      cwd: project,
      env,
    });
    expect(stopped.stdout).toBe("Archer stopped.\n");
  }
}, 60_000);

test("the bundle ships compressed copies of the page as it is served, keyed by its hash", async () => {
  const { readPrecompressed, withApplicationVersion } = await import("../../src/service/page-version.ts");
  const pagePath = join(dist, "assets", "archer-ui.html");
  const pkg = JSON.parse(readFileSync(join(TS, "package.json"), "utf8")) as { version: string };
  const served = withApplicationVersion(readFileSync(pagePath), pkg.version);
  expect(readPrecompressed(pagePath, served)).not.toBeNull();
});

test("the bundle imports nothing but Node's own modules", () => {
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    // Doc comments kept from dependencies quote import lines (the MCP SDK's do); they are not imports.
    const code = readFileSync(join(dist, file), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
    const specifiers = [
      ...code.matchAll(
        /(?:^|[\s;])(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm,
      ),
    ].map((m) => m[1] ?? m[2] ?? "");
    for (const s of specifiers)
      expect(s.startsWith("node:") || s.startsWith("./") || s.startsWith("../"), `${file}: ${s}`).toBe(true);
  }
});

test("dompurify resolves to an identity stub", async () => {
  const probe = join(scratch, "probe.ts");
  writeFileSync(
    probe,
    'import DOMPurify from "dompurify";\nDOMPurify.addHook("x", () => {});\nconsole.log(DOMPurify.sanitize("<b>a</b> & <img onerror=x>"));\n',
  );
  const options = buildOptions(join(scratch, "probe"));
  await build({ ...options, entryPoints: { probe }, define: {} });
  const out = execFileSync(process.execPath, [join(scratch, "probe", "probe.js")], {
    encoding: "utf8",
    env: isolatedProcessEnv(scratch),
  });
  expect(out).toBe("<b>a</b> & <img onerror=x>\n");
});

test("the copied distribution exports a composable application API", async () => {
  expect(existsSync(join(dist, "api.js")), "application API must ship alongside the CLI").toBe(true);
  const api = await import(pathToFileURL(join(dist, "api.js")).href);
  const app = api.openArcher({
    cwd: scratch,
    service: { stateDir: join(scratch, "api-state"), env: isolatedProcessEnv(scratch) },
  });
  try {
    const answer = await app.call("list_diagrams", {});
    expect(answer.structured.views).toEqual([]);
    expect(api.OPERATIONS).toHaveLength(41);
    expect(api.OPERATIONS.map((operation: { readonly name: string }) => operation.name)).toEqual(
      expect.arrayContaining(["list_changes", "read_change", "resolve_change", "issue_authoring_access"]),
    );
  } finally {
    await app.close();
  }
});

test("the copied API starts Archer rather than its unrelated host application", () => {
  const project = join(scratch, "api-project");
  mkdirSync(join(project, ".archer"), { recursive: true });
  mkdirSync(join(project, ".git"));
  const host = join(scratch, "host.mjs");
  writeFileSync(
    host,
    `import { openArcher } from ${JSON.stringify(pathToFileURL(join(dist, "api.js")).href)};
const app = openArcher({cwd: ${JSON.stringify(project)}});
try { console.log(JSON.stringify((await app.call('get_ui_url', {})).structured)); }
finally { app.close(); }
`,
  );
  const env = isolatedProcessEnv(scratch, {
    ARCHER_FORCE_HTTP: "true",
    ARCHER_STATE_DIR: join(scratch, "api-service-state"),
    XDG_RUNTIME_DIR: "",
  });
  try {
    const result = spawnSync(process.execPath, [host], { env, encoding: "utf8", timeout: 30000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty("url");
  } finally {
    const stopped = spawnSync(process.execPath, [join(dist, "archer.js"), "stop"], { env, encoding: "utf8" });
    expect(stopped.status).toBe(0);
  }
}, 60000);

test("copied CLI exports real SVG and PNG with only packaged resources", () => {
  const root = join(scratch, "export-project");
  mkdirSync(join(root, ".archer"), { recursive: true });
  writeFileSync(
    join(root, "archer.toml"),
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Portable export"\nsource = ".archer/flow.mmd"\n',
  );
  writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\na[Client] e@--> b[Server]\n");
  const env = isolatedProcessEnv(scratch, {
    ARCHER_SOCKET: join(scratch, "no-running-export.sock"),
    ARCHER_STATE_DIR: join(scratch, "export-state"),
    ARCHER_AUTO_START: "false",
    ARCHER_OPEN_BROWSER: "never",
  });
  for (const format of ["svg", "png"]) {
    const output = join(scratch, `portable.${format}`),
      args = join(scratch, `export-${format}.json`);
    writeFileSync(args, JSON.stringify({ viewId: "flow", format, theme: "light" }));
    const result = spawnSync(
      process.execPath,
      [join(dist, "archer.js"), "call", "export_diagram", "--file", args, "--output", output, "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const metadata = JSON.parse(result.stdout);
    expect(metadata).toMatchObject({ outputPath: output, lastGood: false });
    expect(metadata.data).toBeUndefined();
    const bytes = readFileSync(output);
    if (format === "png") expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    else {
      expect(bytes.toString("utf8")).toContain("Client");
      expect(bytes.toString("utf8")).toContain("SIL OPEN FONT LICENSE");
    }
  }
}, 60_000);

test("copied export reports a stable refusal when a packaged resource is missing", () => {
  const partial = join(scratch, "missing-export-assets");
  cpSync(dist, partial, { recursive: true });
  rmSync(join(partial, "assets/export/fira-sans-latin-400.woff2"));
  const root = join(scratch, "missing-assets-project");
  mkdirSync(join(root, ".archer"), { recursive: true });
  writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\na[Client] e@--> b[Server]\n");
  const args = join(scratch, "missing-assets-args.json");
  writeFileSync(args, JSON.stringify({ viewId: "flow" }));
  const result = spawnSync(
    process.execPath,
    [join(partial, "archer.js"), "call", "export_diagram", "--file", args, "--json"],
    {
      cwd: root,
      env: isolatedProcessEnv(scratch, {
        ARCHER_SOCKET: join(scratch, "absent-resource-service.sock"),
        ARCHER_STATE_DIR: join(scratch, "absent-resource-state"),
      }),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  const refusal = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
  expect(refusal).toMatchObject({ code: "export_resources_missing" });
});
