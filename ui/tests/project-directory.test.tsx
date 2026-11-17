// The project catalog (api/projects) and links to another project's page
// (src/app/project-directory.ts). The sidebar lists the catalog's names; the
// search page its files (search-page.test.tsx).
import { expect, test, vi } from "vitest";
import {
  directoryProjectUrl,
  parseProjectCatalog,
  projectSlugFromPath,
  loadProjectCatalog,
  forgetProjectCatalogs,
  markProjectCatalogStale,
} from "../src/app/project-directory";

const view = {
  id: "checkout",
  title: "Checkout",
  kind: "freeform",
  registration: "durable" as const,
  sourcePath: "systems/checkout-flow.mmd",
};
const note = { path: "notes/operations.md", title: "Operations", viewIds: [] };
const catalog = {
  schemaVersion: 1,
  projects: [
    { slug: "pageturner-a1234567", name: "Pageturner Books", views: [view], notes: [note] },
    { slug: "courierdesk-b1234567", name: "Courierdesk", views: [view], notes: [note] },
  ],
};
const base = { baseUrl: "http://localhost:123/projects/pageturner-a1234567/?follow&keep=yes&view=here&q=q&kind=note" };

test("project routing stays on the service and names each destination by its clean address", () => {
  expect(projectSlugFromPath("/projects/courierdesk-b1234567/")).toBe("courierdesk-b1234567");
  const link = new URL(directoryProjectUrl(base.baseUrl, "courierdesk-b1234567", { note: "notes/operations.md" })!);
  expect(link.origin).toBe("http://localhost:123");
  expect(link.pathname).toBe("/projects/courierdesk-b1234567/notes/operations.md");
  // This page's place and parameters do not carry over to another project's.
  expect(link.search).toBe("");
  expect(directoryProjectUrl(base.baseUrl, "courierdesk-b1234567")).toBe(
    "http://localhost:123/projects/courierdesk-b1234567/",
  );
  expect(
    directoryProjectUrl(base.baseUrl, "courierdesk-b1234567", { view: "flow", sourcePath: "diagrams/flow.mmd" }),
  ).toBe("http://localhost:123/projects/courierdesk-b1234567/diagrams/flow.mmd");
  expect(directoryProjectUrl(base.baseUrl, "../escape", { overview: true })).toBeNull();
  // A token-prefixed page (retired in 0.15.0) names no project to route from.
  expect(projectSlugFromPath("/token/p/courierdesk-b1234567/")).toBeNull();
  expect(directoryProjectUrl("http://localhost:123/token/p/pageturner-a1234567/", "courierdesk-b1234567")).toBeNull();
});

test("catalog refuses incompatible, duplicate and too many projects; a bad project alone is left out", () => {
  expect(parseProjectCatalog(catalog)).toHaveLength(2);
  // Its files carry their dates and descriptions (projects-and-search.md).
  expect(
    parseProjectCatalog({
      ...catalog,
      projects: [
        {
          ...catalog.projects[0],
          views: [{ ...view, description: "How checkout works", modifiedAt: "2026-10-10T00:00:00Z" }],
        },
      ],
    })?.[0]?.views[0],
  ).toMatchObject({ description: "How checkout works", modifiedAt: "2026-10-10T00:00:00Z" });
  expect(parseProjectCatalog({ ...catalog, schemaVersion: 2 })).toBeNull();
  expect(parseProjectCatalog({ ...catalog, projects: [catalog.projects[0], catalog.projects[0]] })).toBeNull();
  expect(parseProjectCatalog({ ...catalog, projects: Array(65).fill(catalog.projects[0]) })).toBeNull();
  expect(parseProjectCatalog({ ...catalog, projects: [{ ...catalog.projects[0], slug: "../escape" }] })).toEqual([]);
});

test("a stalled catalog body expires and releases the next refresh", async () => {
  vi.useFakeTimers();
  forgetProjectCatalogs();
  try {
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce({ status: 200, ok: true, json: () => new Promise(() => {}) } as unknown as Response)
      .mockResolvedValue({ status: 200, ok: true, json: async () => catalog } as Response);
    const pending = loadProjectCatalog(fetcher);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await Promise.race([pending, Promise.resolve("still pending")])).toEqual({ status: "error" });
    expect(await loadProjectCatalog(fetcher)).toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    forgetProjectCatalogs();
  }
});

test("tells a watcher each ready catalog its page's own read brings, and the one it already holds, with no read of its own", async () => {
  const { watchProjectCatalog } = await import("../src/app/project-directory");
  forgetProjectCatalogs();
  const body = { schemaVersion: 1, projects: [{ slug: "alpha", name: "Alpha", views: [], notes: [] }] };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const seen: string[][] = [];
  const stop = watchProjectCatalog(fetchImpl, (projects) => seen.push(projects.map((p) => p.slug)));
  expect(fetchImpl).not.toHaveBeenCalled();
  await loadProjectCatalog(fetchImpl);
  expect(seen).toEqual([["alpha"]]);
  const late: string[][] = [];
  const stopLate = watchProjectCatalog(fetchImpl, (projects) => late.push(projects.map((p) => p.slug)));
  expect(late).toEqual([["alpha"]]);
  stop();
  stopLate();
  markProjectCatalogStale();
  await loadProjectCatalog(fetchImpl);
  expect(seen).toHaveLength(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  forgetProjectCatalogs();
});
