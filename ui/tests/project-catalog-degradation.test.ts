import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetProjectCatalogs,
  loadProjectCatalog,
  markProjectCatalogStale,
  rememberedProjectCatalog,
  updateRememberedProjectLifecycle,
  parseProjectCatalog,
  parseProjectCatalogEntries,
  PROJECT_ENTRY_BUDGET,
} from "../src/app/project-directory";

const view = (id: string) => ({
  id,
  title: id,
  kind: "freeform",
  registration: "durable",
  sourcePath: `system/${id}.mmd`,
});
const note = (n: number) => ({ path: `notes/n${n}.md`, title: `N${n}`, viewIds: [] });
const project = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  views: [view("a")],
  notes: [note(1)],
  ...extra,
});
const catalog = (...projects: unknown[]) => ({ schemaVersion: 1, projects });

afterEach(() => {
  forgetProjectCatalogs();
  vi.restoreAllMocks();
});

describe("a project that cannot be listed does not take the others with it", () => {
  it("lists the good projects and names the one that is too large", () => {
    const huge = project("big", { notes: Array.from({ length: PROJECT_ENTRY_BUDGET + 1 }, (_, i) => note(i)) });
    const parsed = parseProjectCatalogEntries(catalog(project("one"), huge, project("two")));
    expect(parsed?.projects.map((p) => p.slug)).toEqual(["one", "two"]);
    expect(parsed?.unavailable).toEqual([{ slug: "big", name: "BIG", problem: "too-large" }]);
  });

  it("names a malformed project, keeping its slug and name when they are sound", () => {
    const parsed = parseProjectCatalogEntries(
      catalog(project("one"), project("odd", { views: "nope" }), project("two")),
    );
    expect(parsed?.projects.map((p) => p.slug)).toEqual(["one", "two"]);
    expect(parsed?.unavailable).toEqual([{ slug: "odd", name: "ODD", problem: "malformed" }]);
  });

  it("still refuses the whole catalog for a wrong schema, more than 64 projects or a repeated slug", () => {
    expect(parseProjectCatalogEntries({ schemaVersion: 2, projects: [project("one")] })).toBeNull();
    expect(parseProjectCatalogEntries(catalog(...Array.from({ length: 65 }, (_, i) => project(`p${i}`))))).toBeNull();
    expect(parseProjectCatalogEntries(catalog(project("one"), project("one")))).toBeNull();
  });

  it("keeps parseProjectCatalog to the projects it can list", () => {
    expect(parseProjectCatalog(catalog(project("one"), project("odd", { name: "" })))?.map((p) => p.slug)).toEqual([
      "one",
    ]);
  });

  it("property: whatever one project holds, every valid sibling is still listed", () => {
    let seed = 0x1234567;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const junk: unknown[] = [
      null,
      true,
      0,
      1,
      "",
      "x",
      [],
      {},
      [1],
      { a: 1 },
      Array(5).fill(null),
      -1,
      "a".repeat(600),
    ];
    const fields = ["slug", "name", "views", "notes", "lifecycle", "documents", "description", "facts", "worktree"];
    for (let i = 0; i < 2000; i++) {
      const bad: Record<string, unknown> = project("bad");
      const field = fields[next() % fields.length]!;
      bad[field] = junk[next() % junk.length];
      if (next() % 4 === 0) delete bad[field];
      const parsed = parseProjectCatalogEntries(catalog(project("first"), bad, project("last")));
      const slugs = parsed?.projects.map((p) => p.slug) ?? [];
      expect(slugs).toContain("first");
      expect(slugs).toContain("last");
    }
  });
});

describe("an answer that has not changed is the same answer", () => {
  const respond = (body: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => structuredClone(body) }) as unknown as Response);

  it("gives back the same projects when the catalog reads the same twice", async () => {
    const body = catalog(project("one"), project("two"));
    const fetchImpl = respond(body);
    const first = await loadProjectCatalog(fetchImpl);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    const second = await loadProjectCatalog(fetchImpl);
    vi.useRealTimers();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.status === "ready" && second.status === "ready" && second.projects === first.projects).toBe(true);
  });

  it("gives new projects when something changed", async () => {
    let body: unknown = catalog(project("one"));
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => structuredClone(body) }) as unknown as Response,
    );
    const first = await loadProjectCatalog(fetchImpl);
    body = catalog(project("one"), project("two"));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    const second = await loadProjectCatalog(fetchImpl);
    vi.useRealTimers();
    expect(first.status === "ready" && second.status === "ready" && second.projects.length).toBe(2);
  });
});

