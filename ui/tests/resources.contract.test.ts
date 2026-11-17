// @vitest-environment jsdom
// The page's read layer, characterized through the modules' own entry points (refactor slice a, step a0): how many
// requests each question costs, which tick a request belongs to, and which answer wins when an event or an edit
// overtakes a read. Written against the modules as they were before the read layer moved into one store, and kept
// unchanged as it moved: request counts, poll provenance and the order answers land in must stay identical (or
// better) on every step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_HEADER } from "../src/app/polls";
import { invalidateCommentActivity, readCommentActivity } from "../src/app/comment-activity";
import {
  forgetProjectCatalogs,
  loadProjectCatalog,
  markProjectCatalogStale,
  rememberedProjectCatalog,
  updateRememberedProjectLifecycle,
  watchProjectCatalog,
} from "../src/app/project-directory";
import { authoringStatus, forgetAuthoringStatus } from "../src/authoring/status-cache";
import { httpCommentsTransport } from "../src/comments/transport";
import { FILE_ROUTE_HANDOFF_MS, readFileRoute, takeFileRouteRead } from "../src/app/file-route";
import { awaitFileRouteEntry, fileRouteReading, readAhead } from "../src/app/file-route-reads";

type Call = { readonly url: string; readonly poll: string | null; readonly etag: string | null };

/** A fetcher whose answers the test releases one at a time, recording each request it was asked. */
function service() {
  const calls: Call[] = [];
  const held: ((response: Response) => void)[] = [];
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, poll: headers.get(POLL_HEADER), etag: headers.get("if-none-match") });
    return new Promise<Response>((resolve) => held.push(resolve));
  });
  const answer = (index: number, response: Response): void => held[index]!(response);
  return { calls, fetchImpl, answer };
}
const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
  invalidateCommentActivity();
  forgetAuthoringStatus();
});

