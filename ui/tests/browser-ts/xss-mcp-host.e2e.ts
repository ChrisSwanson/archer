// Security rubric G7 (probe P6, docs/quality/rubrics/security.md) in an MCP Apps host: no script from content
// when Archer's app resource is embedded the way a host embeds it.
//
// A devkit sandbox serves the hostile corpus (tools/devkit/corpus/hostile); `archer mcp` runs over stdio and a
// real SDK client talks to it: resources/list and resources/read for `ui://archer/diagram`, then the tool
// results that open views (present_diagram, set_emphasis). support/mcp-sandbox-host.ts embeds the resource as
// the specification asks: the official AppBridge on the host page, a sandbox proxy on a second origin, the view
// in a sandboxed `srcdoc` frame under a CSP built from the resource's own `_meta.ui.csp`. Every hostile view,
// note-embedded figure, agent caption and emphasis text and the SVG export is opened, and the G7 detectors run in
// every frame. Two positive controls make a zero mean something: a resource with its CSP stripped and a seeded
// script, and a planted unsanitised sink inside the real app under its declared CSP; together they trip all seven
// detectors.
//
//   G7_HOST_CONFIGS=served-header,packaged-meta   which host configurations run (default: all four)
//   G7_SEED_FAIL=1                                seed the payload into the matrix's resource: the gate must fail
//   G7_REPORT_DIR=<dir>                           write g7-mcp-host.json and .md there
//   G7_SANDBOX=<name>                             the devkit sandbox name (default g7-host-<pid>)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Frame } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  HostDetectors,
  HostServers,
  SandboxHost,
  resourcePolicy,
  type CspMode,
  type ResourceCsp,
} from "./support/mcp-sandbox-host";
import { settled } from "./support/settled";
import { DETECTORS, describeHits, OWNED, type Detector } from "./support/xss-detectors";

const REPO = resolve(import.meta.dirname, "../../..");
const CORPUS_DIR = resolve(REPO, "tools/devkit/corpus/hostile");
const COMMENTS = (
  JSON.parse(readFileSync(resolve(CORPUS_DIR, "project/.devkit/comments.json"), "utf8")) as { bodies: string[] }
).bodies;
const PACKAGED = resolve(REPO, "ui/dist/mcp/index.html");
const UI_URI = "ui://archer/diagram";
const MIME = "text/html;profile=mcp-app";
const SANDBOX = process.env.G7_SANDBOX ?? `g7-host-${process.pid}`;
const SEED_FAIL = process.env.G7_SEED_FAIL === "1";
const REPORT_DIR = process.env.G7_REPORT_DIR;

type Config = { id: string; bundle: "served" | "packaged"; cspMode: CspMode; sandbox: string };
const ALL_CONFIGS: Config[] = [
  // The reference host: CSP as the proxy's header, the view keeps its own (opaque-to-the-host) origin.
  { id: "served-header", bundle: "served", cspMode: "header", sandbox: "allow-scripts allow-same-origin" },
  { id: "packaged-header", bundle: "packaged", cspMode: "header", sandbox: "allow-scripts allow-same-origin" },
  // A stricter host: an opaque-origin view, the CSP as a meta the proxy writes first.
  { id: "served-meta", bundle: "served", cspMode: "meta", sandbox: "allow-scripts" },
  { id: "packaged-meta", bundle: "packaged", cspMode: "meta", sandbox: "allow-scripts" },
];
const CONFIGS = process.env.G7_HOST_CONFIGS
  ? ALL_CONFIGS.filter((c) => process.env.G7_HOST_CONFIGS!.split(",").includes(c.id))
  : ALL_CONFIGS;

/** A known script payload, the positive control's and G7_SEED_FAIL's: each line trips one detector. */
const SEEDED = `<script>
window.__xss = "seeded-script";
alert("seeded-alert");
fetch("https://xss-canary.invalid/seeded-fetch").catch(() => {});
document.addEventListener("DOMContentLoaded", () => document.body.insertAdjacentHTML("beforeend",
  '<a id="__archerTelemetry" href="javascript:window.__xss=\\'seeded-click\\'">seeded</a>' +
  '<img src="https://xss-canary.invalid/seeded.png" onerror="window.__xss=\\'seeded-onerror\\'">'));
</script>`;
const seed = (html: string): string => html.replace(/<head[^>]*>/i, (head) => head + SEEDED);

