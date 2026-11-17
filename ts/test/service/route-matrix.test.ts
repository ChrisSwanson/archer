// The route matrix: what the data plane answers for every API name × method × extra segments × scope, recorded
// as it is so a change to how routes are matched (the declarative table, refactor slice b) shows up as a diff.
// Each request records its status, whether it carries `x-archer-event-seq` and an ETag, its cache-control and
// content type, `retry-after`, and its error code. A bare 404 (no body, exactly the four headers every refusal
// carries: ADR 0014/0015, no 405s) is the expected default and only counted; every other answer is a line.
//
// Passes: the real service (startService on a temp project) as the owner's browser (session cookie, its own
// Origin, JSON) and as an access grant's Bearer; then handleRequest on a minimal data plane (no authoring,
// thumbnails, listeners or operations: those routes must not exist), while stopping, and while restoring.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, Agent, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { handleRequest, type DataPlane } from "../../src/service/http.ts";
import type { ProjectState } from "../../src/service/project-state.ts";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, ownerCookie, project, service, slugOf } from "./support.ts";

afterEach(cleanUp);

/** Every API name the service served when the matrix was recorded, and one it never did. */
const NAMES = [
  "authoring",
  "bootstrap",
  "browser-projects",
  "browser-search",
  "comment-activity",
  "comments",
  "compile",
  "connection",
  "diagram-source",
  "diagrams",
  "documents",
  "emphasis",
  "events",
  "expand-menu",
  "exploration",
  "listeners",
  "note-emphases",
  "notes",
  "operations",
  "project-lifecycle",
  "project-settings",
  "projects",
  "reader-exploration",
  "search",
  "selection",
  "settings",
  "thumbnails",
  "walkthrough-position",
  "walkthroughs",
  "nope",
];
/** Literal segments some route matches after its name, a few spelled percent-encoded, and one that does not decode. */
const LITERALS = [
  "open",
  "snapshot",
  "preview",
  "edit",
  "presentation",
  "operations",
  "content",
  "diagram",
  "all",
  "pending",
  "submit",
  "replies",
  "resolve",
  "dismiss",
  "old",
  "pin",
  "launch",
  "%70ending",
  "%6Fld",
  "%61ll",
  "%6Fpen",
  "%ZZ",
];
const HEX = "a1".repeat(16);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function suffixes(full: boolean): string[][] {
  const out: string[][] = [[], ["x"], ["x", "x"], ["x", "x", "x"], ["operations", HEX], ["operations", HEX, "x"]];
  for (const literal of LITERALS) {
    out.push([literal]);
    if (full) out.push(["x", literal], [literal, "x"]);
  }
  return out;
}

/** Requests with a query a route reads, or a real view id: the answers past each route's first refusal. */
const QUERIES = [
  "diagrams/flow",
  "diagram-source/flow",
  "emphasis/flow",
  "thumbnails/flow",
  "thumbnails/flow?rev=x&theme=light",
  "walkthroughs?viewId=flow",
  "walkthroughs/old?viewId=flow&id=x",
  "notes?viewId=flow",
  "notes/content?path=x.md",
  "notes/diagram?address=x%23y",
  "comments?target=view:flow",
  "expand-menu?viewId=flow&element=a",
  "exploration?viewId=flow",
  "search?q=a",
  "browser-search?q=a",
  "note-emphases?path=x.md",
  "documents/content?path=README.md",
  "authoring/operations/abc",
];
/** Addresses around the API base. */
const AROUND = ["/p/{slug}", "/p/{slug}/", "/p/{slug}/x", "/p/{slug}/api", "/p/{slug}/api/", "/p/nosuch/api/diagrams"];
const AROUND_SERVICE = ["/api", "/api/", "/x", "/api/x/x"];

interface Probe {
  readonly method: string;
  readonly path: string;
}

function probes(slug: string, full: boolean): Probe[] {
  const paths: string[] = [];
  for (const name of NAMES)
    for (const suffix of suffixes(full)) {
      const tail = [name, ...suffix].join("/");
      paths.push(`/p/${slug}/api/${tail}`, `/api/${tail}`);
    }
  for (const query of QUERIES) paths.push(`/p/${slug}/api/${query}`, `/api/${query}`);
  paths.push(...AROUND.map((path) => path.replace("{slug}", slug)), ...AROUND_SERVICE);
  const out: Probe[] = [];
  for (const path of paths) for (const method of METHODS) out.push({ method, path });
  for (const name of NAMES)
    out.push({ method: "HEAD", path: `/p/${slug}/api/${name}` }, { method: "HEAD", path: `/api/${name}` });
  return out;
}

const BARE = ["cache-control", "content-length", "referrer-policy", "x-content-type-options"].join(",");
/** Headers Node adds to every answer. */
const TRANSPORT = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