describe("comment activity (one read per project, 2 s)", () => {
  const activity = (threads: number) => ({
    schemaVersion: 1,
    targets: { "view:a": { totalThreads: threads, unresolvedThreads: 0, lastCommentedAt: null } },
  });

  it("concurrent askers share one request; an ask inside 2 s takes the answer; one after it reads again", async () => {
    const { calls, fetchImpl, answer } = service();
    const reads = [1, 2, 3].map(() => readCommentActivity("demo", "api/comment-activity", fetchImpl));
    expect(calls).toHaveLength(1);
    answer(0, json(activity(1)));
    const [a, b, c] = await Promise.all(reads);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
    now += 1_999;
    expect(await readCommentActivity("demo", "api/comment-activity", fetchImpl)).toBe(a);
    expect(calls).toHaveLength(1);
    now += 1;
    const again = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    expect(calls).toHaveLength(2);
    answer(1, json(activity(2)));
    expect((await again)?.get("view:a")?.totalThreads).toBe(2);
  });

  it("a read out when a comments event arrives is not handed to anyone who asks after the event", async () => {
    const { calls, fetchImpl, answer } = service();
    const before = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    invalidateCommentActivity();
    const after = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    expect(calls).toHaveLength(2);
    // The newer read lands first; the older one landing afterwards does not replace it.
    answer(1, json(activity(2)));
    expect((await after)?.get("view:a")?.totalThreads).toBe(2);
    answer(0, json(activity(1)));
    expect((await before)?.get("view:a")?.totalThreads).toBe(1);
    expect((await readCommentActivity("demo", "api/comment-activity", fetchImpl))?.get("view:a")?.totalThreads).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("only the asker that starts a request tags it: a tick joining a read in flight makes no request", async () => {
    const { calls, fetchImpl, answer } = service();
    const tick = readCommentActivity("demo", "api/comment-activity", fetchImpl, { [POLL_HEADER]: "notifications#4" });
    const plain = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    const tickAgain = readCommentActivity("demo", "api/comment-activity", fetchImpl, {
      [POLL_HEADER]: "notifications#5",
    });
    expect(calls).toEqual([{ url: "api/comment-activity", poll: "notifications#4", etag: null }]);
    answer(0, json(activity(1)));
    expect(await plain).toBe(await tick);
    expect(await tickAgain).toBe(await tick);
    // A tick inside the 2 s takes what is held.
    expect(
      await readCommentActivity("demo", "api/comment-activity", fetchImpl, { [POLL_HEADER]: "notifications#6" }),
    ).toBe(await tick);
    expect(calls).toHaveLength(1);
  });

  it("a failed read is forgotten at once: the next ask reads again", async () => {
    const { calls, fetchImpl, answer } = service();
    const failed = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    answer(0, new Response("", { status: 500 }));
    expect(await failed).toBeNull();
    const next = readCommentActivity("demo", "api/comment-activity", fetchImpl);
    expect(calls).toHaveLength(2);
    answer(1, json(activity(3)));
    expect((await next)?.get("view:a")?.totalThreads).toBe(3);
  });
});

describe("the project catalog (one read per fetcher, 1.5 s, ETag)", () => {
  const project = (slug: string, state = "active") => ({
    slug,
    name: slug.toUpperCase(),
    views: [],
    notes: [],
    lifecycle: { state, visibility: "auto" },
  });
  const catalog = (...projects: unknown[]) => ({ schemaVersion: 1, projects });

  it("concurrent loads share one request; a load inside 1.5 s takes the answer; one after it asks with the ETag", async () => {
    const { calls, fetchImpl, answer } = service();
    const loads = [1, 2, 3].map(() => loadProjectCatalog(fetchImpl));
    expect(calls).toHaveLength(1);
    answer(0, json(catalog(project("one")), { etag: 'W/"c1"' }));
    const [a, b, c] = await Promise.all(loads);
    expect(a.status).toBe("ready");
    expect(b).toBe(a);
    expect(c).toBe(a);
    now += 1_499;
    expect(await loadProjectCatalog(fetchImpl)).toBe(a);
    expect(calls).toHaveLength(1);
    now += 1;
    const again = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.etag).toBe('W/"c1"');
    answer(1, new Response(null, { status: 304, headers: { etag: 'W/"c1"' } }));
    // Unchanged: the very catalog held, so nothing downstream rebuilds.
    expect(await again).toBe(a);
    expect(rememberedProjectCatalog(fetchImpl)).toBe(a);
  });

  it("an answer with the same text keeps the objects held; the watchers hear every ready answer", async () => {
    const { calls, fetchImpl, answer } = service();
    const heard: unknown[] = [];
    const stop = watchProjectCatalog(fetchImpl, (projects) => heard.push(projects));
    const first = loadProjectCatalog(fetchImpl);
    answer(0, json(catalog(project("one"))));
    const a = await first;
    now += 20_000;
    const second = loadProjectCatalog(fetchImpl);
    await settle();
    answer(1, json(catalog(project("one"))));
    const b = await second;
    expect(b).toBe(a);
    expect(calls).toHaveLength(2);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toBe(heard[0]);
    // A late watcher hears the held catalog at once, with no request.
    const late: unknown[] = [];
    const stopLate = watchProjectCatalog(fetchImpl, (projects) => late.push(projects));
    expect(late).toEqual([heard[0]]);
    expect(calls).toHaveLength(2);
    stop();
    stopLate();
  });

  it("a documents event while a read is out: a load after it shares that read (one request)", async () => {
    const { calls, fetchImpl, answer } = service();
    const first = loadProjectCatalog(fetchImpl);
    answer(0, json(catalog(project("one"))));
    await first;
    now += 20_000;
    const out = loadProjectCatalog(fetchImpl);
    await settle();
    markProjectCatalogStale();
    const after = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(2);
    answer(1, json(catalog(project("one"), project("two"))));
    expect(await after).toBe(await out);
    // Answered now: fresh again.
    await loadProjectCatalog(fetchImpl);
    expect(calls).toHaveLength(2);
  });

  it("a documents event with no read out: the next load reads, whatever the held answer's age", async () => {
    const { calls, fetchImpl, answer } = service();
    const first = loadProjectCatalog(fetchImpl);
    answer(0, json(catalog(project("one"))));
    await first;
    markProjectCatalogStale();
    const next = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(2);
    answer(1, json(catalog(project("one"), project("two"))));
    const read = await next;
    expect(read.status === "ready" && read.projects.map((p) => p.slug)).toEqual(["one", "two"]);
  });

  it("a lifecycle edit shows at once, and a read that set out before it cannot bring the former lifecycle back", async () => {
    const { calls, fetchImpl, answer } = service();
    const heard: string[] = [];
    const stop = watchProjectCatalog(fetchImpl, (projects) => heard.push(projects[0]!.lifecycle.state));
    const first = loadProjectCatalog(fetchImpl);
    answer(0, json(catalog(project("alpha-12345678"))));
    await first;
    now += 20_000;
    const racing = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(2);
    updateRememberedProjectLifecycle(fetchImpl, "alpha-12345678", { state: "inactive", visibility: "hidden" } as never);
    const held = rememberedProjectCatalog(fetchImpl);
    expect(held?.status === "ready" && held.projects[0]!.lifecycle.state).toBe("inactive");
    // The confirming read is its own request: it does not join the one that set out before the edit.
    const confirming = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.etag).toBeNull();
    answer(2, json(catalog(project("alpha-12345678", "inactive"))));
    const confirmed = await confirming;
    expect(confirmed.status === "ready" && confirmed.projects[0]!.lifecycle.state).toBe("inactive");
    answer(1, json(catalog(project("alpha-12345678", "active"))));
    const late = await racing;
    expect(late.status === "ready" && late.projects[0]!.lifecycle.state).toBe("inactive");
    const remembered = rememberedProjectCatalog(fetchImpl);
    expect(remembered?.status === "ready" && remembered.projects[0]!.lifecycle.state).toBe("inactive");
    expect(heard).toEqual(["active", "inactive"]);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("a tick joining a load in flight makes no request, and the request carries only its starter's tag", async () => {
    const { calls, fetchImpl, answer } = service();
    const plain = loadProjectCatalog(fetchImpl);
    const tick = loadProjectCatalog(fetchImpl, { [POLL_HEADER]: "project-catalog#2" });
    await settle();
    expect(calls).toEqual([{ url: "api/browser-projects", poll: null, etag: null }]);
    answer(0, json(catalog(project("one"))));
    expect(await tick).toBe(await plain);
    // A tick inside 1.5 s takes the answer; one after it reads with its own tag.
    expect(await loadProjectCatalog(fetchImpl, { [POLL_HEADER]: "project-catalog#3" })).toBe(await plain);
    now += 1_500;
    const own = loadProjectCatalog(fetchImpl, { [POLL_HEADER]: "project-catalog#4" });
    await settle();
    expect(calls.map((c) => c.poll)).toEqual([null, "project-catalog#4"]);
    answer(1, json(catalog(project("one"))));
    await own;
  });

  it("a failed refresh keeps the last good catalog, and the next load reads again", async () => {
    const { calls, fetchImpl, answer } = service();
    const first = loadProjectCatalog(fetchImpl);
    answer(0, json(catalog(project("one"))));
    const good = await first;
    now += 20_000;
    const failing = loadProjectCatalog(fetchImpl);
    await settle();
    answer(1, new Response("", { status: 500 }));
    expect(await failing).toBe(good);
    const next = loadProjectCatalog(fetchImpl);
    await settle();
    expect(calls).toHaveLength(3);
    answer(2, json(catalog(project("one"))));
    await next;
  });

  it("a first read that fails is remembered as an error", async () => {
    const { fetchImpl, answer } = service();
    const first = loadProjectCatalog(fetchImpl);
    await settle();
    answer(0, new Response("", { status: 500 }));
    expect(await first).toEqual({ status: "error" });
    expect(rememberedProjectCatalog(fetchImpl)).toEqual({ status: "error" });
  });
});

describe("the authoring status (one read per project, 3 s)", () => {
  it("concurrent askers share one request; a save forgets it, so the next asker reads", async () => {
    const { calls, fetchImpl, answer } = service();
    vi.stubGlobal("fetch", fetchImpl);
    const a = authoringStatus(),
      b = authoringStatus();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/api\/authoring$/);
    answer(0, json({ authorized: false }));
    expect(await a).toEqual({ authorized: false });
    expect(await b).toEqual(await a);
    expect(await authoringStatus()).toEqual({ authorized: false });
    expect(calls).toHaveLength(1);
    forgetAuthoringStatus();
    const c = authoringStatus();
    await settle();
    expect(calls).toHaveLength(2);
    answer(1, json({ authorized: false }));
    await c;
  });
});

describe("a note's diagram (shared at the revision the page knows, 2 s)", () => {
  const address = "notes/n.md#flow";
  const body = (revision: string) => ({
    name: "flow",
    address,
    explicit: true,
    ordinal: 1,
    heading: null,
    kind: "flowchart",
    line: 3,
    bodyLine: 4,
    writable: true,
    sourceRevision: `s-${revision}`,
    notePath: "notes/n.md",
    source: `flowchart LR\n ${revision}`,
    diagnostics: [],
    envelope: { schemaVersion: 1, view: {}, revision, model: {} },
    freshness: { status: "not-in-git" },
  });

  it("concurrent readers at one revision share a request; a reader that knows a newer revision reads", async () => {
    const { calls, fetchImpl, answer } = service();
    const transport = httpCommentsTransport(fetchImpl);
    const a = transport.embeddedDiagram!(address, "r1"),
      b = transport.embeddedDiagram!(address, "r1");
    await settle();
    expect(calls).toHaveLength(1);
    answer(0, json(body("r1")));
    expect(await a).toEqual(await b);
    await transport.embeddedDiagram!(address, "r1");
    expect(calls).toHaveLength(1);
    const newer = transport.embeddedDiagram!(address, "r2");
    await settle();
    expect(calls).toHaveLength(2);
    answer(1, json(body("r2")));
    expect((await newer).source).toBe("flowchart LR\n r2");
  });

  it("a reader joining a read that answers at an older revision than it knows reads once more", async () => {
    const { calls, fetchImpl, answer } = service();
    const transport = httpCommentsTransport(fetchImpl);
    const first = transport.embeddedDiagram!(address, "r1");
    await settle();
    const joined = transport.embeddedDiagram!(address, "r2");
    await settle();
    expect(calls).toHaveLength(1);
    answer(0, json(body("r1")));
    expect((await first).source).toBe("flowchart LR\n r1");
    await settle();
    expect(calls).toHaveLength(2);
    answer(1, json(body("r2")));
    expect((await joined).source).toBe("flowchart LR\n r2");
  });
});

describe("the file route's hand-off to the project page (3 s, once)", () => {
  const listing = (url: string): unknown =>
    url.endsWith("api/diagrams")
      ? { schemaVersion: 1, views: [] }
      : url.endsWith("api/notes/all")
        ? { notes: [] }
        : { documents: [] };

  it("hands each listing it read over once inside 3 s; past 3 s the page asks the service", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return json(listing(url));
      }),
    );
    expect(await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined)).toBe(
      "document",
    );
    expect(seen).toHaveLength(3);
    now += FILE_ROUTE_HANDOFF_MS;
    expect(await takeFileRouteRead("https://host/p/shop/api/diagrams")).toEqual({ schemaVersion: 1, views: [] });
    expect(takeFileRouteRead("https://host/p/shop/api/diagrams")).toBeUndefined();
    now += 1;
    expect(takeFileRouteRead("https://host/p/shop/api/notes/all")).toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  it("the file route's own reads join one in flight, never an answer it already holds", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return json(listing(url));
      }),
    );
    await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined);
    await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined);
    expect(seen).toHaveLength(6);
  });

  it("a diagram read ahead is one request: the page joins it, takes it once with its seq and ETag", async () => {
    const { calls, fetchImpl, answer } = service();
    vi.stubGlobal("fetch", fetchImpl);
    const url = "https://host/p/shop/api/diagrams/flow";
    readAhead(url);
    readAhead(url);
    expect(calls).toHaveLength(1);
    expect(fileRouteReading(url)).toBe(true);
    const joined = awaitFileRouteEntry(url);
    answer(0, json({ view: { id: "flow" } }, { etag: 'W/"e1"', "x-archer-event-seq": "7" }));
    expect(await joined).toEqual({ body: { view: { id: "flow" } }, seq: 7, etag: 'W/"e1"' });
    expect(fileRouteReading(url)).toBe(false);
    expect(await awaitFileRouteEntry(url)).toBeUndefined();
    // Taken: a later read ahead asks again.
    readAhead(url);
    expect(calls).toHaveLength(2);
    answer(1, json({ view: { id: "flow" } }));
    await settle();
  });
});
