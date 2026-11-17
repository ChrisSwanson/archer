import { afterEach, expect, it, vi } from "vitest";
import {
  FILE_ROUTE_HANDOFF_MS,
  fileRouteAlias,
  forgetFileRouteReads,
  readFileRoute,
  resolveFileRoute,
  takeFileRouteRead,
} from "../src/app/file-route";
import { awaitFileRouteEntry } from "../src/app/file-route-reads";

const views = [
  { id: "flow", sourcePath: "diagrams/flow.mmd", registration: "durable" as const },
  { id: "notes/a.md#login", sourcePath: "notes/a.md", registration: "embedded" as const },
];
const notes = [{ path: "notes/a.md" }, { path: "docs/guide.md" }];

it.each([
  ["notes/a.md", undefined, "archer"],
  ["notes/a.md", "login", "archer"],
  ["diagrams/flow.mmd", undefined, "archer"],
  // `.archer` wins: the shadowed repository document is reachable only at -/repo/.
  ["docs/guide.md", undefined, "archer"],
  ["README.md", undefined, "document"],
  ["notes/missing.md", undefined, "document"],
  ["notes/a.md/extra", undefined, "document"],
] as const)("a file at %s (#%s) opens as %s", (path, fragment, expected) => {
  expect(resolveFileRoute(path, fragment, views, notes)).toBe(expected);
});

afterEach(() => vi.unstubAllGlobals());
it("reads the project files from its own resource base, and leaves the decision to the project page when they cannot be read", async () => {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(
        JSON.stringify(url.endsWith("api/diagrams") ? { schemaVersion: 1, views: [] } : { notes: [] }),
        { status: 200 },
      );
    }),
  );
  expect(await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined)).toBe("document");
  // Not an Archer-folder file by its folder path: the catalog says whether it is one by its project path.
  expect(seen.sort()).toEqual([
    "https://host/p/shop/api/diagrams",
    "https://host/p/shop/api/documents",
    "https://host/p/shop/api/notes/all",
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
  expect(await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined)).toBe("archer");
});

it("two opens of the same file at once share one read of each listing (perf: file-route)", async () => {
  forgetFileRouteReads();
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(
        JSON.stringify(url.endsWith("api/diagrams") ? { schemaVersion: 1, views: [] } : { notes: [] }),
        { status: 200 },
      );
    }),
  );
  const both = await Promise.all([
    readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined),
    readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined),
  ]);
  expect(both).toEqual(["document", "document"]);
  expect(seen).toHaveLength(3);
});

it("hands each listing it read to the project page once, while it is fresh", async () => {
  forgetFileRouteReads();
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify(url.endsWith("api/diagrams") ? { schemaVersion: 1, views: [] } : { notes: [] }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined);
  const handed = takeFileRouteRead("https://host/p/shop/api/diagrams");
  expect(await handed).toEqual({ schemaVersion: 1, views: [] });
  // Once: a later read asks the service again.
  expect(takeFileRouteRead("https://host/p/shop/api/diagrams")).toBeUndefined();
  // Not after it has gone stale.
  expect(
    takeFileRouteRead("https://host/p/shop/api/notes/all", Date.now() + FILE_ROUTE_HANDOFF_MS + 1),
  ).toBeUndefined();
  expect(takeFileRouteRead("https://host/p/other/api/notes/all")).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("hands over nothing it failed to read", async () => {
  forgetFileRouteReads();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
  await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined);
  expect(takeFileRouteRead("https://host/p/shop/api/diagrams")).toBeUndefined();
});

const catalog = (documents: unknown[]) => ({ documents, complete: true, diagnostics: [] });
const doc = (path: string, legacy?: Record<string, string>) => ({
  source: { path },
  kind: path.endsWith(".md") ? "markdown" : "mermaid",
  title: path,
  capabilities: { read: true, sourceWrite: false, comments: true, emphasis: true },
  ...(legacy ? { legacy } : {}),
});
it("an Archer-folder file named by its project path resolves to its canonical address, in this document (perf #3)", async () => {
  forgetFileRouteReads();
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      const body = url.endsWith("api/diagrams")
        ? {
            schemaVersion: 1,
            views: [
              {
                id: "flow",
                kind: "flowchart",
                title: "Flow",
                registration: "durable",
                sourcePath: "diagrams/flow.mmd",
              },
            ],
          }
        : url.endsWith("api/notes/all")
          ? { notes: [] }
          : catalog([
              doc(".archer/diagrams/flow.mmd", { viewId: "flow" }),
              doc(".archer/notes/a.md", { notePath: "notes/a.md" }),
              doc("README.md"),
            ]);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  expect(
    await readFileRoute(
      "https://host/projects/shop/.archer/diagrams/flow.mmd",
      "shop",
      ".archer/diagrams/flow.mmd",
      undefined,
    ),
  ).toEqual({ canonical: "/projects/shop/diagrams/flow.mmd" });
  expect(
    await readFileRoute("https://host/projects/shop/.archer/notes/a.md", "shop", ".archer/notes/a.md", undefined),
  ).toEqual({ canonical: "/projects/shop/notes/a.md" });
  expect(await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined)).toBe("document");
  // The canonical address is answered from the listings alone: no catalog read.
  seen.length = 0;
  forgetFileRouteReads();
  expect(
    await readFileRoute("https://host/projects/shop/diagrams/flow.mmd", "shop", "diagrams/flow.mmd", undefined),
  ).toBe("archer");
  expect(seen.some((url) => url.endsWith("api/documents"))).toBe(false);
});
it("the catalog read is handed to the document page, so a real document asks once", async () => {
  forgetFileRouteReads();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("api/diagrams")
              ? { schemaVersion: 1, views: [] }
              : url.endsWith("api/notes/all")
                ? { notes: [] }
                : catalog([doc("README.md")]),
          ),
          { status: 200 },
        ),
    ),
  );
  expect(await readFileRoute("https://host/projects/shop/README.md", "shop", "README.md", undefined)).toBe("document");
  expect(await takeFileRouteRead("https://host/p/shop/api/documents")).toEqual(catalog([doc("README.md")]));
});
it("a diagram whose file is unknown, or an unreadable catalog, stays on the document page", () => {
  expect(fileRouteAlias("shop", ".archer/x.mmd", catalog([doc(".archer/x.mmd", { viewId: "x" })]), [])).toBeNull();
  expect(fileRouteAlias("shop", ".archer/x.mmd", null, [])).toBeNull();
  expect(
    fileRouteAlias("shop", ".archer/n.md", catalog([doc(".archer/n.md", { viewId: "notes/n.md#login" })]), []),
  ).toEqual({ canonical: "/projects/shop/notes/n.md#login" });
});

