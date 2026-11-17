// Files as rows, and the search page's filters, facets, sorting and address
// (src/app/file-index.ts; projects-and-search.md).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  EMPTY_SEARCH,
  facets,
  fileRows,
  filterCount,
  rangeBounds,
  readSearchState,
  searchKey,
  searchRows,
  SORT_KEYS,
  sortRows,
  typeLabel,
  writeSearchState,
  type FileRow,
  type IndexedProject,
  type SearchState,
} from "../src/app/file-index";
import type { DiagramView } from "../src/app/inventory";
import type { ContentsNote } from "../src/app/contents";
import { readPageAddress, sameAddress, withPageAddress } from "../src/app/page-address";
import { parseAllNotes } from "../src/app/contents-notes";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

const views: DiagramView[] = [
  {
    id: "pipeline",
    title: "Compile pipeline",
    kind: "freeform",
    registration: "durable",
    sourcePath: "diagrams/compiler/pipeline.mmd",
    modifiedAt: day(1),
    createdAt: day(40),
    createdFrom: "git",
    description: "How Mermaid becomes a model",
  },
  {
    id: "login",
    title: "Login",
    kind: "sequence",
    registration: "durable",
    sourcePath: "diagrams/flows/login.mmd",
    modifiedAt: day(10),
    createdAt: day(10),
    createdFrom: "filesystem",
    threads: { draft: 1, sent: 0, read: 0, answered: 0, resolved: 3 },
  },
  { id: "root", title: "Root map", kind: "architecture", registration: "durable", sourcePath: "root.mmd" },
  { id: "notes/a.md#fig", title: "Embedded", kind: "freeform", registration: "embedded", sourcePath: "notes/a.md" },
];
const notes: ContentsNote[] = [
  {
    path: "notes/a.md",
    title: "Auth decision",
    type: "decision",
    viewIds: [],
    modifiedAt: day(3),
    description: "Why tokens rotate",
  },
];

const project = (over: Partial<IndexedProject> = {}): IndexedProject => ({
  slug: "archer",
  name: "Archer",
  views,
  notes,
  current: true,
  failingViewIds: new Set(["root"]),
  presentedViewId: "login",
  ...over,
});
const rows = fileRows(project());
const titles = (list: readonly FileRow[]): string[] => list.map((row) => row.title);
const state = (over: Partial<SearchState>): SearchState => ({ ...EMPTY_SEARCH, ...over });

describe("fileRows", () => {
  it("joins comment activity by exact target while leaving unavailable activity absent", () => {
    const activity = new Map([
      ["view:login" as const, { totalThreads: 4, unresolvedThreads: 1, lastCommentedAt: day(2) }],
      ["note:notes/a.md" as const, { totalThreads: 8, unresolvedThreads: 0, lastCommentedAt: null }],
    ]);
    const indexed = fileRows(project({ commentActivity: activity }));
    expect(indexed.find((row) => row.id === "login")).toMatchObject({
      totalThreads: 4,
      unresolvedThreads: 1,
      lastCommentedAt: day(2),
    });
    expect(indexed.find((row) => row.kind === "note")).toMatchObject({
      totalThreads: 8,
      unresolvedThreads: 0,
      lastCommentedAt: null,
    });
    expect(indexed.find((row) => row.id === "pipeline")).not.toHaveProperty("totalThreads");
  });
  it("keeps note threads from the service listing through the open-thread filter", () => {
    const listed = parseAllNotes({
      notes: [
        {
          path: "notes/review.md",
          title: "Review",
          viewIds: [],
          threads: { draft: 1, sent: 2, read: 1, answered: 1, resolved: 8 },
        },
      ],
    });
    expect(listed?.[0]).toHaveProperty("threads");
    const indexed = fileRows(project({ views: [], notes: listed! }));
    expect(indexed[0]?.openThreads).toBe(5);
    expect(titles(searchRows(indexed, state({ status: ["comments"] }), null, NOW))).toEqual(["Review"]);
    expect(facets(indexed, EMPTY_SEARCH, null, NOW).status.get("comments")).toBe(1);
  });
  it("is every diagram file, every diagram embedded in a note, and every note", () => {
    expect(titles(rows)).toEqual(["Compile pipeline", "Login", "Root map", "Embedded", "Auth decision"]);
    expect(rows.find((row) => row.id === "login")).toMatchObject({
      kind: "diagram",
      type: "sequence",
      folder: "diagrams/flows",
      path: "diagrams/flows/login.mmd",
      openThreads: 1,
      presented: true,
      failing: false,
      target: "view:login",
      key: "archer\0view:login",
    });
    expect(rows.find((row) => row.id === "root")).toMatchObject({ folder: "", failing: true, openThreads: 0 });
    expect(rows.find((row) => row.kind === "note")).toMatchObject({
      type: "decision",
      folder: "notes",
      description: "Why tokens rotate",
      target: "note:notes/a.md",
    });
  });

  it("names types in the reader's words; a freeform diagram is a flowchart", () => {
    expect(rows.map(typeLabel)).toEqual(["Flowchart", "Sequence", "Architecture", "Flowchart", "decision"]);
    expect(typeLabel({ kind: "note", type: null })).toBe("Note");
  });
});