describe("a lifecycle edit and the answer that follows it", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
  const inactive = { state: "inactive", visibility: "hidden", reason: "manual" } as never;

  it("a read that set out before the edit cannot make the confirming read return the patched catalog", async () => {
    const before = catalog(project("alpha-12345678"));
    const after = catalog({ ...project("alpha-12345678"), notes: [note(1), note(2)], lifecycle: inactive });
    let release!: (r: Response) => void;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return ok(before);
      if (calls === 2)
        return new Promise<Response>((r) => {
          release = r;
        });
      return ok(after);
    });
    await loadProjectCatalog(fetchImpl);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    const poll = loadProjectCatalog(fetchImpl);
    await vi.advanceTimersByTimeAsync(0);
    updateRememberedProjectLifecycle(fetchImpl, "alpha-12345678", inactive);
    release(ok(after));
    await poll;
    const confirmed = await loadProjectCatalog(fetchImpl);
    vi.useRealTimers();
    expect(confirmed.status === "ready" && confirmed.projects[0]!.notes.length).toBe(2);
  });

  it("keeps the projects not listed through a lifecycle edit", async () => {
    const body = catalog(project("alpha-12345678"), project("odd-44444444", { views: "x" }));
    const fetchImpl = vi.fn(async () => ok(body));
    await loadProjectCatalog(fetchImpl);
    updateRememberedProjectLifecycle(fetchImpl, "alpha-12345678", inactive);
    const held = rememberedProjectCatalog(fetchImpl);
    expect(held?.status === "ready" && held.unavailable?.map((p) => p.slug)).toEqual(["odd-44444444"]);
  });

  it("compares the raw text, so an identical answer is not parsed again", async () => {
    const text = vi.fn(async () => JSON.stringify(catalog(project("one"))));
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text,
          json: async () => {
            throw new Error("json read");
          },
        }) as unknown as Response,
    );
    const first = await loadProjectCatalog(fetchImpl);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    const second = await loadProjectCatalog(fetchImpl);
    vi.useRealTimers();
    expect(first.status === "ready" && second.status === "ready" && second.projects === first.projects).toBe(true);
  });
});

describe("the catalog's validator: an unchanged catalog costs a 304, not the body", () => {
  const later = async <T>(read: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    try {
      return await read();
    } finally {
      vi.useRealTimers();
    }
  };
  const headersOf = (init: RequestInit | undefined): Record<string, string> =>
    (init?.headers ?? {}) as Record<string, string>;

  it("sends back the ETag it was given, and a 304 keeps the catalog it holds, unparsed and unchanged", async () => {
    const body = JSON.stringify(catalog(project("one"), project("two")));
    const inits: (RequestInit | undefined)[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      inits.push(init);
      calls++;
      if (calls === 1)
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: 'W/"abc"' }),
          text: async () => body,
        } as unknown as Response;
      return {
        ok: false,
        status: 304,
        headers: new Headers({ etag: 'W/"abc"' }),
        text: async () => {
          throw new Error("a 304 has no body");
        },
      } as unknown as Response;
    });
    const first = await loadProjectCatalog(fetchImpl);
    expect(headersOf(inits[0])["if-none-match"]).toBeUndefined();
    const second = await later(() => loadProjectCatalog(fetchImpl));
    expect(headersOf(inits[1])["if-none-match"]).toBe('W/"abc"');
    expect(inits[1]?.cache).toBe("no-store");
    expect(second.status).toBe("ready");
    expect(first.status === "ready" && second.status === "ready" && second.projects === first.projects).toBe(true);
  });

  it("sends no validator once a lifecycle edit has replaced the catalog it named", async () => {
    const body = JSON.stringify(catalog(project("alpha-12345678")));
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      inits.push(init);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'W/"abc"' }),
        text: async () => body,
      } as unknown as Response;
    });
    await loadProjectCatalog(fetchImpl);
    updateRememberedProjectLifecycle(fetchImpl, "alpha-12345678", {
      state: "inactive",
      visibility: "hidden",
      reason: "manual",
    } as never);
    await loadProjectCatalog(fetchImpl);
    expect(headersOf(inits[1])["if-none-match"]).toBeUndefined();
  });

  it("keeps a validator first given with an unchanged body (an older service gaining ETags), and the catalog it holds", async () => {
    const body = JSON.stringify(catalog(project("one")));
    const inits: (RequestInit | undefined)[] = [];
    const tags = [undefined, 'W/"new"', 'W/"new"'];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      inits.push(init);
      const tag = tags[inits.length - 1];
      if (inits.length === 3)
        return {
          ok: false,
          status: 304,
          headers: new Headers({ etag: 'W/"new"' }),
          text: async () => {
            throw new Error("a 304 has no body");
          },
        } as unknown as Response;
      return {
        ok: true,
        status: 200,
        headers: new Headers(tag === undefined ? {} : { etag: tag }),
        text: async () => body,
      } as unknown as Response;
    });
    const first = await loadProjectCatalog(fetchImpl);
    const second = await later(() => loadProjectCatalog(fetchImpl));
    expect(headersOf(inits[1])["if-none-match"]).toBeUndefined();
    markProjectCatalogStale();
    const third = await later(() => loadProjectCatalog(fetchImpl));
    expect(headersOf(inits[2])["if-none-match"]).toBe('W/"new"');
    expect(first.status === "ready" && second === first && third === first).toBe(true);
  });
});
