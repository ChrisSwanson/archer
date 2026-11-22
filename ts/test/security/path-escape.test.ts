// G6 / P5 (docs/quality/rubrics/security.md): effects stay where contracted. Every path-taking HTTP
// route, application operation (the one registry MCP, the CLI and the page's operations call) and
// management-socket method is driven with the P5 payloads against a canary that lives in the test's
// temporary root, OUTSIDE the project. The predicate (ADR 0018 confined reads, ADR 0028 writes):
//   - no response carries the canary's bytes (raw, URL-decoded or inside base64) or its revision;
//   - every file outside the project keeps its hash, and no file appears outside the project.
// The detector is shown working on a seeded unconfined reader and writer (they must trip it) and a
// seeded confined reader (it must not), in this file, before any product row is scored.
//
// A product defect is recorded with `test.fails` and a comment naming G6 and the cause (KNOWN below),
// so the suite stays green and goes red the day the defect is fixed. None is open since round 1.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  chmodSync,
  closeSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { TOOLS } from "../../src/application/tools.ts";
import { AGENT_METHODS } from "../../src/agents/contract.ts";
import { initProject } from "../../src/project/index.ts";
import { descriptorConfinement } from "../../src/project/confined-fs.ts";
import { connectService, type ServiceClient } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, http, service, slugOf, tempDir, type Reply, pageHttp } from "../service/support.ts";

// ------------------------------------------------------------------ the canary and the layout

const MARK = `g6canary${randomBytes(12).toString("hex")}`;
/** One inode, three names (canary.md, canary.mmd, canary): a note with an embedded block, so every reader has something to return. */
const CANARY = `# ${MARK}\n\n${MARK} passage.\n\n\`\`\`mermaid\n%% archer-id: d\nflowchart LR\n  a[${MARK}] e1@--> b[B]\n\`\`\`\n`;
const FLOW = "flowchart LR\n  a[Client] e1@--> b[API]\n";
const NOTE = (title: string) =>
  `---\nauthor: agent\n---\n# ${title}\n\nHello passage text.\n\n\`\`\`mermaid\n%% archer-id: d\nflowchart LR\n  a[A] e1@--> b[B]\n\`\`\`\n`;

let T = ""; // the temporary root: everything outside `proj` here is outside the project
let OUT = ""; // T/outside: the canary family and the decoys
let PROJ = ""; // T/proj: the attached project
let STATE = ""; // the service's state directory (also outside the project; excluded from the outside snapshot)
let CANARY_PATH = "";
let CANARY_SHA = "";
let SECRETS: readonly string[] = []; // the strings whose presence in a response is a read escape

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under T outside the project and the state directory, by path, with its hash. */
function outsideSnapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === PROJ || path === STATE) continue;
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isSymbolicLink()) files.set(path, `link:${path}`);
      else if (entry.isFile()) files.set(path, sha(readFileSync(path)));
    }
  };
  walk(T, 0);
  return files;
}

// ------------------------------------------------------------------ the detector

interface Hit {
  readonly op: string;
  readonly family: string;
  readonly payload: string;
  readonly kind: "bytes" | "revision" | "changed" | "created" | "removed";
  readonly where: string;
}

/** Which secret forms `text` carries: raw, after URL-decoding, or inside a base64 run (export bytes). */
function leaked(text: string): ("bytes" | "revision")[] {
  const found = new Set<"bytes" | "revision">();
  const check = (t: string) => {
    if (t.includes(MARK)) found.add("bytes");
    if (SECRETS.some((s) => s !== MARK && t.includes(s))) found.add("revision");
  };
  check(text);
  try {
    check(decodeURIComponent(text));
  } catch {
    /* not URL-encoded */
  }
  for (const run of text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []) check(Buffer.from(run, "base64").toString("latin1"));
  return [...found];
}

/** Runs `effect`, then reports what it read or changed outside the project. Repairs what it changed, so the next case starts clean. */
async function observe(op: string, family: string, payload: string, effect: () => Promise<string>): Promise<Hit[]> {
  const before = outsideSnapshot();
  let text: string;
  try {
    text = await effect();
  } catch (error) {
    text = describeError(error);
  }
  const hits: Hit[] = leaked(text).map((kind) => ({ op, family, payload, kind, where: "response" }));
  const after = outsideSnapshot();
  for (const [path, hash] of after) {
    const was = before.get(path);
    if (was === undefined) {
      hits.push({ op, family, payload, kind: "created", where: relative(T, path) });
      rmSync(path, { force: true });
    } else if (was !== hash) hits.push({ op, family, payload, kind: "changed", where: relative(T, path) });
  }
  for (const path of before.keys())
    if (!after.has(path)) hits.push({ op, family, payload, kind: "removed", where: relative(T, path) });
  if (hits.some((h) => h.kind === "changed" || h.kind === "removed")) restoreOutside();
  return hits;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const data =
      (error as { data?: unknown; error?: unknown; details?: unknown }).data ??
      (error as { error?: unknown }).error ??
      (error as { details?: unknown }).details;
    return `${error.name}: ${error.message} ${JSON.stringify(data ?? null)}`;
  }
  return String(error);
}

// ------------------------------------------------------------------ payloads (P5)

interface Payload {
  readonly family: Family;
  readonly value: string;
}
type Family = "traversal" | "encoded" | "backslash" | "overlong" | "absolute" | "nul" | "symlink" | "hardlink";
const STATIC_FAMILIES: readonly Family[] = [
  "traversal",
  "encoded",
  "backslash",
  "overlong",
  "absolute",
  "nul",
  "symlink",
  "hardlink",
];

/**
 * The P5 payloads for one argument. `up` is how many `..` lead from the argument's base to T (2 from the
 * Archer folder, 1 from the project root), `links` the prefix of the in-project link folder from that base,
 * `ext` the canary name's extension (".md", ".mmd" or "").
 */
function payloads(up: number, links: string, ext: string): Payload[] {
  const dots = "../".repeat(up),
    name = `outside/canary${ext}`;
  const abs = CANARY_PATH.replace(/\.md$/, ext);
  return [
    { family: "traversal", value: `${dots}${name}` },
    { family: "traversal", value: `notes/../${dots}${name}` },
    { family: "traversal", value: `${"../".repeat(16)}${abs.slice(1)}` },
    { family: "encoded", value: `${"..%2f".repeat(up)}outside%2fcanary${ext}` },
    { family: "encoded", value: `${"%2e%2e%2f".repeat(up)}outside%2fcanary${ext}` },
    { family: "encoded", value: `${"%252e%252e%252f".repeat(up)}outside%252fcanary${ext}` },
    { family: "backslash", value: `${"..\\".repeat(up)}outside\\canary${ext}` },
    { family: "backslash", value: `${"..%5c".repeat(up)}outside%5ccanary${ext}` },
    { family: "overlong", value: `${"%c0%ae%c0%ae%c0%af".repeat(up)}outside%c0%afcanary${ext}` },
    { family: "overlong", value: `${"À®À®/".repeat(up)}outside/canary${ext}` },
    { family: "overlong", value: `${"．．／".repeat(up)}outside／canary${ext}` },
    { family: "absolute", value: abs },
    { family: "absolute", value: `file://${abs}` },
    { family: "absolute", value: `/${abs}` },
    { family: "nul", value: `notes/a.md\u0000/${dots}${name}` },
    { family: "nul", value: `${dots}${name}\u0000.md` },
    { family: "nul", value: `${dots}${name}%00` },
    { family: "symlink", value: `${links}links/sym${ext}` },
    { family: "symlink", value: `${links}linkdir/canary${ext}` },
    { family: "hardlink", value: `${links}links/hard${ext}` },
  ];
}
/** Archer-folder-relative note paths, standalone diagram paths, and `<note>#d` embedded addresses. */
const notePaths = () => payloads(2, "", ".md");
const diagramPaths = () => [...payloads(2, "", ".mmd"), ...payloads(2, "", "")];
const viewIds = () => [...diagramPaths(), ...notePaths().map((p) => ({ ...p, value: `${p.value}#d` }))];
const projectPaths = () => payloads(1, ".archer/", ".md");