describe("embedded diagrams as rows (note diagrams ticket, decisions 3 to 5)", () => {
  const block = (name: string, title: string, over: Partial<DiagramView> = {}): DiagramView => ({
    id: `notes/auth.md#${name}`,
    title,
    kind: "sequence",
    registration: "embedded",
    sourcePath: "notes/auth.md",
    note: "notes/auth.md",
    name,
    modelRevision: `sha256:${"a".repeat(64)}`,
    ...over,
  });
  const authNote: ContentsNote = { path: "notes/auth.md", title: "How auth works", viewIds: [], modifiedAt: day(2) };
  const embedded = (over: Partial<IndexedProject> = {}): FileRow[] =>
    fileRows(
      project({
        views: [
          block("login", "Auth"),
          block("refresh", "Refresh tokens"),
          block("flow", "Flow", { id: "notes/zz.md#flow", note: "notes/zz.md", sourcePath: "notes/zz.md" }),
        ],
        notes: [authNote, { path: "notes/zz.md", title: "Other note", viewIds: [] }],
        ...over,
      }),
    ).filter((row) => row.embedded !== undefined);

  it("is a diagram row at the block's canonical address, in its note's folder, with its note and name", () => {
    const [login] = embedded();
    expect(login).toMatchObject({
      kind: "diagram",
      type: "sequence",
      id: "notes/auth.md#login",
      target: "view:notes/auth.md#login",
      key: "archer\0view:notes/auth.md#login",
      path: "notes/auth.md#login",
      folder: "notes",
      title: "Auth",
      modelRevision: `sha256:${"a".repeat(64)}`,
      embedded: { note: "notes/auth.md", noteTitle: "How auth works", name: "login", address: "notes/auth.md#login" },
    });
    expect(login).not.toHaveProperty("sourceDocumentPath");
  });

  it("reads the note and the name off the address when the service sent neither field", () => {
    const [bare] = fileRows(
      project({
        views: [
          {
            id: "notes/auth.md#login",
            title: "Auth",
            kind: "flowchart",
            registration: "embedded",
            sourcePath: "notes/auth.md",
          },
        ],
        notes: [authNote],
      }),
    ).filter((row) => row.embedded !== undefined);
    expect(bare?.embedded).toEqual({
      note: "notes/auth.md",
      noteTitle: "How auth works",
      name: "login",
      address: "notes/auth.md#login",
    });
  });

  it("appends the name to a heading two blocks of one note share, and only then", () => {
    const shared = fileRows(
      project({
        views: [
          block("login", "Auth"),
          block("logout", "Auth"),
          block("refresh", "Refresh tokens"),
          block("flow", "Auth", { id: "notes/zz.md#flow", note: "notes/zz.md", sourcePath: "notes/zz.md" }),
        ],
        notes: [authNote, { path: "notes/zz.md", title: "Other note", viewIds: [] }],
      }),
    ).filter((row) => row.embedded !== undefined);
    expect(titles(shared)).toEqual(["Auth, login", "Auth, logout", "Refresh tokens", "Auth"]);
  });

  it("is admitted through its note: an excluded or unlisted note brings no rows, an admitted one all of them", () => {
    const doc = (path: string, notePath: string) => ({
      source: { path },
      kind: "markdown" as const,
      title: "T",
      legacy: { notePath },
      capabilities: { read: true as const, sourceWrite: false as const, comments: true, emphasis: true },
    });
    const admitted = embedded({ documents: [doc(".archer/notes/auth.md", "notes/auth.md")] });
    expect(admitted.map((row) => row.id)).toEqual(["notes/auth.md#login", "notes/auth.md#refresh"]);
    expect(embedded({ documents: [] })).toEqual([]);
  });

  it("falls to the note's name when the note is not listed, and counts with the other diagrams", () => {
    const unlisted = fileRows(project({ views: [block("login", "Auth")], notes: [] })).find(
      (row) => row.embedded !== undefined,
    );
    expect(unlisted?.embedded?.noteTitle).toBe("auth.md");
    expect(fileRows(project()).filter((row) => row.kind === "diagram")).toHaveLength(4);
  });

  it("is found by its address, its title and its note's folder, and filtered by diagram type", () => {
    const all = embedded();
    expect(titles(searchRows(all, state({ query: "auth.md#refresh" }), null, NOW))).toEqual(["Refresh tokens"]);
    expect(titles(searchRows(all, state({ query: "refresh" }), null, NOW))).toEqual(["Refresh tokens"]);
    expect(titles(searchRows(all, state({ types: ["sequence"], folder: "notes" }), null, NOW)).sort()).toEqual([
      "Auth",
      "Flow",
      "Refresh tokens",
    ]);
  });
});

