// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FileRow } from "../src/app/file-index";
import {
  documentPreviewKey,
  loadDocumentPreview,
  MAX_PREVIEW_CACHE_BYTES,
  MAX_PREVIEW_CACHE_ENTRIES,
  MAX_PREVIEW_PENDING,
} from "../src/app/document-previews";

const row: FileRow = {
  key: "alpha\0view:overview",
  slug: "alpha-12345678",
  projectName: "Alpha",
  current: true,
  kind: "diagram",
  target: "view:overview",
  id: "overview",
  title: "System overview",
  type: "flowchart",
  path: "overview.mmd",
  folder: "",
  failing: false,
  openThreads: 0,
  presented: false,
};

describe("loadDocumentPreview", () => {
  it("exports a current diagram through the production operation API and retains its artifact revision", async () => {
    const artifact = {
      encoding: "base64",
      mimeType: "image/svg+xml",
      width: 120,
      height: 80,
      revision: `sha256:${"1".repeat(64)}`,
      lastGood: false,
      data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M0 0h120"/></svg>'),
    };
    const fetchImpl = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(
      async () =>
        new Response(JSON.stringify(artifact), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const preview = await loadDocumentPreview(row, "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);

    expect(preview).toEqual({
      kind: "diagram",
      src: `data:image/svg+xml;base64,${artifact.data}`,
      revision: artifact.revision,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4400/p/alpha-12345678/api/operations");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "export_diagram",
      arguments: { viewId: "overview", format: "svg", mode: "diagram", theme: "dark", scale: 1, allowLastGood: false },
    });
  });

  it("does not request a broken diagram or a note that already has a description", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const broken = { ...row, failing: true };
    const note: FileRow = {
      ...row,
      key: "alpha\0note:notes/readme.md",
      kind: "note",
      target: "note:notes/readme.md",
      id: "notes/readme.md",
      title: "Readme",
      type: null,
      path: "notes/readme.md",
      failing: false,
      description: "A plain description from the project index.",
      descriptionFrom: "frontmatter",
    };

    expect(
      await loadDocumentPreview(broken, "http://127.0.0.1:4400/p/alpha-12345678/", "light", fetchImpl),
    ).toMatchObject({
      kind: "unavailable",
      message: expect.stringMatching(/does not compile/i),
    });
    expect(await loadDocumentPreview(note, "http://127.0.0.1:4400/p/alpha-12345678/", "light", fetchImpl)).toEqual({
      kind: "note",
      source: "description",
      text: "A plain description from the project index.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads note Markdown through the note-content endpoint and produces a bounded plain-text excerpt", async () => {
    const note: FileRow = {
      ...row,
      key: "alpha\0note:notes/readme.md",
      kind: "note",
      target: "note:notes/readme.md",
      id: "notes/readme.md",
      title: "Readme",
      type: null,
      path: "notes/readme.md",
      failing: false,
    };
    const markdown = `# **Safe** note\n\n${"A sentence about the system. ".repeat(20)}\n\n<script>window.compromised = true</script>`;
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ path: note.id, markdown, revision: "sha256:note" }), { status: 200 }),
    );

    const preview = await loadDocumentPreview(note, "http://127.0.0.1:4400/p/alpha-12345678/", "light", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4400/p/alpha-12345678/api/notes/content?path=notes%2Freadme.md");
    expect(init?.method).toBe("GET");
    expect(preview).toMatchObject({ kind: "note", source: "excerpt" });
    if (preview.kind === "note") {
      expect(preview.text).toContain("Safe note");
      expect(preview.text).not.toContain("<script>");
      expect(preview.text.length).toBeLessThanOrEqual(221);
    }
  });

  it("bounds the shared scheduler and cache by the documented limits", () => {
    expect(MAX_PREVIEW_PENDING).toBe(128);
    expect(MAX_PREVIEW_CACHE_ENTRIES).toBe(48);
    expect(MAX_PREVIEW_CACHE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("starts a fresh same-key flight when the last old subscriber aborts before it settles", async () => {
    let settleOld!: (response: Response) => void;
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      calls++;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          settleOld = resolve;
        });
      return new Response(
        JSON.stringify({
          encoding: "base64",
          mimeType: "image/svg+xml",
          width: 120,
          height: 80,
          revision: `sha256:${"5".repeat(64)}`,
          lastGood: false,
          data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>'),
        }),
        { status: 200 },
      );
    });
    const abandoned = new AbortController();
    const oldFlight = loadDocumentPreview(
      row,
      "http://127.0.0.1:4400/p/alpha-12345678/",
      "dark",
      fetchImpl,
      abandoned.signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    abandoned.abort();
    await expect(oldFlight).rejects.toMatchObject({ name: "AbortError" });
    const replacement = await loadDocumentPreview(row, "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(replacement).toMatchObject({ kind: "diagram", revision: `sha256:${"5".repeat(64)}` });
    settleOld!(
      new Response(
        JSON.stringify({
          encoding: "base64",
          mimeType: "image/svg+xml",
          width: 120,
          height: 80,
          revision: `sha256:${"6".repeat(64)}`,
          lastGood: false,
          data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>'),
        }),
        { status: 200 },
      ),
    );
  });

  it("deduplicates an in-flight export and runs no more than two preview requests at once", async () => {
    const releases: (() => void)[] = [];
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          const viewId = JSON.parse(String(init?.body)).arguments.viewId as string;
          const digit = viewId === "overview" ? "7" : viewId === "one" ? "8" : "9";
          releases.push(() =>
            resolve(
              new Response(
                JSON.stringify({
                  encoding: "base64",
                  mimeType: "image/svg+xml",
                  width: 120,
                  height: 80,
                  revision: `sha256:${digit.repeat(64)}`,
                  lastGood: false,
                  data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>'),
                }),
                { status: 200 },
              ),
            ),
          );
        }),
    );
    const forId = (id: string): FileRow => ({
      ...row,
      key: `alpha\0view:${id}`,
      id,
      target: `view:${id}`,
      title: id,
      path: `${id}.mmd`,
    });
    const first = loadDocumentPreview(row, "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);
    const duplicate = loadDocumentPreview(row, "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);
    const second = loadDocumentPreview(forId("one"), "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);
    const third = loadDocumentPreview(forId("two"), "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(releases).toHaveLength(2);
    releases[0]!();
    await Promise.all([first, duplicate]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    releases[1]!();
    await second;
    releases[2]!();
    await third;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("evicts old entries at the LRU entry bound and keys freshness hints without treating them as revisions", async () => {
    let calls = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      calls++;
      const path = new URL(url).searchParams.get("path");
      return new Response(JSON.stringify({ path, markdown: `# ${path}`, revision: "sha256:note" }), { status: 200 });
    };
    const noteAt = (index: number): FileRow => ({
      ...row,
      key: `alpha\0note:notes/${index}.md`,
      kind: "note",
      target: `note:notes/${index}.md`,
      id: `notes/${index}.md`,
      title: `Note ${index}`,
      type: null,
      path: `notes/${index}.md`,
      failing: false,
    });
    for (let index = 0; index < MAX_PREVIEW_CACHE_ENTRIES + 1; index++) {
      await loadDocumentPreview(noteAt(index), "http://127.0.0.1:4400/p/alpha-12345678/", "light", fetchImpl);
    }
    expect(calls).toBe(MAX_PREVIEW_CACHE_ENTRIES + 1);
    await loadDocumentPreview(noteAt(0), "http://127.0.0.1:4400/p/alpha-12345678/", "light", fetchImpl);
    expect(calls).toBe(MAX_PREVIEW_CACHE_ENTRIES + 2);

    const base = "http://127.0.0.1:4400/p/alpha-12345678/";
    expect(documentPreviewKey(row, base, "light", fetchImpl)).not.toBe(
      documentPreviewKey({ ...row, modifiedAt: "2026-10-11T10:00:00Z" }, base, "light", fetchImpl),
    );
    expect(documentPreviewKey(row, base, "light", fetchImpl)).not.toBe(
      documentPreviewKey({ ...row, type: "sequence" }, base, "light", fetchImpl),
    );
    expect(documentPreviewKey(row, base, "light", fetchImpl)).not.toBe(
      documentPreviewKey({ ...row, title: "Renamed" }, base, "light", fetchImpl),
    );
    expect(documentPreviewKey(row, base, "light", fetchImpl)).not.toBe(
      documentPreviewKey({ ...row, failing: true }, base, "light", fetchImpl),
    );
    expect(documentPreviewKey(row, base, "light", fetchImpl)).not.toBe(
      documentPreviewKey(row, base, "dark", fetchImpl),
    );
  });

  it("never throws for bounded arbitrary note responses, vocabulary-shaped values, or small edits", async () => {
    let seed = 0x4d595df4;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const atom = (): unknown =>
      [null, false, true, 0, -1, "", "# Heading", "<script>x</script>", "\uD800"][Math.floor(random() * 9)];
    const arbitrary = (depth: number): unknown => {
      if (depth <= 0) return atom();
      const shape = Math.floor(random() * 4);
      if (shape === 0) return atom();
      if (shape === 1) return Array.from({ length: Math.floor(random() * 5) }, () => arbitrary(depth - 1));
      const keys = ["path", "markdown", "revision", "frontMatter", "diagrams", "freshness", "extra"];
      return Object.fromEntries(
        Array.from({ length: Math.floor(random() * 5) }, () => [
          keys[Math.floor(random() * keys.length)]!,
          arbitrary(depth - 1),
        ]),
      );
    };
    const vocabulary = {
      path: "notes/property.md",
      frontMatter: { title: "Preview" },
      markdown: "# Preview\n\nA bounded excerpt.",
      revision: `sha256:${"a".repeat(64)}`,
      diagrams: [],
      freshness: { status: "not-in-git" },
    };
    const cases: unknown[] = [undefined, ...Array.from({ length: 40 }, () => arbitrary(4)), vocabulary];
    for (const field of ["path", "frontMatter", "markdown", "revision", "diagrams", "freshness"] as const) {
      for (const edited of [null, false, 4, "\uD800", [], {}]) {
        cases.push({ ...vocabulary, [field]: edited });
      }
    }
    cases.push({ ...vocabulary, markdown: "x".repeat(1_048_577) });

    for (const [index, body] of cases.entries()) {
      const note: FileRow = {
        ...row,
        key: `alpha\0note:notes/property-${index}.md`,
        kind: "note",
        target: `note:notes/property-${index}.md`,
        id: `notes/property-${index}.md`,
        title: `Property ${index}`,
        type: null,
        path: `notes/property-${index}.md`,
        failing: false,
      };
      const fetchImpl = async (): Promise<Response> =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const result = await loadDocumentPreview(note, "http://127.0.0.1:4400/p/alpha-12345678/", "dark", fetchImpl);
      expect(["note", "unavailable"]).toContain(result.kind);
    }
  });
});
it("reads configured Markdown previews by project-relative source identity", async () => {
  const sourceRow: FileRow = {
    ...row,
    key: "alpha\0source:docs/guide.md",
    kind: "note",
    id: "docs/guide.md",
    target: "note:docs/guide.md",
    path: "docs/guide.md",
    folder: "docs",
    sourceDocumentPath: "docs/guide.md",
  };
  const fetchImpl = vi.fn(
    async (_url: string) =>
      new Response(
        JSON.stringify({
          source: { path: "docs/guide.md" },
          kind: "markdown",
          revision: "sha256:" + "1".repeat(64),
          text: "# Guide\n\nUseful setup.",
          markdown: "# Guide\n\nUseful setup.",
        }),
        { status: 200 },
      ),
  );
  expect(
    await loadDocumentPreview(sourceRow, "http://localhost/projects/alpha-12345678/", "light", fetchImpl),
  ).toMatchObject({ kind: "note", text: "Guide Useful setup." });
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(
    "http://localhost/p/alpha-12345678/api/documents/content?path=docs%2Fguide.md",
  );
});

describe("prefetchServiceThumbnails (perf #7)", () => {
  it("asks for each compiled diagram's thumbnail once, an embedded one by its address, at the address its card will use", async () => {
    const { prefetchServiceThumbnails, forgetPrefetchedThumbnails, serviceThumbnailUrl } = await import(
      "../src/app/document-previews"
    );
    forgetPrefetchedThumbnails();
    const base = "https://archer.example/projects/shop/?tab=diagrams";
    const rev = `sha256:${"a".repeat(64)}`;
    const views = [
      { id: "flow", registration: "durable", modelRevision: rev },
      { id: "broken", registration: "durable", modelRevision: rev },
      { id: "notes/a.md#login", registration: "embedded", modelRevision: rev },
      { id: "old", registration: "durable" },
    ];
    const asked = prefetchServiceThumbnails(views, new Set(["broken"]), "shop", base, "dark");
    const urlOf = (id: string) =>
      serviceThumbnailUrl(
        { kind: "diagram", failing: false, slug: "shop", current: true, id, modelRevision: rev } as never,
        base,
        "dark",
      );
    expect(asked).toEqual([urlOf("flow"), urlOf("notes/a.md#login")]);
    expect(urlOf("notes/a.md#login")).toContain("api/thumbnails/notes%2Fa.md%23login?rev=");
    // The embedded diagram is claimed already; only the one the first call skipped as failing is new.
    expect(prefetchServiceThumbnails(views, new Set(), "shop", base, "dark")).toEqual([
      serviceThumbnailUrl(
        { kind: "diagram", failing: false, slug: "shop", current: true, id: "broken", modelRevision: rev } as never,
        base,
        "dark",
      ),
    ]);
    expect(
      prefetchServiceThumbnails(
        Array.from({ length: 40 }, (_, i) => ({ id: `v${i}`, modelRevision: rev })),
        new Set(),
        "shop",
        base,
        "light",
        5,
      ),
    ).toHaveLength(5);
  });
});

describe("thumbnail format (thumbnailFormat on the inventory and catalog)", () => {
  const base = "https://archer.example/projects/shop/?tab=diagrams";
  const rev = `sha256:${"b".repeat(64)}`;
  const flow = {
    kind: "diagram",
    failing: false,
    slug: "shop",
    current: true,
    id: "flow",
    modelRevision: rev,
  } as never;

  it("asks for the format the service names, from either listing, and svg (today's address) otherwise", async () => {
    const { serviceThumbnailUrl } = await import("../src/app/document-previews");
    const { parseInventory } = await import("../src/app/inventory");
    const { parseProjectCatalog } = await import("../src/app/project-directory");
    const { forgetThumbnailVersion } = await import("../src/app/thumbnail-version");
    forgetThumbnailVersion();
    try {
      parseInventory({ schemaVersion: 1, views: [], thumbnailVersion: "00ff" });
      expect(serviceThumbnailUrl(flow, base, "dark")).toBe(
        `https://archer.example/p/shop/api/thumbnails/flow?rev=${rev}&theme=dark&v=00ff`,
      );
      parseInventory({ schemaVersion: 1, views: [], thumbnailVersion: "00ff", thumbnailFormat: "png" });
      expect(serviceThumbnailUrl(flow, base, "dark")).toBe(
        `https://archer.example/p/shop/api/thumbnails/flow?rev=${rev}&theme=dark&v=00ff&format=png`,
      );
      // A live update without the field keeps it; an unknown value is ignored; svg is spelled as today.
      parseInventory({ schemaVersion: 1, views: [] });
      parseInventory({ schemaVersion: 1, views: [], thumbnailFormat: "webp" });
      expect(serviceThumbnailUrl(flow, base, "dark")).toMatch(/&format=png$/);
      parseProjectCatalog({ schemaVersion: 1, thumbnailVersion: "00ff", thumbnailFormat: "svg", projects: [] });
      expect(serviceThumbnailUrl(flow, base, "dark")).toBe(
        `https://archer.example/p/shop/api/thumbnails/flow?rev=${rev}&theme=dark&v=00ff`,
      );
    } finally {
      forgetThumbnailVersion();
    }
  });

  it("gives the prefetch and the card one address in either format, so nothing is fetched twice", async () => {
    const { prefetchServiceThumbnails, forgetPrefetchedThumbnails, serviceThumbnailUrl } = await import(
      "../src/app/document-previews"
    );
    const { parseInventory } = await import("../src/app/inventory");
    const { forgetThumbnailVersion } = await import("../src/app/thumbnail-version");
    for (const thumbnailFormat of ["svg", "png"]) {
      forgetPrefetchedThumbnails();
      parseInventory({ schemaVersion: 1, views: [], thumbnailVersion: "00ff", thumbnailFormat });
      try {
        expect(
          prefetchServiceThumbnails(
            [{ id: "flow", registration: "durable", modelRevision: rev }],
            new Set(),
            "shop",
            base,
            "light",
          ),
        ).toEqual([serviceThumbnailUrl({ ...(flow as object), current: true } as never, base, "light")]);
      } finally {
        forgetThumbnailVersion();
      }
    }
  });
});

describe("visible first (the Diagrams tab's prefetch)", () => {
  const rev = `sha256:${"c".repeat(64)}`;
  const view = (id: string, title: string, modifiedAt: string) => ({
    id,
    kind: "c4",
    title,
    registration: "durable" as const,
    modelRevision: rev,
    modifiedAt,
  });
  const views = [
    view("a", "Alpha", "2026-10-01T00:00:00Z"),
    view("b", "Beta", "2026-10-03T00:00:00Z"),
    view("c", "Gamma", "2026-10-02T00:00:00Z"),
  ];

  it("puts the views in the gallery's order: the page's sort, newest edit first by default", async () => {
    const { galleryOrder } = await import("../src/app/document-previews");
    expect(galleryOrder(views, "shop", "?tab=diagrams").map((v) => v.id)).toEqual(["b", "c", "a"]);
    expect(galleryOrder(views, "shop", "?tab=diagrams&q=&sort=name").map((v) => v.id)).toEqual(["a", "b", "c"]);
    // An embedded diagram has a card of its own, in the same order by its edit.
    expect(
      galleryOrder(
        [...views, { ...view("e", "Embedded", "2026-10-09T00:00:00Z"), registration: "embedded" as const }],
        "shop",
        "",
      ).map((v) => v.id),
    ).toEqual(["b", "c", "a"]);
    expect(
      galleryOrder(
        [
          ...views,
          {
            ...view("notes/a.md#e", "Embedded", "2026-10-09T00:00:00Z"),
            registration: "embedded" as const,
            sourcePath: "notes/a.md",
            note: "notes/a.md",
            name: "e",
          },
        ],
        "shop",
        "",
      ).map((v) => v.id),
    ).toEqual(["notes/a.md#e", "b", "c", "a"]);
  });

  it("asks for the first screen's thumbnails at high priority and the rest at the browser's default", async () => {
    const { prefetchServiceThumbnails, forgetPrefetchedThumbnails } = await import("../src/app/document-previews");
    forgetPrefetchedThumbnails();
    const made: { fetchPriority?: string; src?: string }[] = [];
    class ImageStub {
      fetchPriority?: string;
      decoding?: string;
      src?: string;
      constructor() {
        made.push(this);
      }
    }
    vi.stubGlobal("Image", ImageStub);
    try {
      prefetchServiceThumbnails(
        views,
        new Set(),
        "shop",
        "https://archer.example/projects/shop/?tab=diagrams",
        "light",
        24,
        2,
      );
      expect(made.map((image) => image.fetchPriority)).toEqual(["high", "high", undefined]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