// ------------------------------------------------------------------ fixture

let svc: { socketPath: string; homeUrl: string } | undefined;
let client: ServiceClient | undefined;
let app: Application | undefined;
let base = ""; // the project's API root under the owner (service) token
let origin = "";
let cookie = ""; // an ordinary access link's cookie: it may edit (ADR 0028 amended 2026-10-28)
let slug = "";
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(cwd) },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function restoreOutside(): void {
  writeFileSync(CANARY_PATH, CANARY);
  for (const [path, text] of DECOYS()) writeFileSync(path, text);
}
/** Decoys outside: byte-identical to the in-project file a link or a swapped parent makes them stand in for. */
const DECOYS = (): [string, string][] => [
  [join(OUT, "dir2/t.md"), NOTE("Sub")],
  [join(OUT, "dir2/v.mmd"), FLOW],
  [join(OUT, "w.mmd"), FLOW],
  [join(OUT, "hw.mmd"), FLOW],
  [join(OUT, "wdir/race.md"), NOTE("Race")],
];

beforeAll(async () => {
  T = tempDir("archer-g6-");
  OUT = join(T, "outside");
  PROJ = join(T, "proj");
  STATE = join(T, "state");
  mkdirSync(STATE, { mode: 0o700 }); // a state directory Archer is pointed at must be private (R4)
  // The process-wide write policy and settings read the account file: point every reader at the test's own.
  for (const key of ["HOME", "XDG_CONFIG_HOME", "ARCHER_CONFIG"]) savedEnv[key] = process.env[key];
  process.env["HOME"] = STATE;
  process.env["XDG_CONFIG_HOME"] = join(STATE, ".config");
  process.env["ARCHER_CONFIG"] = join(STATE, "account.archer.toml");
  writeFileSync(join(STATE, "account.archer.toml"), "version = 1\n");

  CANARY_PATH = join(OUT, "canary.md");
  put(CANARY_PATH, CANARY);
  linkSync(CANARY_PATH, join(OUT, "canary.mmd"));
  linkSync(CANARY_PATH, join(OUT, "canary"));
  mkdirSync(join(OUT, "rdir"));
  linkSync(CANARY_PATH, join(OUT, "rdir/race.md"));
  for (const [path, text] of DECOYS()) put(path, text);
  const bytes = Buffer.from(CANARY);
  CANARY_SHA = sha(bytes);
  SECRETS = [MARK, CANARY_SHA];

  put(
    join(PROJ, "archer.toml"),
    'version = 1\nname = "g6"\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
  );
  put(join(PROJ, ".archer/flow.mmd"), FLOW);
  put(join(PROJ, ".archer/notes/a.md"), NOTE("A"));
  put(join(PROJ, ".archer/notes/sub/t.md"), NOTE("Sub"));
  put(join(PROJ, ".archer/diagrams/sub/v.mmd"), FLOW);
  put(join(PROJ, ".archer/diagrams/reg.mmd"), FLOW);
  put(join(PROJ, ".archer/notes/race.md"), NOTE("Race"));
  put(join(PROJ, ".archer/notes/racedir/race.md"), NOTE("Race"));
  put(join(PROJ, ".archer/notes/racewdir/race.md"), NOTE("Race"));
  mkdirSync(join(PROJ, ".archer/links"));
  symlinkSync(CANARY_PATH, join(PROJ, ".archer/links/sym.md"));
  symlinkSync(join(OUT, "canary.mmd"), join(PROJ, ".archer/links/sym.mmd"));
  symlinkSync(join(OUT, "canary"), join(PROJ, ".archer/links/sym"));
  symlinkSync(OUT, join(PROJ, ".archer/linkdir"));
  // Hard links are made after the git commit (git would store a copy), as an archive or a local `ln` makes them.
  git(PROJ, "init", "-q");
  git(PROJ, "add", "-A");
  git(PROJ, "commit", "-qm", "init");
  linkSync(CANARY_PATH, join(PROJ, ".archer/links/hard.md"));
  linkSync(CANARY_PATH, join(PROJ, ".archer/links/hard.mmd"));
  linkSync(CANARY_PATH, join(PROJ, ".archer/links/hard"));
  // Write targets: a symlinked and a hard-linked standalone diagram whose outside bytes equal a valid diagram.
  symlinkSync(join(OUT, "w.mmd"), join(PROJ, ".archer/diagrams/symw.mmd"));
  linkSync(join(OUT, "hw.mmd"), join(PROJ, ".archer/diagrams/hardw.mmd"));

  const started = await service({
    stateDir: STATE,
    env: { HOME: STATE, XDG_CONFIG_HOME: join(STATE, ".config"), ARCHER_CONFIG: join(STATE, "account.archer.toml") },
  });
  svc = started.svc;
  client = await connectService(svc.socketPath);
  const attached = await client.call("attach", { root: PROJ });
  base = apiBase(attached.url);
  origin = new URL(attached.url).origin;
  slug = slugOf(attached.url);
  const link = await client.call("issueAccess", { label: "g6" });
  const exchange = await pageHttp(link.url);
  cookie = ((exchange.headers["set-cookie"] as string[] | undefined)?.[0] ?? "").split(";")[0] ?? "";
  const socketPath = svc.socketPath;
  app = createApplication({
    cwd: PROJ,
    ensureService: () => connectService(socketPath),
    findService: () => connectService(socketPath),
    env: { HOME: STATE, XDG_CONFIG_HOME: join(STATE, ".config"), ARCHER_CONFIG: join(STATE, "account.archer.toml") },
  });
}, 60_000);

afterAll(async () => {
  client?.close();
  app?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanUp();
});

// ------------------------------------------------------------------ surfaces

const appCall = async (name: string, args: Record<string, unknown>): Promise<string> =>
  JSON.stringify(await app!.call(name, args));