describe("searchRows", () => {
  it("matches every typed word in a row's name, path, type, project or description", () => {
    expect(titles(searchRows(rows, state({ query: "mermaid model" }), null, NOW))).toEqual(["Compile pipeline"]);
    expect(titles(searchRows(rows, state({ query: "flows" }), null, NOW))).toEqual(["Login"]);
    expect(titles(searchRows(rows, state({ query: "decision tokens" }), null, NOW))).toEqual(["Auth decision"]);
    expect(searchRows(rows, state({ query: "archer" }), null, NOW)).toHaveLength(5);
  });

  it("adds what the service found, by project", () => {
    const hits = new Map([["archer", new Set(["view:root" as const])]]);
    expect(titles(searchRows(rows, state({ query: "quokka" }), hits, NOW))).toEqual(["Root map"]);
    expect(
      searchRows(rows, state({ query: "quokka" }), new Map([["other", new Set(["view:root" as const])]]), NOW),
    ).toEqual([]);
  });

  it.each<[string, Partial<SearchState>, string[]]>([
    ["kind", { kinds: ["note"] }, ["Auth decision"]],
    ["diagram type, which leaves notes out", { types: ["sequence", "architecture"] }, ["Login", "Root map"]],
    ["a folder and what is under it", { folder: "diagrams" }, ["Compile pipeline", "Login"]],
    ["the top level only", { folder: "" }, ["Root map"]],
    ["a note's folder, which holds its embedded diagrams", { folder: "notes" }, ["Embedded", "Auth decision"]],
    ["does not compile", { status: ["failing"] }, ["Root map"]],
    ["has open threads", { status: ["comments"] }, ["Login"]],
    ["edited in the past week", { edited: { preset: "7d" } }, ["Compile pipeline", "Auth decision"]],
    [
      "created between dates; a file with no date is out",
      { created: { from: day(45).slice(0, 10), to: day(20).slice(0, 10) } },
      ["Compile pipeline"],
    ],
    ["project", { projects: ["elsewhere"] }, []],
  ])("filters by %s", (_, over, expected) => {
    expect(titles(searchRows(rows, state({ ...over, sort: { key: "name", dir: "asc" } }), null, NOW)).sort()).toEqual(
      [...expected].sort(),
    );
  });

  it("filters numeric thread ranges and Commented dates without treating unavailable activity as zero", () => {
    const activityRows = fileRows(
      project({
        commentActivity: new Map([
          ["view:pipeline", { totalThreads: 12, unresolvedThreads: 3, lastCommentedAt: day(1) }],
          ["view:login", { totalThreads: 4, unresolvedThreads: 1, lastCommentedAt: day(10) }],
          ["view:root", { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null }],
        ]),
      }),
    );
    expect(titles(searchRows(activityRows, state({ totalThreads: { min: 5, max: 12 } }), null, NOW))).toEqual([
      "Compile pipeline",
    ]);
    expect(titles(searchRows(activityRows, state({ unresolvedThreads: { min: 1, max: 2 } }), null, NOW))).toEqual([
      "Login",
    ]);
    expect(titles(searchRows(activityRows, state({ commented: { preset: "7d" } }), null, NOW))).toEqual([
      "Compile pipeline",
    ]);
    expect(titles(searchRows(activityRows, state({ totalThreads: { min: 0, max: 0 } }), null, NOW))).toEqual([
      "Root map",
    ]);
  });

  it("counts each choice with the other filters applied, not its own", () => {
    const counted = facets(rows, state({ kinds: ["diagram"], status: ["comments"] }), null, NOW);
    expect(counted.kinds.get("diagram")).toBe(1);
    expect(counted.kinds.get("note")).toBeUndefined();
    expect(counted.status.get("comments")).toBe(2 - 1);
    expect(counted.status.get("failing")).toBe(1);
    expect(facets(rows, EMPTY_SEARCH, null, NOW).folders).toEqual(
      new Map([
        ["diagrams", 2],
        ["diagrams/compiler", 1],
        ["diagrams/flows", 1],
        ["", 1],
        ["notes", 2],
      ]),
    );
  });

  it.each([
    [
      "edited",
      { kinds: ["diagram"], edited: { preset: "1d" }, created: { preset: "30d" } },
      [
        ["", 1],
        ["1d", 0],
        ["7d", 0],
        ["30d", 1],
        ["365d", 1],
      ],
    ],
    [
      "created",
      { kinds: ["diagram"], created: { preset: "1d" }, edited: { preset: "7d" } },
      [
        ["", 1],
        ["1d", 0],
        ["7d", 0],
        ["30d", 0],
        ["365d", 1],
      ],
    ],
  ] as const)(
    "counts %s presets with the other filters applied and its own range removed",
    (facet, filters, counts) => {
      expect(facets(rows, state(filters), null, NOW)).toHaveProperty(facet, new Map(counts));
    },
  );
});