type Row = {
  config: string;
  case: string;
  surface: string;
  payloadFamily: string;
  outcome: string;
  drawn: number;
  hostileTextShown: boolean;
  payloadShown?: boolean;
  links: number;
  nodesClicked: number;
  armed: boolean;
  hits: Record<Detector, number>;
};
const report: {
  runner: number;
  sandbox: string;
  resource?: unknown;
  policy?: string;
  configs: Record<string, unknown>;
  positiveControls: Record<string, unknown>;
  baseline: Record<string, string[]>;
  rows: Row[];
  exports: Row[];
  hits: unknown[];
  notCovered: string[];
} = {
  runner: process.ppid,
  sandbox: SANDBOX,
  configs: {},
  positiveControls: {},
  baseline: {},
  rows: [],
  exports: [],
  hits: [],
  notCovered: [],
};

let client: Client;
let servers: HostServers;
let served: { html: string; csp: ResourceCsp; meta: unknown };
let views: { id: string; kind: string; title: string }[] = [];
let embedded: { address: string; note: string; kind: string }[] = [];

function sandboxCli(...args: string[]): string {
  const out = spawnSync(process.execPath, [resolve(REPO, "tools/devkit/sandbox.mjs"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 170_000,
  });
  if (out.status !== 0) throw new Error(`sandbox ${args.join(" ")} failed: ${out.stderr || out.stdout}`);
  return out.stdout;
}

// One worker, in order (one sandbox); a failure restarts the worker, so the report merges per runner.
test.describe.configure({ mode: "default", timeout: 600_000 });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const record = JSON.parse(sandboxCli("up", "--name", SANDBOX, "--corpus", CORPUS_DIR).trim().split("\n").pop()!) as {
    root: string;
    projects: { root: string }[];
  };
  const root = record.root;
  const home = join(root, "home"),
    stateDir = join(root, "state");
  // The sandbox's own environment (tools/devkit/sandbox.mjs sandboxEnv): its home, config, state and socket.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !k.toUpperCase().startsWith("GIT_") && !k.startsWith("ARCHER_"),
    ) as [string, string][],
  );
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ARCHER_CONFIG: join(root, "archer.toml"),
    ARCHER_STATE_DIR: stateDir,
    ARCHER_SOCKET: join(stateDir, "archer.sock"),
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
    ARCHER_RESTORE_STATE: "false",
    ARCHER_AUTO_START: "false",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      resolve(REPO, "node_modules/tsx/dist/esm/index.mjs"),
      resolve(REPO, "ts/src/bin/archer.ts"),
      "mcp",
    ],
    cwd: record.projects[0]!.root,
    env,
    stderr: "ignore",
  });
  client = new Client(
    { name: "g7-mcp-host", version: "0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } } as never },
  );
  await client.connect(transport);
  servers = await HostServers.start();

  const listed = await client.listResources();
  const entry = listed.resources.find((r) => r.uri === UI_URI);
  expect(entry?.mimeType, "resources/list offers the app").toBe(MIME);
  const read = (await client.readResource({ uri: UI_URI })).contents[0] as unknown as {
    mimeType: string;
    text: string;
    _meta: { ui: { csp: ResourceCsp } };
  };
  expect(read.mimeType).toBe(MIME);
  served = { html: read.text, csp: read._meta.ui.csp, meta: read._meta };
  const tools = (await client.listTools()).tools
    .filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri === UI_URI)
    .map((t) => t.name);
  report.resource = {
    uri: UI_URI,
    mimeType: read.mimeType,
    servedChars: read.text.length,
    packagedChars: readFileSync(PACKAGED, "utf8").length,
    sameAsPackaged: read.text === readFileSync(PACKAGED, "utf8"),
    meta: read._meta,
    toolsThatOpenIt: tools,
  };
  report.policy = resourcePolicy(served.csp);
  const inventory = (await client.callTool({ name: "list_diagrams", arguments: { outputFormat: "json" } }))
    .structuredContent as {
    views: { id: string; kind: string; title: string }[];
    embedded: { address: string; note: string; kind: string }[];
  };
  views = inventory.views;
  embedded = inventory.embedded;
  expect(views.length, "the hostile corpus's views").toBe(16);
});