const listed = views.map((view) => ({ ...view, kind: "flowchart", title: view.id }));
const listedNotes = notes.map((note) => ({ ...note, title: note.path, viewIds: [] }));
it("a diagram file starts the read of its diagram as soon as the listing names it, and hands it to the page once (speed: diagram at page start)", async () => {
  forgetFileRouteReads();
  const seen: string[] = [];
  let answer: (() => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      if (url.endsWith("api/diagrams/flow")) {
        await new Promise<void>((r) => {
          answer = r;
        });
        return new Response(JSON.stringify({ view: { id: "flow" } }), {
          status: 200,
          headers: { etag: 'W/"e1"', "x-archer-event-seq": "7" },
        });
      }
      return new Response(
        JSON.stringify(url.endsWith("api/diagrams") ? { schemaVersion: 1, views: listed } : { notes: listedNotes }),
        { status: 200 },
      );
    }),
  );
  // The route is decided without waiting for the diagram.
  expect(
    await readFileRoute("https://host/projects/shop/diagrams/flow.mmd", "shop", "diagrams/flow.mmd", undefined),
  ).toBe("archer");
  expect(seen).toContain("https://host/p/shop/api/diagrams/flow");
  // The page's read joins the one in flight instead of asking again.
  const joined = awaitFileRouteEntry("https://host/p/shop/api/diagrams/flow");
  answer!();
  expect(await joined).toEqual({ body: { view: { id: "flow" } }, seq: 7, etag: 'W/"e1"' });
  expect(await awaitFileRouteEntry("https://host/p/shop/api/diagrams/flow")).toBeUndefined();
  expect(seen.filter((url) => url.endsWith("api/diagrams/flow"))).toHaveLength(1);
});

it("a note, or a diagram embedded in one, reads no diagram ahead", async () => {
  forgetFileRouteReads();
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(
        JSON.stringify(url.endsWith("api/diagrams") ? { schemaVersion: 1, views: listed } : { notes: listedNotes }),
        { status: 200 },
      );
    }),
  );
  expect(await readFileRoute("https://host/projects/shop/notes/a.md", "shop", "notes/a.md", "login")).toBe("archer");
  expect(await readFileRoute("https://host/projects/shop/notes/a.md", "shop", "notes/a.md", undefined)).toBe("archer");
  expect(seen.filter((url) => !/api\/(diagrams|notes\/all)$/.test(url))).toEqual([]);
});

// The flow page's layout worker starts with this route's own inventory read at boot (~136 ms), not once the bridge
// applies the inventory after the first render (~177 ms; 0.10.0 started it at boot, ~134 ms, on every page).
it("starts the layout worker when the file is a graph diagram, and not for a sequence, a journey or a document", async () => {
  const start = vi.fn();
  const listed = [
    { id: "flow", kind: "flowchart", title: "Flow", sourcePath: "diagrams/flow.mmd", registration: "durable" },
    { id: "seq", kind: "sequence", title: "Seq", sourcePath: "diagrams/seq.mmd", registration: "durable" },
    { id: "trip", kind: "journey", title: "Trip", sourcePath: "diagrams/trip.mmd", registration: "durable" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("api/diagrams")
              ? { schemaVersion: 1, views: listed }
              : url.endsWith("api/notes/all")
                ? { notes: [] }
                : { documents: [] },
          ),
          { status: 200 },
        ),
    ),
  );
  for (const [path, starts] of [
    ["diagrams/seq.mmd", false],
    ["diagrams/trip.mmd", false],
    ["README.md", false],
    ["diagrams/flow.mmd", true],
  ] as const) {
    forgetFileRouteReads();
    start.mockClear();
    await readFileRoute(`https://host/projects/shop/${path}`, "shop", path, undefined, start);
    expect(start.mock.calls.length, path).toBe(starts ? 1 : 0);
  }
});