describe("sortRows", () => {
  it.each(SORT_KEYS.map((key) => [key]))("sorts by %s both ways, a missing date always last", (key) => {
    const up = sortRows(rows, { key, dir: "asc" });
    const down = sortRows(rows, { key, dir: "desc" });
    expect(up).toHaveLength(rows.length);
    if (key === "edited" || key === "created") {
      expect(up.at(-1)?.title).toBe("Root map");
      expect(down.at(-1)?.title).toBe("Root map");
    } else if (key !== "project" && key !== "total" && key !== "unresolved" && key !== "commented")
      expect(titles(down)).not.toEqual(titles(up));
  });

  it("puts the newest edit first by default", () => {
    expect(DEFAULT_SORT).toEqual({ key: "edited", dir: "desc" });
    expect(titles(sortRows(rows, DEFAULT_SORT))).toEqual([
      "Compile pipeline",
      "Auth decision",
      "Login",
      "Embedded",
      "Root map",
    ]);
  });

  it("sorts thread counts numerically and Commented by date, with unavailable activity last in either direction", () => {
    const activityRows = fileRows(
      project({
        commentActivity: new Map([
          ["view:pipeline", { totalThreads: 12, unresolvedThreads: 3, lastCommentedAt: day(1) }],
          ["view:login", { totalThreads: 4, unresolvedThreads: 1, lastCommentedAt: day(10) }],
          ["view:root", { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null }],
        ]),
      }),
    );
    expect(titles(sortRows(activityRows, { key: "total", dir: "asc" }))).toEqual([
      "Root map",
      "Login",
      "Compile pipeline",
      "Auth decision",
      "Embedded",
    ]);
    expect(titles(sortRows(activityRows, { key: "unresolved", dir: "desc" }))).toEqual([
      "Compile pipeline",
      "Login",
      "Root map",
      "Auth decision",
      "Embedded",
    ]);
    expect(titles(sortRows(activityRows, { key: "commented", dir: "desc" }))).toEqual([
      "Compile pipeline",
      "Login",
      "Auth decision",
      "Embedded",
      "Root map",
    ]);
  });
});