test.afterAll(async () => {
  await client?.close().catch(() => {});
  servers?.stop();
  try {
    sandboxCli("down", "--name", SANDBOX);
  } catch (error) {
    console.error(String(error));
  }
  if (REPORT_DIR !== undefined) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const path = join(REPORT_DIR, "g7-mcp-host.json");
    // A worker restarted after a failure in the same run: keep what the earlier worker wrote.
    const earlier = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as typeof report) : undefined;
    if (earlier?.runner === report.runner) {
      report.configs = { ...earlier.configs, ...report.configs };
      report.positiveControls = { ...earlier.positiveControls, ...report.positiveControls };
      report.baseline = { ...earlier.baseline, ...report.baseline };
      for (const key of ["rows", "exports", "hits"] as const)
        (report[key] as unknown[]).unshift(...(earlier[key] as unknown[]));
    }
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(REPORT_DIR, "g7-mcp-host.md"), markdown());
  }
});

const call = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; refused?: string }> => {
  try {
    return { result: (await client.callTool({ name, arguments: args })) as Record<string, unknown> };
  } catch (error) {
    return { refused: String((error as Error).message).slice(0, 160) };
  }
};

async function openHost(
  browser: Browser,
  key: string,
  html: string,
  cspMode: CspMode,
  sandbox: string,
): Promise<{ context: BrowserContext; host: SandboxHost; detectors: HostDetectors }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const detectors = await HostDetectors.arm(context, page, [servers.hostOrigin, servers.proxyOrigin]);
  const host = await SandboxHost.open(page, servers, {
    key,
    html,
    csp: served.csp,
    cspMode,
    sandbox,
    callTool: (params) => client.callTool(params),
  });
  await page.waitForTimeout(500);
  // The app's own start-up, before any content reaches it: zod v4 (inside the ext-apps SDK) probes eval with
  // `try { Function("") } catch {}` and the policy refuses it. Reported as a baseline, not as a content hit.
  const own = detectors.hits.filter(
    (h) => h.where === "start" && h.detector === "csp" && h.detail.startsWith("script-src eval "),
  );
  for (const h of own) detectors.hits.splice(detectors.hits.indexOf(h), 1);
  report.baseline[key] = own.map((h) => h.detail);
  return { context, host, detectors };
}

let unsettled = 0;
const DRAWN = ".react-flow__node, .archer-seq-viewport, .archer-journey-el";
const fingerprint = (view: Frame): Promise<string> =>
  view
    .evaluate(
      () =>
        `${document.body.innerText.length}:${document.body.innerText.slice(0, 400)}:${document.querySelectorAll("*").length}`,
    )
    .catch(() => "");