const reply = (r: Reply) => `${r.status} ${JSON.stringify(r.headers)} ${r.body}`;
const get = async (path: string) => reply(await pageHttp(`${base}${path}`));
const post = async (path: string, body: unknown, method = "POST") =>
  reply(
    await pageHttp(`${base}${path}`, {
      method,
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const authoringBase = () => `${origin}/p/${slug}/api/authoring`;
const authoring = async (path: string, body: unknown) => {
  const generation = JSON.parse((await pageHttp(authoringBase(), { headers: { cookie } })).body).generation as unknown;
  return reply(
    await pageHttp(authoringBase() + path, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(path === "" ? { ...(body as object), journalGeneration: generation } : body),
    }),
  );
};
const socket = async (method: string, params: Record<string, unknown>) => {
  try {
    return JSON.stringify(
      await (client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call(method, params),
    );
  } catch (error) {
    return describeError(error);
  }
};
const enc = encodeURIComponent;
const ZERO = `sha256:${"0".repeat(64)}`;
/** A write's refusal names the current revision; the second attempt uses it, so a write that reached the file is really tried. */
const REVISION = /sha256:[0-9a-f]{64}/;
async function twoPhase(attempt: (revision: string) => Promise<string>): Promise<string> {
  const first = await attempt(ZERO);
  const named = first.match(REVISION)?.[0];
  return named === undefined || named === ZERO ? first : `${first}\n${await attempt(named)}`;
}
const opId = () => randomBytes(16).toString("hex");

type OpClass = "read" | "write" | "register" | "manifest";
interface Operation {
  readonly name: string;
  readonly surface: "app" | "http" | "socket" | "local" | "seeded";
  readonly class: OpClass;
  readonly payloads: () => Payload[];
  readonly run: (value: string) => Promise<string>;
  /** A valid call that must succeed (proves the operation is really exercised), and text its answer must contain. */
  readonly control?: { readonly value: string; readonly expect: RegExp };
}

const passage = { kind: "passage", quote: "Hello passage text.", prefix: "", suffix: "" };
const GROUPS = [{ id: "g1", label: "x", passages: [passage] }];
const PRODUCT: readonly Operation[] = [
  // ---- application operations (MCP tools, CLI `archer call`, the page's api/operations) ----
  {
    name: "read_note",
    surface: "app",
    class: "read",
    payloads: notePaths,
    run: (v) => appCall("read_note", { notePath: v }),
    control: { value: "notes/a.md", expect: /Hello passage/ },
  },
  {
    name: "read_diagram",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("read_diagram", { viewId: v }),
    control: { value: "notes/a.md#d", expect: /flowchart/ },
  },
  {
    name: "measure_diagram",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("measure_diagram", { viewId: v, states: [{ mode: "full" }] }),
    control: { value: "notes/a.md#d", expect: /"status":"ready"/ },
  },
  {
    name: "measure_diagram candidate",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("measure_diagram", { viewId: v, source: FLOW, states: [{ mode: "full" }] }),
    control: { value: "flow", expect: /^(?=.*"basis":"candidate-source")(?=.*"status":"ready")/s },
  },
  {
    name: "validate_diagram",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("validate_diagram", { viewId: v, source: FLOW }),
    control: { value: "flow", expect: /"valid":true/ },
  },
  {
    name: "export_diagram",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("export_diagram", { viewId: v, format: "svg" }),
    control: { value: "flow", expect: /svg|base64|bytes/i },
  },
  {
    name: "list_walkthroughs",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("list_walkthroughs", { viewId: v }),
    control: { value: "flow", expect: /walkthroughs/ },
  },
  {
    name: "list_emphases",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("list_emphases", { viewId: v }),
    control: { value: "flow", expect: /views|emphas/ },
  },
  {
    name: "list_note_emphases",
    surface: "app",
    class: "read",
    payloads: notePaths,
    run: (v) => appCall("list_note_emphases", { notePath: v }),
    control: { value: "notes/a.md", expect: /revision/ },
  },
  {
    name: "get_comments",
    surface: "app",
    class: "read",
    payloads: () => [
      ...notePaths().map((p) => ({ ...p, value: `note:${p.value}` })),
      ...viewIds().map((p) => ({ ...p, value: `view:${p.value}` })),
    ],
    run: (v) => appCall("get_comments", { target: v }),
    control: { value: "note:notes/a.md", expect: /threads/ },
  },
  {
    name: "read_diagram_at_commit",
    surface: "app",
    class: "read",
    payloads: diagramPaths,
    run: (v) => appCall("read_diagram_at_commit", { viewId: v, commit: "HEAD" }),
    control: { value: "flow", expect: /flowchart/ },
  },
  {
    name: "compare_diagrams",
    surface: "app",
    class: "read",
    payloads: diagramPaths,
    run: (v) => appCall("compare_diagrams", { viewId: v, from: "HEAD", to: "HEAD" }),
    control: { value: "flow", expect: /flow/ },
  },
  {
    name: "list_stale_diagrams",
    surface: "app",
    class: "read",
    payloads: diagramPaths,
    run: (v) => appCall("list_stale_diagrams", { viewId: v }),
    control: { value: "flow", expect: /flow/ },
  },
  {
    name: "get_ui_url",
    surface: "app",
    class: "read",
    payloads: notePaths,
    run: (v) => appCall("get_ui_url", { notePath: v }),
    control: { value: "notes/a.md", expect: /http/ },
  },
  {
    name: "present_diagram",
    surface: "app",
    class: "read",
    payloads: viewIds,
    run: (v) => appCall("present_diagram", { viewId: v }),
    control: { value: "flow", expect: /http/ },
  },
  {
    name: "set_emphasis",
    surface: "app",
    class: "write",
    payloads: viewIds,
    run: (v) => appCall("set_emphasis", { id: "g6", viewId: v, groups: [] }),
    control: { value: "flow", expect: /g6|emphas/ },
  },
  {
    name: "write_diagram",
    surface: "app",
    class: "write",
    payloads: () => [...viewIds(), { family: "symlink", value: "symw" }, { family: "hardlink", value: "hardw" }],
    run: (v) =>
      twoPhase((rev) =>
        appCall("write_diagram", { viewId: v, source: FLOW.replace("API", "API2"), expectedRevision: rev }).catch(
          describeError,
        ),
      ),
    control: { value: "notes/a.md#d", expect: /sourceRevision/ },
  },
  {
    name: "write_walkthrough",
    surface: "app",
    class: "write",
    payloads: viewIds,
    run: (v) =>
      appCall("write_walkthrough", {
        viewId: v,
        walkthrough: { id: "g6", title: "G6", steps: [{ title: "one", elements: ["a"] }] },
      }),
    control: { value: "flow", expect: /./ },
  },
  {
    name: "set_note_emphasis",
    surface: "app",
    class: "write",
    payloads: notePaths,
    run: (v) => appCall("set_note_emphasis", { notePath: v, id: "g6", groups: GROUPS, expectedRevision: 0 }),
    control: { value: "notes/a.md", expect: /revision/ },
  },
  {
    name: "create_comment",
    surface: "app",
    class: "write",
    payloads: () => [
      ...notePaths().map((p) => ({ ...p, value: `note:${p.value}` })),
      ...viewIds().map((p) => ({ ...p, value: `view:${p.value}` })),
    ],
    run: (v) =>
      appCall("create_comment", { target: v, anchor: v.startsWith("note:") ? passage : { kind: "view" }, body: "g6" }),
    control: { value: "view:flow", expect: /threadId|thread/ },
  },
  {
    name: "register_diagram",
    surface: "app",
    class: "register",
    payloads: diagramPaths,
    run: (v) => appCall("register_diagram", { sourcePath: v, viewId: "g6reg" }),
    control: { value: "diagrams/reg.mmd", expect: /g6reg/ },
  },
  {
    name: "register_diagram covers",
    surface: "app",
    class: "register",
    payloads: projectPaths,
    run: async (v) =>
      `${await appCall("register_diagram", { sourcePath: "flow.mmd", viewId: "flow", covers: [v] }).catch(describeError)}\n${await appCall("list_stale_diagrams", { viewId: "flow" }).catch(describeError)}`,
  },
  // ---- HTTP (handleRequest, owner token; authoring under an access link's cookie) ----
  {
    name: "GET api/diagrams/<id>",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/diagrams/${enc(v)}`),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET api/diagrams/<raw id>",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/diagrams/${v.replace(/[\u0000#?]/g, (c) => enc(c))}`),
  },
  {
    name: "GET api/diagram-source/<id>",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/diagram-source/${enc(v)}`),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET api/emphasis/<id>",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/emphasis/${enc(v)}`),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET api/thumbnails/<id>",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/thumbnails/${enc(v)}?rev=${ZERO}&theme=light`),
    control: { value: "flow", expect: /^\d{3}/ },
  },
  {
    name: "GET api/documents/content",
    surface: "http",
    class: "read",
    payloads: projectPaths,
    run: (v) => get(`api/documents/content?path=${enc(v)}`),
    control: { value: ".archer/notes/a.md", expect: /Hello passage/ },
  },
  {
    name: "GET api/notes/content",
    surface: "http",
    class: "read",
    payloads: notePaths,
    run: (v) => get(`api/notes/content?path=${enc(v)}`),
    control: { value: "notes/a.md", expect: /Hello passage/ },
  },
  {
    name: "GET api/notes/diagram",
    surface: "http",
    class: "read",
    payloads: () => notePaths().map((p) => ({ ...p, value: `${p.value}#d` })),
    run: (v) => get(`api/notes/diagram?address=${enc(v)}`),
    control: { value: "notes/a.md#d", expect: /^200/ },
  },
  {
    name: "GET api/notes?viewId",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/notes?viewId=${enc(v)}`),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET api/note-emphases",
    surface: "http",
    class: "read",
    payloads: notePaths,
    run: (v) => get(`api/note-emphases?path=${enc(v)}`),
    control: { value: "notes/a.md", expect: /^200/ },
  },
  {
    name: "GET api/comments?target",
    surface: "http",
    class: "read",
    payloads: () => notePaths().map((p) => ({ ...p, value: `note:${p.value}` })),
    run: (v) => get(`api/comments?target=${enc(v)}`),
    control: { value: "note:notes/a.md", expect: /^200/ },
  },
  {
    name: "GET api/walkthroughs",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/walkthroughs?viewId=${enc(v)}`),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET api/walkthroughs/old",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) => get(`api/walkthroughs/old?viewId=${enc(v)}&id=w`),
    control: { value: "flow", expect: /^\d{3}/ },
  },
  {
    name: "POST api/operations",
    surface: "http",
    class: "read",
    payloads: diagramPaths,
    run: async (v) =>
      (
        await Promise.all(
          ["export_diagram", "read_diagram_at_commit", "compare_diagrams", "list_stale_diagrams"].map((name) =>
            post("api/operations", {
              name,
              arguments:
                name === "export_diagram"
                  ? { viewId: v, format: "svg" }
                  : name === "list_stale_diagrams"
                    ? { viewId: v }
                    : name === "compare_diagrams"
                      ? { viewId: v, from: "HEAD", to: "HEAD" }
                      : { viewId: v, commit: "HEAD" },
            }),
          ),
        )
      ).join("\n"),
    control: { value: "flow", expect: /^200/ },
  },
  {
    name: "GET page /projects/<name>/<path>",
    surface: "http",
    class: "read",
    payloads: projectPaths,
    run: async (v) =>
      `${reply(await pageHttp(`${origin}/projects/${slug}/${v.replace(/[\u0000#?]/g, (c) => enc(c))}`, { headers: { cookie } }))}\n${reply(await pageHttp(`${origin}/projects/${slug}/${enc(v)}`, { headers: { cookie } }))}`,
  },
  {
    name: "GET /-/page-assets/<name>",
    surface: "http",
    class: "read",
    payloads: projectPaths,
    run: async (v) =>
      reply(
        await pageHttp(`${origin}/-/page-assets/${v.replace(/[\u0000#?]/g, (c) => enc(c))}`, { headers: { cookie } }),
      ),
  },
  {
    name: "POST api/authoring/open",
    surface: "http",
    class: "read",
    payloads: viewIds,
    run: (v) =>
      authoring("/open", { target: v.includes("#") ? { kind: "embedded", address: v } : { kind: "view", viewId: v } }),
    control: { value: "notes/a.md#d", expect: /^200/ },
  },
  {
    name: "POST api/comments",
    surface: "http",
    class: "write",
    payloads: () => notePaths().map((p) => ({ ...p, value: `note:${p.value}` })),
    run: (v) =>
      post("api/comments", {
        target: v,
        anchor: passage,
        body: "g6",
        context: { page: `/projects/${slug}/`, document: v.slice(5) },
      }),
    control: { value: "note:notes/a.md", expect: /^200/ },
  },
  {
    name: "POST api/comments context.document",
    surface: "http",
    class: "write",
    payloads: notePaths,
    run: (v) =>
      post("api/comments", {
        target: "view:flow",
        anchor: { kind: "view" },
        body: "g6",
        context: { page: `/projects/${slug}/`, document: v },
      }),
  },
  {
    name: "POST api/note-emphases",
    surface: "http",
    class: "write",
    payloads: notePaths,
    run: (v) => post("api/note-emphases", { notePath: v, id: "g6", groups: GROUPS, expectedRevision: 0 }),
    control: { value: "notes/sub/t.md", expect: /^200/ },
  },
  {
    name: "POST api/authoring document.publish",
    surface: "http",
    class: "write",
    payloads: () => [
      ...payloads(2, "", ".mmd"),
      { family: "symlink", value: "linkdir/new.mmd" },
      { family: "symlink", value: "diagrams/../linkdir/new.mmd" },
    ],
    run: (v) => authoring("", { op: "document.publish", operationId: opId(), path: v, source: FLOW }),
    control: { value: "diagrams/g6new.mmd", expect: /created/ },
  },
  {
    name: "POST api/authoring draft.save new",
    surface: "http",
    class: "write",
    payloads: () => payloads(2, "", ".mmd"),
    run: (v) =>
      authoring("", {
        op: "draft.save",
        operationId: opId(),
        draftId: `drf_${opId()}`,
        expectedDraftRevision: null,
        source: FLOW,
        origin: { kind: "new", path: v },
      }),
    control: { value: "diagrams/g6draft.mmd", expect: /^200/ },
  },
  {
    name: "POST api/authoring document.apply",
    surface: "http",
    class: "write",
    payloads: () => [...viewIds(), { family: "symlink", value: "symw" }, { family: "hardlink", value: "hardw" }],
    run: async (v) => {
      const target = v.includes("#") ? { kind: "embedded", address: v } : { kind: "view", viewId: v };
      const opened = await authoring("/open", { target });
      const body = /^200/.test(opened)
        ? (JSON.parse(opened.slice(opened.indexOf("{", opened.indexOf("} ") + 1))) as {
            targetRevision?: string;
            sourceRevision?: string;
          })
        : {};
      return `${opened}\n${await authoring("", { op: "document.apply", operationId: opId(), target, expectedTargetRevision: body.targetRevision ?? ZERO, expectedSourceRevision: body.sourceRevision ?? ZERO, source: FLOW.replace("API", "API3") })}`;
    },
    control: { value: "notes/a.md#d", expect: /applied/ },
  },
  // ---- management socket (socket.ts; the relay and CLI reach the service through these) ----
  {
    name: "socket getModel",
    surface: "socket",
    class: "read",
    payloads: viewIds,
    run: (v) => socket("getModel", { root: PROJ, viewId: v }),
    control: { value: "flow", expect: /envelope/ },
  },
  {
    name: "socket listEmphases",
    surface: "socket",
    class: "read",
    payloads: viewIds,
    run: (v) => socket("listEmphases", { root: PROJ, viewId: v }),
    control: { value: "flow", expect: /views/ },
  },
  {
    name: "socket present",
    surface: "socket",
    class: "read",
    payloads: viewIds,
    run: (v) => socket("present", { root: PROJ, viewId: v, openBrowser: false }),
    control: { value: "flow", expect: /presentationId/ },
  },
  {
    name: "socket setEmphasis",
    surface: "socket",
    class: "write",
    payloads: viewIds,
    run: (v) => socket("setEmphasis", { root: PROJ, viewId: v, emphases: [] }),
    control: { value: "flow", expect: /url/ },
  },
  {
    name: "socket recordWrite",
    surface: "socket",
    class: "write",
    payloads: viewIds,
    run: (v) => socket("recordWrite", { root: PROJ, viewId: v }),
    control: { value: "flow", expect: /recorded/ },
  },
  {
    name: "socket root (getModel/listEmphases/getContext)",
    surface: "socket",
    class: "read",
    payloads: () => [
      { family: "traversal", value: `${PROJ}/../outside` },
      { family: "traversal", value: `${PROJ}/.archer/../../outside` },
      { family: "symlink", value: `${PROJ}/.archer/linkdir` },
      { family: "absolute", value: OUT },
    ],
    run: async (v) =>
      (
        await Promise.all([
          socket("getModel", { root: v, viewId: "canary" }),
          socket("listEmphases", { root: v }),
          socket("getContext", { root: v }),
        ])
      ).join("\n"),
  },
  // ---- local: `archer init` writes the manifest (the CLI's explicit exception, ADR 0028) ----
  {
    name: "archer init (hostile folder)",
    surface: "local",
    class: "manifest",
    payloads: () => [
      { family: "traversal", value: "../outside" },
      { family: "traversal", value: ".archer/../../outside" },
      { family: "absolute", value: OUT },
      { family: "symlink", value: ".archer/linkdir" },
      { family: "backslash", value: "..\\outside" },
      { family: "encoded", value: "%2e%2e/outside" },
    ],
    run: async (v) => {
      const dir = join(T, `init-${randomBytes(4).toString("hex")}`);
      mkdirSync(dir);
      symlinkSync(OUT, join(dir, "linked"));
      writeFileSync(
        join(dir, "archer.toml"),
        `version = 1\nfolder = ${JSON.stringify(v.replace(".archer/linkdir", "linked"))}\n`,
      );
      try {
        return JSON.stringify(initProject(dir));
      } catch (error) {
        return describeError(error);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

/**
 * Path-taking operations not driven by the table, each with why. The coverage check below fails when a tool,
 * socket method or HTTP route appears that is in neither list.
 */
const CONTRACTED: Readonly<Record<string, string>> = {
  attach_project:
    "the socket owner (same OS account) may attach any directory (§1 matrix: socket = all); R4/P10 owns it",
  detach_project: "as attach_project; it removes a registration and touches no file",
  issue_authoring_access: "projectRoots must equal attached roots; grants no file effect (G3/P1)",
  issue_access_link: "authoringProjectRoots is legacy and ignored for file effects (G3/P1)",
  set_selection: "service-held selection state; viewId is matched against compiled views, no file path",
  "socket attach": "as attach_project",
  "socket detach": "as detach_project",
  "socket registerAgent": "agent root/cwd are the caller's own checkout (ADR 0035); listener state only, no file read",
  "socket claimListener": "listener state only",
  "socket waitMessage": "listener state only",
  "socket inbox": "listener state only",
  "socket listListeners": "listener state only",
  "socket reportActivity": "listener state only",
  "socket mcpRelay": "the relay's cwd is the agent's own working directory: same-account authority (H2)",
  "socket setSelection": "as set_selection",
  "socket issueAuthoringAccess": "as issue_authoring_access",
};
/** Argument names that carry a path or a path-bearing address in the operation schemas. */
const PATH_ARGUMENTS = new Set([
  "viewId",
  "notePath",
  "sourcePath",
  "target",
  "root",
  "projectRoots",
  "covers",
  "authoringProjectRoots",
]);

// ------------------------------------------------------------------ known product failures (filled from runs)

/**
 * `<operation>|<family>` → why it fails G6 today. Each is a product finding, reported, not fixed here.
 *
 * Empty since security round 1 (2026-10-31): the hard-link reads (no `st_nlink` check) and the
 * check-then-open-by-name races (C-01/X-01, C-02/X-02) are closed by the one confined seam
 * (src/project/confined-fs.ts: descriptor walk with O_NOFOLLOW, nlink == 1, read from the descriptor,
 * temporary and rename inside the open parent; ADR 0018 and ADR 0028, amended 2026-10-31).
 */
const KNOWN: Readonly<Record<string, string>> = {};

// ------------------------------------------------------------------ the seeded examples

const unconfinedRead = (v: string) => {
  try {
    return readFileSync(resolve(PROJ, ".archer", decodeURIComponent(v.replace(/%(?![0-9a-f]{2})/gi, "%25"))), "utf8");
  } catch (error) {
    return describeError(error);
  }
};
const SEEDED_FAIL: readonly Operation[] = [
  // Test-only: what a reader without confinement does. It must trip the detector.
  {
    name: "SEEDED unconfined reader",
    surface: "seeded",
    class: "read",
    payloads: () => [...notePaths(), ...diagramPaths()],
    run: async (v) => unconfinedRead(v),
  },
  // Test-only: what an in-place writer without confinement does (follows links, writes through hard links).
  {
    name: "SEEDED unconfined writer",
    surface: "seeded",
    class: "write",
    payloads: () => [
      ...diagramPaths(),
      { family: "traversal", value: "../../outside/new.mmd" },
      { family: "symlink", value: "diagrams/symw.mmd" },
      { family: "hardlink", value: "diagrams/hardw.mmd" },
    ],
    run: async (v) => {
      try {
        writeFileSync(resolve(PROJ, ".archer", decodeURIComponent(v)), "x", { flag: "a" });
        return "written";
      } catch (error) {
        return describeError(error);
      }
    },
  },
];
/** Test-only: a confined reader (lexical check, no link followed on any segment, one link count). It must NOT trip the detector. */
const confinedRead = (v: string): string => {
  const folder = join(PROJ, ".archer");
  if (
    v.includes("\u0000") ||
    v.includes("\\") ||
    v.startsWith("/") ||
    v.split("/").some((s) => s === ".." || s === "." || s === "")
  )
    return "refused";
  let at = folder;
  for (const segment of v.split("/")) {
    at = join(at, segment);
    try {
      if (lstatSync(at).isSymbolicLink()) return "refused";
    } catch {
      return "missing";
    }
  }
  const fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return "refused";
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};
const SEEDED_PASS: Operation = {
  name: "SEEDED confined reader",
  surface: "seeded",
  class: "read",
  payloads: () => [...notePaths(), ...diagramPaths()],
  run: async (v) => confinedRead(v),
  control: { value: "notes/a.md", expect: /Hello passage/ },
};

async function drive(op: Operation, families: readonly Family[] = STATIC_FAMILIES): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const p of op.payloads())
    if (families.includes(p.family)) hits.push(...(await observe(op.name, p.family, p.value, () => op.run(p.value))));
  return hits;
}
const brief = (hits: readonly Hit[]) =>
  hits
    .map((h) => `${h.op}: ${h.family} ${JSON.stringify(h.payload).replace(T, "<T>")} → ${h.kind} @ ${h.where}`)
    .join("\n");

// ------------------------------------------------------------------ tests

describe("the detector (rubric §8: shown on a seeded fail and a seeded pass)", () => {
  test("a seeded unconfined reader trips it in every family it can escape through", async () => {
    const hits = await drive(SEEDED_FAIL[0]!);
    const families = new Set(hits.map((h) => h.family));
    for (const family of ["traversal", "encoded", "absolute", "symlink", "hardlink"] as const)
      expect(families, family).toContain(family);
    expect(hits.every((h) => h.kind === "bytes" || h.kind === "revision")).toBe(true);
  });
  test("a seeded unconfined writer trips it on change and on creation", async () => {
    const hits = await drive(SEEDED_FAIL[1]!);
    expect(hits.some((h) => h.kind === "created")).toBe(true);
    expect(hits.some((h) => h.kind === "changed" && h.family === "symlink")).toBe(true);
    expect(hits.some((h) => h.kind === "changed" && h.family === "hardlink")).toBe(true);
    // Repaired: the next case starts from the original canary.
    expect(sha(readFileSync(CANARY_PATH))).toBe(CANARY_SHA);
  });
  test("a seeded confined reader passes: it answers its control and leaks nothing", async () => {
    expect(await SEEDED_PASS.run(SEEDED_PASS.control!.value)).toMatch(SEEDED_PASS.control!.expect);
    expect(brief(await drive(SEEDED_PASS))).toBe("");
  });
  test("it sees the canary inside base64 (export bytes) and its revision", () => {
    expect(leaked(Buffer.from(`<svg>${MARK}</svg>`).toString("base64"))).toContain("bytes");
    expect(leaked(`{"currentRevision":"sha256:${CANARY_SHA}"}`)).toContain("revision");
    expect(leaked("nothing here")).toEqual([]);
  });
});

describe("coverage: every path-taking operation is driven or contracted", () => {
  const driven = new Set(PRODUCT.map((op) => op.name));
  test("every application tool with a path argument", () => {
    const missing = TOOLS.filter((t) => Object.keys(t.inputSchema.properties ?? {}).some((k) => PATH_ARGUMENTS.has(k)))
      .map((t) => t.name)
      .filter((name) => !driven.has(name) && !(name in CONTRACTED));
    expect(missing).toEqual([]);
  });
  test("every management-socket method that takes a root, cwd or view", () => {
    const text = readFileSync(new URL("../../src/service/socket.ts", import.meta.url), "utf8");
    const methods = new Set([...text.matchAll(/case "([A-Za-z]+)":([^\n]*)/g)].map((m) => m[1]!));
    for (const m of AGENT_METHODS) methods.add(m);
    const pathless = new Set([
      "readReview",
      "clearReview",
      "pendingChanges",
      "listChanges",
      "readChange",
      "resolveChange",
      "issueAccess",
      "revokeAccess",
      "listAccess",
      "issuePairingCode",
      "handover",
      "restartConfiguration",
      "hello",
      "getContext",
      "stop",
      "listProjects",
      "heartbeat",
    ]);
    const covered = (m: string) =>
      pathless.has(m) ||
      `socket ${m}` in CONTRACTED ||
      [...driven].some((name) => name.startsWith(`socket ${m}`) || name.includes(m));
    expect([...methods].filter((m) => !covered(m))).toEqual([]);
  });
  test("every project API route in handleRequest", () => {
    const text = readFileSync(new URL("../../src/service/http.ts", import.meta.url), "utf8");
    const routes = new Set([...text.matchAll(/second === "([a-z-]+)"/g)].map((m) => m[1]!));
    const pathless = new Set([
      "project-lifecycle",
      "settings",
      "project-settings",
      "comment-activity",
      "listeners",
      "selection",
      "walkthrough-position",
      "documents",
      "projects",
      "browser-projects",
      "compile",
      "bootstrap",
      "connection",
      "events",
      "search",
      "browser-search",
      // A view id and an element, looked up in the project model in memory (ADR 0036 A8): nothing names a file.
      "expand-menu",
      "exploration",
      "reader-exploration",
    ]);
    const covered = (r: string) => pathless.has(r) || [...driven].some((name) => name.includes(`api/${r}`));
    expect([...routes].filter((r) => !covered(r))).toEqual([]);
  });
});

test("inventory: operations × payloads by class (for the run manifest)", () => {
  const rows = new Map<string, { ops: number; probes: number }>();
  for (const op of PRODUCT) {
    const row = rows.get(op.class) ?? { ops: 0, probes: 0 };
    row.ops++;
    row.probes += op.payloads().length;
    rows.set(op.class, row);
  }
  console.info(
    `[G6 inventory] ${[...rows].map(([c, r]) => `${c}: ${r.ops} operations, ${r.probes} probes`).join("; ")}; contracted: ${Object.keys(CONTRACTED).length}`,
  );
  expect([...rows.keys()].sort()).toEqual(["manifest", "read", "register", "write"]);
});

describe("controls: each driven operation really works on a valid path", () => {
  for (const op of PRODUCT)
    if (op.control !== undefined)
      test(op.name, async () => {
        const answer = await op.run(op.control!.value).catch(describeError);
        expect(answer).toMatch(op.control!.expect);
      }, 30_000);
});

describe("G6: no read or write escapes the project (P5 static payloads)", () => {
  for (const op of PRODUCT)
    for (const family of STATIC_FAMILIES) {
      if (!op.payloads().some((p) => p.family === family)) continue;
      const key = `${op.name}|${family}`;
      const known = KNOWN[key];
      (known === undefined ? test : test.fails)(
        `${op.class} ${op.name} × ${family}`,
        async () => {
          expect(brief(await drive(op, [family]))).toBe("");
        },
        60_000,
      );
    }
});

// ------------------------------------------------------------------ races and linked parents

/** A child process that swaps `target` between a regular file and a symlink to `link` for `ms`, as fast as it can (no sleeps). */
function swapper(target: string, link: string, body: string, ms: number): ChildProcess {
  const script = `const fs=require("node:fs");const [t,l,b,ms]=process.argv.slice(1);const end=Date.now()+Number(ms);let i=0;
while(Date.now()<end){const tmp=t+".swap"+(i%2);try{fs.rmSync(tmp,{force:true,recursive:true});if(i%2){fs.symlinkSync(l,tmp);}else if(b==="DIR"){fs.mkdirSync(tmp);fs.writeFileSync(tmp+"/race.md",fs.readFileSync(l+"/../../proj-race-template.md"));}else{fs.writeFileSync(tmp,b);}if(b==="DIR")fs.rmSync(t,{force:true,recursive:true});fs.renameSync(tmp,t);}catch{}i++;}
fs.rmSync(t,{force:true,recursive:true});if(b==="DIR"){fs.mkdirSync(t);fs.writeFileSync(t+"/race.md",fs.readFileSync(l+"/../../proj-race-template.md"));}else fs.writeFileSync(t,b);`;
  return spawn(process.execPath, ["-e", script, target, link, body, String(ms)], { stdio: "ignore" });
}
/** A killed swapper may leave its target missing or linked: put the in-project file or folder back. */
function restoreRace(mode: "file" | "parent directory", path: string): void {
  const target = mode === "file" ? join(PROJ, ".archer", path) : join(PROJ, ".archer", dirname(path));
  for (const extra of [`${target}.swap0`, `${target}.swap1`]) rmSync(extra, { force: true, recursive: true });
  try {
    if (lstatSync(target).isSymbolicLink()) rmSync(target);
  } catch {
    /* missing */
  }
  if (mode === "file") writeFileSync(target, NOTE("Race"));
  else {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "race.md"), NOTE("Race"));
  }
}
const exited = (child: ChildProcess) =>
  new Promise<void>((done) => (child.exitCode !== null ? done() : child.once("exit", () => done())));

describe("G6: races between check and use (TOCTOU, best effort)", () => {
  const RACE_MS = 2_500;
  const READS: readonly [string, (v: string) => Promise<string>][] = [
    ["read_note", (v) => appCall("read_note", { notePath: v }).catch(describeError)],
    ["read_diagram", (v) => appCall("read_diagram", { viewId: `${v}#d` }).catch(describeError)],
    ["GET api/notes/content", (v) => get(`api/notes/content?path=${enc(v)}`)],
    ["GET api/documents/content", (v) => get(`api/documents/content?path=${enc(`.archer/${v}`)}`)],
    ["GET api/notes/diagram", (v) => get(`api/notes/diagram?address=${enc(`${v}#d`)}`)],
  ];
  const HTTP_NOTE_READS = new Set(["GET api/notes/content", "GET api/notes/diagram", "read_diagram"]);
  const raceCases: readonly [string, "file" | "parent directory", string, (name: string) => boolean, boolean][] = [
    // [key, mode, path, which readers, stop at the first hit]
    ["note-by-name readers × file", "file", "notes/race.md", (name) => HTTP_NOTE_READS.has(name), true],
    ["other readers × file", "file", "notes/race.md", (name) => !HTTP_NOTE_READS.has(name), false],
    ["all readers × parent directory", "parent directory", "notes/racedir/race.md", () => true, false],
  ];
  for (const [label, mode, path, which, stopAtHit] of raceCases) {
    const key = `race reads|${label}`;
    (KNOWN[key] === undefined ? test : test.fails)(
      `read ${label} swapped to a link while reading`,
      async () => {
        writeFileSync(join(T, "proj-race-template.md"), NOTE("Race"));
        const start = () =>
          mode === "file"
            ? swapper(join(PROJ, ".archer", path), CANARY_PATH, NOTE("Race"), RACE_MS)
            : swapper(join(PROJ, ".archer/notes/racedir"), join(OUT, "rdir"), "DIR", RACE_MS);
        let child = start();
        const hits: Hit[] = [];
        let rounds = 0;
        try {
          while (rounds < 20_000 && !(stopAtHit && hits.length > 0)) {
            if (child.exitCode !== null) {
              // A slow host fits few rounds into one swapper's window: race again until enough have run.
              if (rounds > 5) break;
              await exited(child);
              restoreRace(mode, path);
              child = start();
            }
            rounds++;
            for (const [name, read] of READS)
              if (which(name))
                hits.push(
                  ...leaked(await read(path)).map(
                    (kind) => ({ op: name, family: "toctou", payload: path, kind, where: "response" }) as Hit,
                  ),
                );
          }
        } finally {
          child.kill();
          await exited(child);
          restoreRace(mode, path);
        }
        console.info(`[G6 race] ${label}: ${rounds} rounds, ${hits.length} hits`);
        // Enough rounds ran to mean something, unless it stopped at its first hit.
        if (!(stopAtHit && hits.length > 0)) expect(rounds).toBeGreaterThan(5);
        expect(brief(hits)).toBe("");
      },
      60_000,
    );
  }
  // G6 (P5 "a link swapped between check and use"): a parent swapped to a directory link while the writers
  // run. Before round 1 `writeConfined` resolved the parent by realpath, then opened the temporary and renamed
  // by name, so the temporary (and with a held swap, the outside file) landed outside: 2 of 8 full-suite runs.
  // On the descriptor anchor (Linux with /proc) the seam creates and renames inside the parent descriptor it
  // opened without following links, so no interleaving reaches outside. On the path anchor (macOS) a swap
  // inside its few-syscall window can still leave an Archer temporary outside: docs/security/known-limits.md
  // §1 keeps that for a swapper with this account's own access, and closes it for any other account by
  // refusing writes under a folder another account can change (the second case; O283). This free-running race
  // is bounded (RACE_MS); the exact interleavings are scheduled in confined-seam.test.ts and shared-folder.test.ts.
  /** Races writes against the swap; `changed`: what it changed outside, relative to T (new files it made are removed). */
  const raceParentWrites = async () => {
    // The decoy outside (wdir/race.md) is byte-identical to the note inside, so a revision check cannot tell them apart.
    writeFileSync(join(T, "proj-race-template.md"), NOTE("Race"));
    const outsideBefore = outsideSnapshot();
    const read = JSON.parse(await appCall("read_diagram", { viewId: "notes/racewdir/race.md#d" })) as {
      structured: { sourceRevision: string };
    };
    const child = swapper(join(PROJ, ".archer/notes/racewdir"), join(OUT, "wdir"), "DIR", RACE_MS);
    let rounds = 0;
    try {
      while (child.exitCode === null && rounds < 2_000) {
        rounds++;
        await appCall("write_diagram", {
          viewId: "notes/racewdir/race.md#d",
          source: "flowchart LR\n  a[A] e1@--> b[B]\n",
          expectedRevision: read.structured.sourceRevision,
        }).catch(describeError);
        await appCall("set_note_emphasis", {
          notePath: "notes/racewdir/race.md",
          id: `g6r${rounds}`,
          groups: GROUPS,
          expectedRevision: 0,
        }).catch(describeError);
        await appCall("create_comment", { target: "note:notes/racewdir/race.md", anchor: passage, body: "g6" }).catch(
          describeError,
        );
      }
    } finally {
      child.kill();
      await exited(child);
      restoreRace("parent directory", "notes/racewdir/race.md");
    }
    const after = outsideSnapshot();
    const changed = [...after]
      .filter(([p, h]) => outsideBefore.get(p) !== h && !p.endsWith("proj-race-template.md"))
      .map(([p]) => relative(T, p));
    restoreOutside();
    for (const [p] of after)
      if (!outsideBefore.has(p) && !p.endsWith("proj-race-template.md")) rmSync(p, { force: true });
    return { rounds, before: outsideBefore, changed };
  };

  test("write × a parent directory swapped to a link while writing", async () => {
    const { rounds, before, changed } = await raceParentWrites();
    console.info(`[G6 race] write × parent directory: ${rounds} rounds`);
    expect(rounds).toBeGreaterThan(2);
    if (descriptorConfinement()) expect(changed).toEqual([]);
    else {
      // The same-account case known-limits §1 keeps: at most new Archer temporaries, never an outside file that was there.
      const temporary = /(^|\/)\.[^/]+\.[0-9a-f]{12}\.tmp$/u;
      expect(changed.filter((p) => before.has(join(T, p)) || !temporary.test(p))).toEqual([]);
    }
  }, 60_000);

  test("write × a parent directory swapped to a link, under a folder other accounts can change", async () => {
    const notes = join(PROJ, ".archer/notes");
    chmodSync(notes, 0o777);
    const { rounds, changed } = await raceParentWrites().finally(() => chmodSync(notes, 0o755));
    console.info(`[G6 race] write × parent directory, shared folder: ${rounds} rounds`);
    expect(rounds).toBeGreaterThan(2);
    expect(changed).toEqual([]);
  }, 60_000);
});

describe("G6: a rename onto a linked parent between read and write", () => {
  /** Swap `.archer/<dir>` for a symlink to an outside copy with identical bytes, run `write`, then put it back. */
  async function linkedParent(dir: string, outside: string, write: () => Promise<string>): Promise<string[]> {
    const inside = join(PROJ, ".archer", dir),
      aside = `${inside}.real`;
    const before = outsideSnapshot();
    renameSync(inside, aside);
    symlinkSync(join(OUT, outside), inside);
    try {
      await write().catch(describeError);
    } finally {
      rmSync(inside, { force: true });
      renameSync(aside, inside);
    }
    const after = outsideSnapshot();
    const escapes = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => relative(T, p));
    restoreOutside();
    for (const [p] of after) if (!before.has(p)) rmSync(p, { force: true });
    return escapes;
  }
  const cases: readonly [string, string, string, () => Promise<() => Promise<string>>][] = [
    [
      "write_diagram embedded",
      "notes/sub",
      "dir2",
      async () => {
        const rev = (
          JSON.parse(await appCall("read_diagram", { viewId: "notes/sub/t.md#d" })) as {
            structured: { sourceRevision: string };
          }
        ).structured.sourceRevision;
        return () =>
          appCall("write_diagram", {
            viewId: "notes/sub/t.md#d",
            source: "flowchart LR\n  a[A] e1@--> b[Z]\n",
            expectedRevision: rev,
          });
      },
    ],
    [
      "write_diagram standalone",
      "diagrams/sub",
      "dir2",
      async () => {
        const rev = (
          JSON.parse(await appCall("read_diagram", { viewId: "v" })) as { structured: { sourceRevision: string } }
        ).structured.sourceRevision;
        return () => appCall("write_diagram", { viewId: "v", source: FLOW.replace("API", "Z"), expectedRevision: rev });
      },
    ],
    [
      "set_note_emphasis",
      "notes/sub",
      "dir2",
      async () => () =>
        appCall("set_note_emphasis", { notePath: "notes/sub/t.md", id: "g6lp", groups: GROUPS, expectedRevision: 0 }),
    ],
    [
      "create_comment",
      "notes/sub",
      "dir2",
      async () => () => appCall("create_comment", { target: "note:notes/sub/t.md", anchor: passage, body: "g6" }),
    ],
    [
      "POST api/comments",
      "notes/sub",
      "dir2",
      async () => () => post("api/comments", { target: "note:notes/sub/t.md", anchor: passage, body: "g6" }),
    ],
    [
      "POST api/note-emphases",
      "notes/sub",
      "dir2",
      async () => () =>
        post("api/note-emphases", { notePath: "notes/sub/t.md", id: "g6lp2", groups: GROUPS, expectedRevision: 0 }),
    ],
    [
      "POST api/authoring document.apply",
      "notes/sub",
      "dir2",
      async () => {
        const target = { kind: "embedded", address: "notes/sub/t.md#d" };
        const opened = JSON.parse(
          (
            await pageHttp(`${authoringBase()}/open`, {
              method: "POST",
              headers: { cookie, origin, "content-type": "application/json" },
              body: JSON.stringify({ target }),
            })
          ).body,
        ) as { targetRevision: string; sourceRevision: string };
        return () =>
          authoring("", {
            op: "document.apply",
            operationId: opId(),
            target,
            expectedTargetRevision: opened.targetRevision,
            expectedSourceRevision: opened.sourceRevision,
            source: "flowchart LR\n  a[A] e1@--> b[Q]\n",
          });
      },
    ],
    [
      "POST api/authoring document.publish",
      "diagrams/sub",
      "dir2",
      async () => () =>
        authoring("", { op: "document.publish", operationId: opId(), path: "diagrams/sub/new.mmd", source: FLOW }),
    ],
  ];
  for (const [name, dir, outside, prepare] of cases) {
    const key = `linked parent|${name}`;
    (KNOWN[key] === undefined ? test : test.fails)(
      `write ${name} × linked parent`,
      async () => {
        const write = await prepare();
        expect(await linkedParent(dir, outside, write)).toEqual([]);
        // The inside file was the target, not the outside copy: restore it for the next case.
        writeFileSync(join(PROJ, ".archer/notes/sub/t.md"), NOTE("Sub"));
        writeFileSync(join(PROJ, ".archer/diagrams/sub/v.mmd"), FLOW);
      },
      30_000,
    );
  }
});

describe("G6: hostile manifests (repository content names the paths)", () => {
  const manifests = (): readonly [Family, string][] => [
    ["traversal", 'source = "../outside/canary.mmd"'],
    ["traversal", 'source = ".archer/../../outside/canary.mmd"'],
    ["absolute", `source = ${JSON.stringify(join(OUT, "canary.mmd"))}`],
    ["symlink", 'source = ".archer/linkdir/canary.mmd"'],
    ["symlink", 'source = ".archer/links/sym.mmd"'],
    ["hardlink", 'source = ".archer/links/hard.mmd"'],
  ];
  for (const [index, [family]] of manifests().entries()) {
    const key = `manifest [[views]] source|${family}`;
    (KNOWN[key] === undefined ? test : test.fails)(
      `manifest [[views]] source × ${family} #${index}`,
      async () => {
        const line = manifests()[index]![1];
        const manifest = join(PROJ, "archer.toml"),
          original = readFileSync(manifest, "utf8");
        writeFileSync(manifest, `${original}\n[[views]]\nid = "hostile"\nkind = "freeform"\ntitle = "H"\n${line}\n`);
        try {
          const hits = [
            ...(await observe("list_diagrams", family, line, () => appCall("list_diagrams", {}))),
            ...(await observe("read_diagram hostile", family, line, () =>
              appCall("read_diagram", { viewId: "hostile" }),
            )),
            ...(await observe("export_diagram hostile", family, line, () =>
              appCall("export_diagram", { viewId: "hostile", format: "svg" }),
            )),
            ...(await observe("read_diagram_at_commit hostile", family, line, () =>
              appCall("read_diagram_at_commit", { viewId: "hostile", commit: "HEAD" }),
            )),
          ];
          expect(brief(hits)).toBe("");
        } finally {
          writeFileSync(manifest, original);
        }
      },
      30_000,
    );
  }
  const discovery = (): readonly [Family, string][] => [
    ["traversal", '["../outside"]'],
    ["absolute", JSON.stringify([OUT])],
    ["symlink", '[".archer/linkdir"]'],
    ["symlink", '[".archer/links"]'],
  ];
  for (const [index, [family]] of discovery().entries()) {
    const key = `manifest discovery.roots|${family}`;
    (KNOWN[key] === undefined ? test : test.fails)(
      `manifest [discovery] roots × ${family} #${index}`,
      async () => {
        const roots = discovery()[index]![1];
        const manifest = join(PROJ, "archer.toml"),
          original = readFileSync(manifest, "utf8");
        // Only what the hostile setting adds counts: the in-project hard links are read under the default roots too (scored above).
        const reads = async (label: string) => [
          ...(await observe("GET api/documents", family, label, () => get("api/documents"))),
          ...(await observe("GET api/documents/content ../outside", family, label, () =>
            get(`api/documents/content?path=${enc("../outside/canary.md")}`),
          )),
          ...(await observe("GET api/documents/content <abs>", family, label, () =>
            get(`api/documents/content?path=${enc(CANARY_PATH)}`),
          )),
          ...(await observe("GET api/documents/content linkdir", family, label, () =>
            get(`api/documents/content?path=${enc(".archer/linkdir/canary.md")}`),
          )),
          ...(await observe("GET api/documents/content links/sym", family, label, () =>
            get(`api/documents/content?path=${enc(".archer/links/sym.md")}`),
          )),
        ];
        const baseline = new Set((await reads("default")).map((h) => `${h.op}|${h.kind}`));
        writeFileSync(manifest, original.replace('name = "g6"\n', `name = "g6"\n\n[discovery]\nroots = ${roots}\n`));
        try {
          const hits = (await reads(roots)).filter((h) => !baseline.has(`${h.op}|${h.kind}`));
          expect(brief(hits)).toBe("");
        } finally {
          writeFileSync(manifest, original);
        }
      },
      30_000,
    );
  }
});

describe("the canary is intact at the end", () => {
  test("its hash is unchanged and nothing new lies outside the project", () => {
    expect(sha(readFileSync(CANARY_PATH))).toBe(CANARY_SHA);
    const outside = [...outsideSnapshot().keys()].map((p) => relative(T, p).split(sep).join("/")).sort();
    expect(
      outside.filter(
        (p) =>
          !/^outside\/(canary(\.md|\.mmd)?|rdir\/race\.md|dir2\/[tv]\.(md|mmd)|w\.mmd|hw\.mmd|wdir\/race\.md)$/.test(
            p,
          ) && p !== "proj-race-template.md",
      ),
    ).toEqual([]);
  });
});