interface Answer {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

function line(answer: Answer): string | null {
  const names = Object.keys(answer.headers)
    .filter((name) => !TRANSPORT.has(name))
    .sort()
    .join(",");
  if (answer.status === 404 && answer.body === "" && names === BARE && answer.headers["cache-control"] === "no-store")
    return null;
  let code = "";
  if (String(answer.headers["content-type"] ?? "").includes("json"))
    try {
      const body = JSON.parse(answer.body) as { error?: { code?: string }; authorized?: boolean };
      code = body.error?.code ?? (body.authorized === false ? "authorized:false" : "");
    } catch {
      code = "unparsed";
    }
  return [
    answer.status,
    answer.headers["x-archer-event-seq"] === undefined ? "" : "seq",
    answer.headers.etag === undefined ? "" : "etag",
    answer.headers["retry-after"] === undefined ? "" : "retry",
    `cc=${answer.headers["cache-control"] ?? "-"}`,
    `ct=${answer.headers["content-type"] ?? "-"}`,
    ...(code === "" ? [] : [`code=${code}`]),
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** One request; an event stream is recorded at its headers and closed. */
function send(origin: string, probe: Probe, headers: Record<string, string>, agent: Agent): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const write = probe.method !== "GET" && probe.method !== "HEAD";
    const req = request(
      `${origin}${probe.path}`,
      {
        method: probe.method,
        agent,
        headers: {
          ...headers,
          ...(write ? { "content-type": "application/json", origin, "content-length": "0" } : {}),
        },
      },
      (res) => {
        if (String(res.headers["content-type"] ?? "").startsWith("text/event-stream")) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "<stream>" });
          req.destroy();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * The matrix as text: one line per answer that is not the bare 404, and how many were. With `usual` (a plane that
 * answers nearly everything alike: stopping, restoring), the most frequent other answer is counted too, not listed.
 */
async function matrix(
  origin: string,
  list: readonly Probe[],
  headers: Record<string, string>,
  slug: string,
  usual = false,
): Promise<string> {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  const lines: string[] = [];
  let bare = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const probe = list[next++]!;
      const recorded = line(await send(origin, probe, headers, agent));
      if (recorded === null) bare++;
      else lines.push(`${probe.method} ${probe.path.replace(`/p/${slug}/`, "/p/{slug}/")} -> ${recorded}`);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    agent.destroy();
  }
  lines.sort();
  let head = `${list.length} requests, ${bare} bare 404`;
  if (usual) {
    const counts = new Map<string, number>();
    for (const entry of lines) {
      const outcome = entry.slice(entry.indexOf(" -> ") + 4);
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    const [outcome, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    head += `, ${count} answered ${outcome}`;
    lines.splice(0, lines.length, ...lines.filter((entry) => !entry.endsWith(` -> ${outcome}`)));
  }
  return `${head}\n${lines.join("\n")}\n`;
}

test("the real service: every API name, method, depth and scope, as the owner's browser and as a grant's Bearer", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root: project() });
    const base = apiBase(attached.url);
    const cookie = (await ownerCookie(base))!;
    const slug = slugOf(attached.url);
    const origin = new URL(base).origin;
    const grant = await client.call("issueAccess", { label: "matrix" });
    const owner = await matrix(origin, probes(slug, true), { cookie }, slug);
    await expect(owner).toMatchFileSnapshot("route-matrix/owner-cookie.txt");
    const bearer = await matrix(origin, probes(slug, false), { authorization: `Bearer ${grant.token}` }, slug);
    await expect(bearer).toMatchFileSnapshot("route-matrix/grant-bearer.txt");
  } finally {
    client.close();
  }
}, 180_000);

// ------------------------------------------------------------- a minimal data plane

const TOKEN = "b".repeat(32);
const GRANTS_DIR = mkdtempSync(join(tmpdir(), "archer-route-matrix-"));
afterAll(() => rmSync(GRANTS_DIR, { recursive: true, force: true }));
const GRANTS = new AccessGrantStore(GRANTS_DIR);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A project whose every read throws: the matrix records which routes reach it, not what it holds. */
const STUB = new Proxy(
  { slug: "shop", name: "shop", root: "/nonexistent/shop", url: "http://127.0.0.1/", eventSeq: 7 },
  {
    get(target, key) {
      if (typeof key === "string" && key in target) return target[key as keyof typeof target];
      if (key === "then") return undefined;
      return () => {
        throw new Error(`stub: ${String(key)}`);
      };
    },
  },
) as unknown as ProjectState;

async function minimalPlane(state: { stopping?: boolean; restoring?: boolean }): Promise<string> {
  let plane: DataPlane | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      handleRequest(plane!, req, res);
    } catch {
      // A read that throws out of the listener: recorded as such.
      if (!res.headersSent) res.writeHead(599, { "content-length": "0" }).end();
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  plane = {
    grantStreams: new Map(),
    isStopping: () => state.stopping === true,
    isRestoring: () => state.restoring === true,
    page: () => Buffer.from("<html>"),
    log: () => {},
    project: (slug: string) => (state.restoring !== true && slug === "shop" ? STUB : undefined),
    projects: () => [],
    projectLifecycle: () => ({}),
    setProjectLifecycle: () => null,
    connection: { schemaVersion: 1 },
    streams: new Map(),
    cap: { acquire: () => null, open: 0, limit: 0 },
    settings: { read: () => ({ schemaVersion: 1 }) },
    authority: {
      serviceToken: TOKEN,
      grants: GRANTS,
      cookieName: `archer-${port}`,
      secure: false,
      allowedHosts: new Set([`127.0.0.1:${port}`]),
    },
  } as unknown as DataPlane;
  return `http://127.0.0.1:${port}`;
}

test.each([
  ["minimal", {}],
  ["stopping", { stopping: true }],
  ["restoring", { restoring: true }],
] as const)(
  "a %s data plane: optional backends absent, a drain and a restore",
  async (name, state) => {
    const origin = await minimalPlane(state);
    const cookie = `archer-${new URL(origin).port}=${GRANTS.mintOwnerSession(TOKEN)}`;
    const text = await matrix(origin, probes("shop", false), { cookie }, "shop", name !== "minimal");
    await expect(text).toMatchFileSnapshot(`route-matrix/plane-${name}.txt`);
  },
  120_000,
);