/** Hands the view one tool result, waits for it to change and settle, opens what it drew, runs every detector. */
async function deliver(
  host: SandboxHost,
  detectors: HostDetectors,
  config: string,
  id: string,
  surface: string,
  payloadFamily: string,
  result: Record<string, unknown>,
  needle?: string,
): Promise<Row> {
  detectors.at(`${config} ${id}`);
  host.at(`${config} ${id}`);
  if (process.env.G7_DEBUG) console.log(`[g7] ${config} ${id}`);
  const view = host.view();
  const before = await fingerprint(view);
  // The heading the view gives the drawing of the view this result presents (McpApp's h1, from what is drawn). A
  // turn to another view keeps the previous drawing up, then shows "Loading...", then draws the new one: drawn nodes
  // and a changed page alone also match the previous view's drawing, and the read that follows can land on the
  // loading state between ("nothing drawn" for a view that draws). A result that presents nothing new (emphasis)
  // names no view, and its own drawing is the one already up.
  const presented = (
    (result.structuredContent ?? (result._meta as Record<string, unknown> | undefined)?.["archer/ui"]) as
      | { envelope?: { view?: { title?: unknown } } }
      | undefined
  )?.envelope?.view?.title;
  const heading = typeof presented === "string" ? `${presented}, Archer Diagram` : null;
  await host.toolResult(result);
  // A view that stopped answering (as the seeded resource's clobbered app does) gets a short wait from then on.
  const timeout = unsettled >= 2 ? 2_000 : 15_000;
  const drawnOrRefused = await view
    .waitForFunction(
      ({ sel, before, heading }) =>
        ((document.querySelectorAll(sel).length > 0 &&
          (heading === null || document.querySelector(".archer-mcp-shell > h1")?.textContent === heading)) ||
          document.querySelector(".archer-compile-notice") !== null) &&
        `${document.body.innerText.length}:${document.body.innerText.slice(0, 400)}:${document.querySelectorAll("*").length}` !==
          before,
      { sel: DRAWN, before, heading },
      { timeout, polling: 50 },
    )
    .then(
      () => true,
      () => false,
    );
  const state = await view
    .evaluate(
      (sel) => ({
        drawn: document.querySelectorAll(sel).length,
        notice: document.querySelector(".archer-compile-notice") !== null,
      }),
      DRAWN,
    )
    .catch(() => ({ drawn: 0, notice: false }));
  if (!drawnOrRefused) {
    unsettled++;
    if (process.env.G7_DEBUG)
      console.log(
        `[g7] ${id}: no settle`,
        JSON.stringify(state),
        (await fingerprint(view)) === before ? "unchanged" : "changed",
      );
  }
  if (state.drawn > 0 || state.notice) unsettled = 0;
  // What it drew, at rest (laid out, framed, camera still) before it is opened and scanned: the app says when.
  if (drawnOrRefused) await settled(view, { timeout: 5_000 }).catch(() => {});
  // Open what was drawn: in Select mode a click on a node selects it, shows its details (labels, descriptions)
  // and publishes the selection through the bridge (ui/update-model-context and tools/call set_selection).
  await view
    .getByRole("button", { name: "Select mode", exact: true })
    .click({ timeout: 1000 })
    .catch(() => {});
  let nodesClicked = 0;
  const nodes = view.locator(".react-flow__node");
  const n = Math.min(await nodes.count(), 8);
  for (let i = 0; i < n; i++)
    if (
      await nodes
        .nth(i)
        .click({ timeout: 1500, force: true })
        .then(
          () => true,
          () => false,
        )
    )
      nodesClicked++;
  const text = await view.evaluate(() => document.body.innerText).catch(() => "");
  const armed = await detectors.scan(view, OWNED);
  const links = await detectors.clickLinks(view, OWNED);
  const row: Row = {
    config,
    case: id,
    surface,
    payloadFamily,
    outcome: result.isError
      ? "tool error"
      : state.notice && state.drawn === 0
        ? "refused (compile notice)"
        : state.drawn > 0
          ? "drawn"
          : "nothing drawn",
    drawn: state.drawn,
    hostileTextShown: /__xss|alert\(|onerror|javascript:/i.test(text),
    ...(needle === undefined ? {} : { payloadShown: text.includes(needle) }),
    links,
    nodesClicked,
    armed,
    hits: detectors.counts((h) => h.where === `${config} ${id}`),
  };
  return row;
}

const zero = Object.fromEntries(DETECTORS.map((d) => [d, 0]));

test("positive control A: the resource with its CSP stripped and a seeded script trips every script detector", async ({
  browser,
}) => {
  const { context, host, detectors } = await openHost(
    browser,
    "pc-a",
    seed(served.html),
    "none",
    "allow-scripts allow-same-origin",
  );
  try {
    detectors.at("pc-a");
    host.at("pc-a");
    const view = host.view();
    await expect.poll(() => detectors.counts().dialog, { message: describeHits(detectors.hits) }).toBeGreaterThan(0);
    const armed = await detectors.scan(view, OWNED);
    await detectors.clickLinks(view, OWNED);
    await expect
      .poll(() => detectors.hits.some((h) => h.detector === "canary" && h.detail.includes("seeded-click")), {
        message: describeHits(detectors.hits),
      })
      .toBe(true);
    // Last, as it takes the view away: the frame sent to the canary host.
    await view
      .evaluate(() => {
        location.href = "https://xss-canary.invalid/seeded-nav";
      })
      .catch(() => {});
    await expect
      .poll(() => detectors.counts().navigation, { message: describeHits(detectors.hits) })
      .toBeGreaterThan(0);
    const counts = detectors.counts();
    report.positiveControls["A: CSP stripped + seeded script"] = {
      config: "cspMode none, sandbox allow-scripts allow-same-origin, served bundle + SEEDED",
      armed,
      counts,
      hits: detectors.hits,
    };
    for (const d of DETECTORS.filter((x) => x !== "csp"))
      expect(counts[d], `${d} must trip\n${describeHits(detectors.hits)}`).toBeGreaterThan(0);
    expect(counts.csp, "no policy, so no violation").toBe(0);
  } finally {
    await context.close();
  }
});

test("positive control B: a planted unsanitised sink in the real app, under its declared CSP, trips all seven", async ({
  browser,
}) => {
  const { context, host, detectors } = await openHost(
    browser,
    "pc-b",
    served.html,
    "header",
    "allow-scripts allow-same-origin",
  );
  try {
    const present = await call("present_diagram", { viewId: "flow-inert", outputFormat: "json" });
    const clean = await deliver(
      host,
      detectors,
      "pc-b",
      "flow-inert (before the plant)",
      "present_diagram",
      "mermaid labels (flowchart)",
      present.result!,
    );
    expect(clean.hits, describeHits(detectors.hits)).toEqual(zero);
    detectors.at("pc-b planted");
    host.at("pc-b planted");
    const view = host.view();
    // The corpus's own label, given to innerHTML unsanitised, plus a link, a clobbering id and a remote image.
    const label = readFileSync(resolve(CORPUS_DIR, "project/.archer/diagrams/flow-inert.mmd"), "utf8").match(
      /<img src=x onerror=window\.__xss='fu'/,
    )![0];
    await view.evaluate((l) => {
      document
        .querySelector(".archer-mcp-shell")!
        .insertAdjacentHTML(
          "beforeend",
          `<div>${l}></div><img src=x onerror="alert('planted-alert')"><a id="__archerTelemetry" href="javascript:window.__xss='planted-click'">planted</a>` +
            `<img src="https://xss-canary.invalid/planted-csp.png">`,
        );
    }, label);
    await expect.poll(() => detectors.counts().canary, { message: describeHits(detectors.hits) }).toBeGreaterThan(0);
    await expect.poll(() => detectors.counts().csp, { message: describeHits(detectors.hits) }).toBeGreaterThan(0);
    const armed = await detectors.scan(view, OWNED);
    await detectors.clickLinks(view, OWNED);
    await view
      .evaluate(() => {
        document.body.insertAdjacentHTML(
          "beforeend",
          `<img src=x onerror="location.href='https://xss-canary.invalid/planted-nav'">`,
        );
      })
      .catch(() => {});
    await expect
      .poll(() => detectors.counts().navigation, { message: describeHits(detectors.hits) })
      .toBeGreaterThan(0);
    const counts = detectors.counts();
    report.positiveControls["B: declared CSP (header) + planted sink in the app"] = {
      config: "cspMode header, sandbox allow-scripts allow-same-origin, served bundle",
      armed,
      counts,
      hits: detectors.hits,
    };
    // The planted navigation is stopped by the proxy's frame-src 'none' before a request leaves (the policy
    // working): request is control A's to prove. Together the two controls trip all seven.
    for (const d of DETECTORS.filter((x) => x !== "request"))
      expect(counts[d], `${d} must trip\n${describeHits(detectors.hits)}`).toBeGreaterThan(0);
    const a = (
      report.positiveControls["A: CSP stripped + seeded script"] as { counts: Record<Detector, number> } | undefined
    )?.counts;
    if (a !== undefined)
      expect(
        DETECTORS.filter((d) => a[d] + counts[d] === 0),
        "detectors neither control tripped",
      ).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const config of CONFIGS)
  test(`hostile corpus through the app resource, host ${config.id}${SEED_FAIL ? " (SEEDED: must fail)" : ""}`, async ({
    browser,
  }) => {
    const bundle = config.bundle === "served" ? served.html : readFileSync(PACKAGED, "utf8");
    const html = SEED_FAIL ? seed(bundle) : bundle;
    const { context, host, detectors } = await openHost(browser, config.id, html, config.cspMode, config.sandbox);
    const rows: Row[] = [];
    unsettled = 0;
    try {
      const family = (id: string, kind: string): string =>
        id === "flow-directives"
          ? "%%{init}%% / click / href directives"
          : id === "flow-styles"
            ? "style url() and classDef"
            : id.endsWith("-refused")
              ? `refused constructs (${kind})`
              : `mermaid labels (${kind})${id === "flow-inert" ? " + archer.toml title + %% description" : ""}`;
      for (const v of views) {
        const r = await call("present_diagram", { viewId: v.id, outputFormat: "json" });
        if (r.refused !== undefined) {
          rows.push({
            config: config.id,
            case: v.id,
            surface: "present_diagram",
            payloadFamily: family(v.id, v.kind),
            outcome: `refused by tool: ${r.refused}`,
            drawn: 0,
            hostileTextShown: false,
            links: 0,
            nodesClicked: 0,
            armed: true,
            hits: { ...zero } as Row["hits"],
          });
          continue;
        }
        rows.push(await deliver(host, detectors, config.id, v.id, "present_diagram", family(v.id, v.kind), r.result!));
      }
      // The text output format: the view's data rides in _meta["archer/ui"], not structuredContent.
      const asText = await call("present_diagram", { viewId: "flow-inert", outputFormat: "text" });
      rows.push(
        await deliver(
          host,
          detectors,
          config.id,
          "flow-inert (outputFormat text)",
          "present_diagram _meta",
          family("flow-inert", "freeform"),
          asText.result!,
        ),
      );
      for (const e of embedded) {
        const r = await call("present_diagram", { viewId: e.address, outputFormat: "json" });
        if (r.refused !== undefined) {
          rows.push({
            config: config.id,
            case: e.address,
            surface: "present_diagram",
            payloadFamily: `note-embedded figure (${e.kind})`,
            outcome: `refused by tool: ${r.refused}`,
            drawn: 0,
            hostileTextShown: false,
            links: 0,
            nodesClicked: 0,
            armed: true,
            hits: { ...zero } as Row["hits"],
          });
          continue;
        }
        rows.push(
          await deliver(
            host,
            detectors,
            config.id,
            e.address,
            "present_diagram",
            `note-embedded figure (${e.kind})`,
            r.result!,
          ),
        );
      }
      // Agent-written text the view draws: the comment corpus as the caption, and as emphasis title and labels.
      for (const [i, body] of COMMENTS.entries()) {
        const r = await call("present_diagram", { viewId: "flow-inert", annotation: body, outputFormat: "json" });
        if (r.refused !== undefined) {
          rows.push({
            config: config.id,
            case: `caption ${i}`,
            surface: "present_diagram annotation",
            payloadFamily: "comment body as caption",
            outcome: `refused by tool: ${r.refused}`,
            drawn: 0,
            hostileTextShown: false,
            links: 0,
            nodesClicked: 0,
            armed: true,
            hits: { ...zero } as Row["hits"],
          });
          continue;
        }
        rows.push(
          await deliver(
            host,
            detectors,
            config.id,
            `caption ${i}`,
            "present_diagram annotation",
            "comment body as caption",
            r.result!,
            body,
          ),
        );
      }
      for (const [i, body] of COMMENTS.entries()) {
        const r = await call("set_emphasis", {
          viewId: "flow-inert",
          id: `hostile-${i}`,
          title: body.slice(0, 40),
          outputFormat: "json",
          groups: [
            {
              id: "g",
              style: "highlight",
              label: body.slice(0, 24),
              description: body.slice(0, 120),
              nodes: ["root", "location"],
              edges: [],
            },
          ],
        });
        if (r.refused !== undefined) {
          rows.push({
            config: config.id,
            case: `emphasis ${i}`,
            surface: "set_emphasis",
            payloadFamily: "comment body as emphasis title/label/description",
            outcome: `refused by tool: ${r.refused}`,
            drawn: 0,
            hostileTextShown: false,
            links: 0,
            nodesClicked: 0,
            armed: true,
            hits: { ...zero } as Row["hits"],
          });
          continue;
        }
        rows.push(
          await deliver(
            host,
            detectors,
            config.id,
            `emphasis ${i}`,
            "set_emphasis",
            "comment body as emphasis title/label/description",
            r.result!,
            body.slice(0, 40).trim(),
          ),
        );
      }
      // The host's tool-input notification, with hostile arguments, then a forged tool result built from the corpus.
      detectors.at(`${config.id} tool-input`);
      host.at(`${config.id} tool-input`);
      await host.toolInput({ viewId: COMMENTS[0], annotation: COMMENTS[1], emphasis: { id: COMMENTS[2], groups: [] } });
      await host.page.waitForTimeout(500);
      await detectors.scan(host.view(), OWNED);
      rows.push({
        config: config.id,
        case: "tool-input",
        surface: "ui/notifications/tool-input",
        payloadFamily: "hostile tool arguments",
        outcome: "delivered",
        drawn: 0,
        hostileTextShown: false,
        links: 0,
        nodesClicked: 0,
        armed: true,
        hits: detectors.counts((h) => h.where === `${config.id} tool-input`),
      });

      const total = detectors.counts();
      // This host's own control, after the matrix: the same planted sink as control B, in this configuration's
      // frame, so its zero is backed by detectors shown to see into it.
      const control = `${config.id} control`;
      detectors.at(control);
      host.at(control);
      await host.view().evaluate(() => {
        // The body if the app has unmounted (the seeded run's clobbered app does).
        (document.querySelector(".archer-mcp-shell") ?? document.body).insertAdjacentHTML(
          "beforeend",
          `<img src=x onerror="window.__xss='control-onerror';alert('control-alert')"><a id="__archerTelemetry" href="#">c</a><img src="https://xss-canary.invalid/control.png">`,
        );
      });
      await expect
        .poll(() => detectors.counts((h) => h.where === control).dialog, { message: describeHits(detectors.hits) })
        .toBeGreaterThan(0);
      await detectors.scan(host.view(), OWNED);
      const controlCounts = detectors.counts((h) => h.where === control);
      report.configs[config.id] = {
        ...config,
        seeded: SEED_FAIL,
        policy: config.cspMode === "none" ? null : resourcePolicy(served.csp),
        total,
        control: controlCounts,
        hostEvents: summarise(host.events.map((e) => e.kind)),
        openLinks: host.events.filter((e) => e.kind === "open-link").map((e) => e.detail),
      };
      report.rows.push(...rows);
      report.hits.push(...detectors.hits.filter((h) => h.where !== control).map((h) => ({ config: config.id, ...h })));
      test.info().annotations.push({ type: "counts", description: JSON.stringify(total) });
      // The corpus still exercises both paths in this host: inert diagrams drawn, refused ones refused.
      const outcome = (id: string) => rows.find((r) => r.case === id)?.outcome;
      // A view that never compiled is refused by the tool, so nothing reaches the view; one with a last good
      // drawing would show the compile notice. Either is "refused as designed".
      for (const v of views)
        expect(outcome(v.id), `${v.id} in ${config.id}`).toMatch(
          v.id.endsWith("-refused") || v.id === "flow-styles"
            ? /^refused (by tool: MCP error -32002|\(compile notice\))/
            : /^drawn$/,
        );
      const hostile = rows.filter(
        (r) => r.surface === "present_diagram" && (r.case.endsWith("-inert") || r.case.startsWith("notes/figures.md#")),
      );
      expect(
        hostile.filter((r) => r.outcome !== "drawn" || !r.hostileTextShown).map((r) => r.case),
        "hostile labels are on screen as text",
      ).toEqual([]);
      expect(
        rows
          .filter((r) => r.surface === "present_diagram annotation" && r.outcome === "drawn" && r.payloadShown !== true)
          .map((r) => r.case),
        "each caption is on screen as text",
      ).toEqual([]);
      for (const d of ["canary", "dialog", "csp", "sink", "clobber"] as const)
        expect(controlCounts[d], `${config.id} control: ${d} must trip`).toBeGreaterThan(0);
      expect(total, describeHits(detectors.hits.filter((h) => h.where !== control))).toEqual(zero);
    } finally {
      await context.close();
    }
  });

test("the SVG export through MCP export_diagram, shown as a host shows it, is inert", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const detectors = await HostDetectors.arm(context, page, [servers.hostOrigin, servers.proxyOrigin]);
  try {
    await page.goto(`${servers.hostOrigin}/`);
    const inert = views.filter((v) => v.id.endsWith("-inert") || v.id === "flow-directives");
    for (const v of inert) {
      const r = await call("export_diagram", { viewId: v.id, format: "svg", outputFormat: "json" });
      const data = (r.result?.structuredContent as { data?: string; encoding?: string } | undefined)?.data;
      expect(data, `export ${v.id}: ${r.refused ?? ""}`).toBeDefined();
      const svg = Buffer.from(data!, "base64").toString("utf8");
      if (v.id !== "flow-directives") expect(svg, `export ${v.id} holds its labels`).toMatch(/__xss|alert\(/);
      const raw = servers.serve("b", `/raw/${v.id}.svg`, { body: svg, type: "image/svg+xml" });
      // 1. As an image content block: <img>.  2. The markup inline in a sandboxed srcdoc frame with no CSP.
      // 3. The file in a sandboxed frame.  4. The file opened in its own tab (a download opened), no sandbox.
      for (const mode of ["img", "inline", "frame", "tab"] as const) {
        const where = `export ${v.id} ${mode}`;
        detectors.at(where);
        let frame: Frame | undefined;
        if (mode === "tab") {
          const tab = await detectors.newPage(context);
          await tab.goto(raw);
          await tab.waitForTimeout(300);
          await detectors.scan(tab.mainFrame());
          await detectors.clickLinks(tab.mainFrame());
          await tab.close();
        } else {
          await page.evaluate(
            ({ mode, svg, raw }) => {
              document.querySelectorAll(".export").forEach((e) => e.remove());
              if (mode === "img") {
                const img = document.createElement("img");
                img.className = "export";
                img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
                document.body.append(img);
                return;
              }
              const f = document.createElement("iframe");
              f.className = "export";
              f.setAttribute("sandbox", "allow-scripts allow-same-origin");
              if (mode === "inline") f.srcdoc = `<!doctype html><body>${svg}</body>`;
              else f.src = raw;
              document.body.append(f);
            },
            { mode, svg, raw },
          );
          await page.waitForTimeout(400);
          frame =
            mode === "img"
              ? page.mainFrame()
              : page.frames().find((f) => f !== page.mainFrame() && (f.url() === "about:srcdoc" || f.url() === raw));
          if (frame !== undefined) {
            await detectors.scan(frame, mode === "img" ? {} : {});
            await detectors.clickLinks(frame);
          }
        }
        report.exports.push({
          config: "host page",
          case: `${v.id} ${mode}`,
          surface: "export_diagram svg",
          payloadFamily: `exported labels (${v.kind})`,
          outcome: mode === "tab" || frame !== undefined ? "rendered" : "no frame",
          drawn: 0,
          hostileTextShown: true,
          links: 0,
          nodesClicked: 0,
          armed: true,
          hits: detectors.counts((h) => h.where === where),
        });
      }
    }
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero);
  } finally {
    report.hits.push(...detectors.hits.map((h) => ({ config: "exports", ...h })));
    await context.close();
  }
});

function summarise(kinds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of kinds) out[k] = (out[k] ?? 0) + 1;
  return out;
}

function markdown(): string {
  const head = `| config | case | surface | payload family | outcome | drawn | hostile text shown | this payload shown | nodes clicked | links | armed | ${DETECTORS.join(" | ")} |\n|${"---|".repeat(11 + DETECTORS.length)}\n`;
  const line = (r: Row) =>
    `| ${r.config} | ${r.case} | ${r.surface} | ${r.payloadFamily} | ${r.outcome.replace(/\|/g, "/")} | ${r.drawn} | ${r.hostileTextShown ? "yes" : "no"} | ${r.payloadShown === undefined ? "—" : r.payloadShown ? "yes" : "no"} | ${r.nodesClicked} | ${r.links} | ${r.armed ? "yes" : "NO"} | ${DETECTORS.map((d) => r.hits[d]).join(" | ")} |`;
  const pcs = Object.entries(report.positiveControls)
    .map(
      ([k, v]) =>
        `- **${k}**: ${JSON.stringify((v as { counts: unknown }).counts)} (armed: ${(v as { armed: boolean }).armed})`,
    )
    .join("\n");
  const configs = Object.entries(report.configs)
    .map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`)
    .join("\n");
  return `# G7 in an MCP Apps host: hostile corpus × app resource × detectors\n\nSandbox ${report.sandbox}${SEED_FAIL ? " — **SEEDED RUN (G7_SEED_FAIL=1): hits expected**" : ""}.\n\nResource: \`${JSON.stringify(report.resource)}\`\n\nPolicy built from \`_meta.ui.csp\`: \`${report.policy}\`\n\nBaseline (the app's own start-up, before content; not counted as content hits): \`${JSON.stringify(report.baseline)}\`\n\n## Positive controls\n\n${pcs}\n\n## Host configurations\n\n${configs}\n\n## Matrix\n\n${head}${report.rows.map(line).join("\n")}\n\n## SVG export\n\n${head}${report.exports.map(line).join("\n")}\n\n## Hits\n\n${report.hits.length === 0 ? "(none)" : report.hits.map((h) => `- ${JSON.stringify(h)}`).join("\n")}\n`;
}