describe("the search page's address", () => {
  const full: SearchState = {
    query: "auth flow",
    projects: ["archer", "other"],
    kinds: ["diagram"],
    types: ["sequence"],
    folder: "diagrams/flows",
    status: ["failing", "comments"],
    edited: { preset: "30d" },
    created: { from: "2026-01-01" },
    totalThreads: { min: 2, max: 12 },
    unresolvedThreads: { min: 1 },
    commented: { preset: "7d" },
    sort: { key: "total", dir: "desc" },
    tab: "notes",
    inNotes: true,
  };

  it("round-trips every filter and the sort, and leaves the defaults out", () => {
    const url = new URL("https://a.invalid/t/p/x/?keep=1");
    writeSearchState(url, full);
    expect(readSearchState(url.search)).toEqual(full);
    expect(url.searchParams.get("keep")).toBe("1");
    const plain = new URL("https://a.invalid/");
    writeSearchState(plain, EMPTY_SEARCH);
    expect(plain.search).toBe("?q=");
    expect(readSearchState(plain.search)).toEqual(EMPTY_SEARCH);
    expect(filterCount(full)).toBe(12);
  });

  it("is a page address of its own: another place replaces all of it, and it replaces another", () => {
    const href = withPageAddress("https://a.invalid/t/p/x/?view=flow", { kind: "search", state: full });
    expect(new URL(href).searchParams.has("view")).toBe(false);
    expect(readPageAddress(new URL(href).search)).toEqual({ kind: "search", state: full });
    const away = new URL(withPageAddress(href, { kind: "note", path: "a.md" }));
    for (const name of [
      "search",
      "project",
      "kind",
      "type",
      "under",
      "status",
      "edited",
      "created",
      "total",
      "unresolved",
      "commented",
      "sort",
      "tab",
      "in",
    ])
      expect(away.searchParams.has(name)).toBe(false);
    expect(sameAddress({ kind: "search", state: full }, { kind: "search", state: { ...full } })).toBe(true);
    expect(searchKey(full)).not.toBe(searchKey({ ...full, query: "auth" }));
  });

  it("reads what it cannot use as unset, never as a guess", () => {
    expect(readSearchState("?view=x")).toBeNull();
    expect(readSearchState("?q=q&kind=folder&status=odd&edited=yesterday&created=2026-13..&sort=-colour")).toEqual({
      ...EMPTY_SEARCH,
      query: "q",
      created: null,
    });
    expect(readSearchState(`?q=${"x".repeat(2000)}`)?.query).toHaveLength(512);
  });

  it("bounds a range of days by the reader's calendar, the end day included", () => {
    const { from, to } = rangeBounds({ from: "2026-10-01", to: "2026-10-01" }, NOW);
    expect(new Date(from).getDate()).toBe(1);
    expect(to - from).toBe(86_400_000 - 1);
    expect(rangeBounds({ preset: "7d" }, NOW)).toEqual({ from: NOW - 7 * 86_400_000, to: Infinity });
  });
});

describe("gallery search across selected or hidden metadata", () => {
  it.each([
    ["2026-10-10", ["Compile pipeline"]],
    ["git", ["Compile pipeline"]],
    ["presented by the agent", ["Login"]],
    ["does not compile", ["Root map"]],
    ["open thread", ["Login"]],
  ])("finds %s in card metadata", (query, expected) => {
    expect(titles(searchRows(rows, state({ query }), null, NOW))).toEqual(expected);
  });
});
it("finds the project's README summary without replacing document descriptions", () => {
  const indexed = fileRows(project({ description: "Tracks settlement batches." }));
  expect(searchRows(indexed, state({ query: "settlement" }), null, NOW)).toHaveLength(indexed.length);
  expect(titles(searchRows(indexed, state({ query: "mermaid model" }), null, NOW))).toEqual(["Compile pipeline"]);
});

it("a diagram row carries its view's model revision, for its thumbnail address", () => {
  const revision = `sha256:${"d".repeat(64)}`;
  const indexed = fileRows(project({ views: [{ ...views[0]!, modelRevision: revision }] }));
  expect(indexed.find((row) => row.kind === "diagram")?.modelRevision).toBe(revision);
  expect(fileRows(project()).find((row) => row.kind === "diagram")).not.toHaveProperty("modelRevision");
});
