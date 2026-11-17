// @vitest-environment jsdom
// Slice B: a note's mermaid fences drawn in place, lazily, each with its name,
// its state in words and the note's freshness; passage anchors unchanged.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedDiagramContent, NoteContent, NoteFreshness, Thread } from "../src/comments/contract";
import { NoteReader } from "../src/comments/NoteReader";
import {
  figureLoader,
  mountFigureHosts,
  passageOffsets,
  type FigureLoad,
  type FigureLoader,
} from "../src/comments/note-figures";
import { MAX_NOTE_DIAGRAMS } from "../../shared/note-diagrams.mts";
import { freshnessText } from "../src/comments/Freshness";
import type { ReviewModel } from "../src/comments/useReview";

afterEach(cleanup);

// jsdom has no IntersectionObserver: this one says what is near the screen when told.
let observers: { callback: IntersectionObserverCallback; targets: Element[]; options?: IntersectionObserverInit }[] =
  [];
beforeEach(() => {
  observers = [];
  globalThis.IntersectionObserver = class {
    readonly entry: { callback: IntersectionObserverCallback; targets: Element[]; options?: IntersectionObserverInit };
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.entry = { callback, targets: [], ...(options === undefined ? {} : { options }) };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.entry.targets = [];
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});
const scrollNear = (element: Element) =>
  act(() => {
    for (const o of observers)
      if (o.targets.includes(element))
        o.callback(
          [{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
  });

const MARKDOWN = [
  "# Auth",
  "",
  "## Login flow",
  "",
  "```mermaid",
  "flowchart LR",
  '  a["User"] e1@--> b["API"]',
  "```",
  "",
  "The parser accepts tokens.",
  "",
  "## Broken",
  "",
  "```mermaid",
  "flowchart LR",
  "  a[A] --> b[B]",
  "```",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

const summary = (name: string, ordinal: number, line: number) => ({
  name,
  address: `notes/auth.md#${name}`,
  explicit: false,
  ordinal,
  heading: name === "login-flow" ? "Login flow" : "Broken",
  kind: "freeform",
  line,
  bodyLine: line + 1,
  writable: true,
  sourceRevision: `sha256:${String(ordinal).repeat(64)}`,
});

const COMMITTED: NoteFreshness = {
  status: "committed",
  commit: "1a2b3c4",
  committedAt: "2026-10-07T09:30:00Z",
  uncommitted: false,
};

function content(freshness: NoteFreshness = COMMITTED): NoteContent {
  return {
    path: "notes/auth.md",
    frontMatter: {},
    markdown: MARKDOWN,
    revision: "r1",
    diagrams: [summary("login-flow", 1, 5), summary("broken", 2, 14)],
    freshness,
  };
}

function model(note: NoteContent, threads: Thread[] = []): ReviewModel {
  return {
    capabilities: { comments: true, notes: true },
    viewId: null,
    viewTarget: null,
    threads: new Map([["note:notes/auth.md", threads]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map([["notes/auth.md", { status: "ready", content: note }]]),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: vi.fn(),
      reply: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(),
      dismiss: vi.fn(),
      submitAll: vi.fn(),
      openNote: vi.fn(),
      dismissError: vi.fn(),
    },
  } as unknown as ReviewModel;
}

const diagram = (name: string, extra: Partial<EmbeddedDiagramContent> = {}): EmbeddedDiagramContent => ({
  ...summary(name, 1, 5),
  notePath: "notes/auth.md",
  source: "flowchart LR\n",
  diagnostics: [],
  envelope: {},
  freshness: COMMITTED,
  ...extra,
});

function loader(): { load: FigureLoader; calls: string[] } {
  const calls: string[] = [];
  const load: FigureLoader = async (address) => {
    calls.push(address);
    if (address.endsWith("#login-flow"))
      return {
        status: "drawn",
        diagram: diagram("login-flow"),
        drawing: { viewBox: "0 0 100 40", content: '<rect width="10" height="10"/>' },
      } satisfies FigureLoad;
    return {
      status: "failing",
      diagram: diagram("broken", {
        envelope: null,
        source: "flowchart LR\n  a[A] --> b[B]\n",
        diagnostics: [
          {
            code: "implicit_node",
            severity: "error",
            message: "x",
            span: { start: { line: 16, column: 3 }, end: { line: 16, column: 4 } },
          },
        ],
      }),
    } satisfies FigureLoad;
  };
  return { load, calls };
}

const NOW = Date.parse("2026-10-10T09:30:00Z");

describe("figures in the note reader", () => {
  it("draws each mermaid fence as a figure in its place, and leaves other code as code", async () => {
    const { load } = loader();
    render(
      <NoteReader
        model={model(content())}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        figures={{ load, now: () => NOW }}
      />,
    );
    const figures = await screen.findAllByRole("figure");
    expect(figures.map((f) => f.getAttribute("aria-label"))).toEqual(["login-flow, Flowchart", "broken, Flowchart"]);
    // The fence's code is not shown beside its figure; the TypeScript block is.
    expect(screen.queryByText(/a\["User"\]/)).not.toBeVisible();
    expect(screen.getByText("const x = 1;")).toBeVisible();
    // In reading order: the figure sits where its fence was, before the paragraph after it.
    const paragraph = screen.getByText("The parser accepts tokens.");
    expect(figures[0]!.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks for a drawing only once its figure comes near the screen", async () => {
    const { load, calls } = loader();
    render(
      <NoteReader
        model={model(content())}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        figures={{ load, now: () => NOW }}
      />,
    );
    const [first, second] = await screen.findAllByRole("figure");
    expect(calls).toEqual([]);
    expect(observers.some((o) => o.options?.rootMargin !== undefined)).toBe(true);
    expect(within(first!).getByText("login-flow")).toBeVisible();
    await scrollNear(first!);
    await waitFor(() => expect(first!.querySelector("svg.archer-note-figure-drawing")).not.toBeNull());
    expect(first!.querySelector("svg.archer-note-figure-drawing")?.getAttribute("viewBox")).toBe("0 0 100 40");
    expect(calls).toEqual(["notes/auth.md#login-flow"]);
    await scrollNear(second!);
    await waitFor(() => expect(within(second!).getByText("Does not compile: 1 problem")).toBeVisible());
    // The source is shown, so the reader sees what is wrong.
    expect(within(second!).getByText(/a\[A\] --> b\[B\]/)).toBeVisible();
  });

  it("keeps a passage anchored after a figure exactly where it was", async () => {
    const { load } = loader();
    const thread = {
      id: "p",
      revision: 1,
      target: "note:notes/auth.md",
      anchor: { kind: "passage", quote: "The parser", prefix: "", suffix: " accepts tokens." },
      status: "sent",
      comments: [{ id: "c", author: "person", body: "?", createdAt: "2026-10-01T00:00:00Z" }],
    } as Thread;
    render(
      <NoteReader
        model={model(content(), [thread])}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        onOpenThread={() => {}}
        figures={{ load, now: () => NOW }}
      />,
    );
    await screen.findAllByRole("figure");
    const mark = await screen.findByRole("button", { name: "Open discussion on this passage" });
    expect(mark).toHaveTextContent(/^The parser$/);
  });

  it("the figure the reader came back to keeps the focus when the note is laid down again (its highlights arriving)", async () => {
    const { load } = loader();
    const before = model(content());
    const after = {
      ...before,
      capabilities: { ...before.capabilities, noteEmphasis: true },
      noteEmphases: new Map([
        [
          "notes/auth.md",
          {
            status: "ready",
            read: { snapshot: { notePath: "notes/auth.md", revision: "e1", emphases: [] }, orphans: [] },
          },
        ],
      ]),
    } as unknown as ReviewModel;
    let returned = false;
    const reader = (m: ReviewModel, returnTo?: { address: string; scrollTop: number }) => (
      <NoteReader
        model={m}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        figures={{ load, now: () => NOW }}
        onOpenDiagram={() => {}}
        {...(returnTo === undefined ? {} : { returnTo })}
        onReturned={() => {
          returned = true;
        }}
      />
    );
    const shown = render(reader(before, { address: "notes/auth.md#login-flow", scrollTop: 0 }));
    const link = await screen.findByRole("link", { name: "Open login-flow, Flowchart" });
    await waitFor(() => expect(link).toHaveFocus());
    expect(returned).toBe(true);
    // The request is spent; then the note's highlights are read: none, but a new answer, so the note is laid down again.
    shown.rerender(reader(before));
    shown.rerender(reader(after));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open login-flow, Flowchart" })).toHaveFocus());
  });

  it("without figures (a server that does not list them), a fence stays code", async () => {
    const plain = { ...content() };
    delete (plain as { diagrams?: unknown }).diagrams;
    const { load } = loader();
    render(
      <NoteReader
        model={model(plain)}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        figures={{ load, now: () => NOW }}
      />,
    );
    await screen.findByText("The parser accepts tokens.");
    expect(screen.queryAllByRole("figure")).toEqual([]);
    expect(screen.getByText(/a\["User"\]/)).toBeVisible();
  });

  it("says how fresh the note is, under its title and on each figure, with the hash and date on hover or focus", async () => {
    const { load } = loader();
    render(
      <NoteReader
        model={model(content({ ...COMMITTED, uncommitted: true }))}
        path="notes/auth.md"
        note={{ path: "notes/auth.md", title: "Auth" }}
        onCompose={() => {}}
        figures={{ load, now: () => NOW }}
      />,
    );
    const figures = await screen.findAllByRole("figure");
    const marks = screen.getAllByText("Committed 3d ago · uncommitted changes");
    expect(marks).toHaveLength(1 + figures.length);
    for (const mark of marks) {
      expect(mark.closest("[title]")?.getAttribute("title")).toMatch(/^Last commit 1a2b3c4, .*2026.*; changed since$/);
      expect(mark.closest("[tabindex='0']")).not.toBeNull();
    }
  });
});

describe("freshnessText", () => {
  it.each([
    [COMMITTED, "Committed 3d ago"],
    [{ ...COMMITTED, uncommitted: true }, "Committed 3d ago · uncommitted changes"],
    [{ status: "never-committed" }, "Never committed"],
    [{ status: "not-in-git" }, "Not in Git"],
    [{ status: "unavailable", reason: "git_unavailable" }, "Commit history unavailable"],
  ] as [NoteFreshness, string][])("%o", (freshness, text) => expect(freshnessText(freshness, NOW).text).toBe(text));
});

describe("figureLoader", () => {
  it("fetches and paints a diagram once per address and revision, and says why when it cannot", async () => {
    const fetchDiagram = vi.fn(async (address: string) =>
      address.endsWith("#gone")
        ? Promise.reject(new Error("no diagram embedded in a note is named 'x'"))
        : diagram("login-flow"),
    );
    const paint = vi.fn(async () => ({ content: "<g/>", width: 100, height: 40, originX: 0, originY: 0 }));
    const load = figureLoader(fetchDiagram, paint);
    const r1 = diagram("login-flow").sourceRevision;
    const first = await load("notes/auth.md#login-flow", r1);
    await load("notes/auth.md#login-flow", r1);
    expect(first).toMatchObject({ status: "drawn", drawing: { viewBox: "-20 -20 140 80", content: "<g/>" } });
    // A revision the service no longer has is fetched again, and not drawn.
    expect(fetchDiagram).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledTimes(1);
    await load("notes/auth.md#login-flow", "r2");
    expect(fetchDiagram).toHaveBeenCalledTimes(2);
    expect(await load("notes/auth.md#gone", r1)).toEqual({
      status: "error",
      message: "no diagram embedded in a note is named 'x'",
    });
  });
});

// From a Codex review of the note tools.
describe("figures, adversarially", () => {
  it("does not draw a diagram that changed since the note was read, under the old caption", async () => {
    const changed = { ...diagram("login-flow"), sourceRevision: "sha256:new" };
    const load = figureLoader(
      async () => changed,
      async () => ({ content: "<g/>", width: 10, height: 10, originX: 0, originY: 0 }),
    );
    expect(await load("notes/auth.md#login-flow", "sha256:old")).toEqual({
      status: "error",
      message: "This diagram changed since the note was opened. Reopen the note to see it.",
    });
  });

  it("namespaces the ids inside each drawing, so two figures never share a marker", async () => {
    const content =
      '<defs><marker id="export-edge-0-end"/></defs><path marker-end="url(#export-edge-0-end)"/><use href="#export-edge-0-end"/>';
    const load = figureLoader(
      async (address) => ({ ...diagram("login-flow"), address }),
      async () => ({ content, width: 10, height: 10, originX: 0, originY: 0 }),
    );
    const a = (await load("notes/auth.md#login-flow", "sha256:" + "1".repeat(64))) as Extract<
      FigureLoad,
      { status: "drawn" }
    >;
    const b = (await load("notes/other.md#login-flow", "sha256:" + "1".repeat(64))) as Extract<
      FigureLoad,
      { status: "drawn" }
    >;
    const ids = (c: string) => [...c.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids(a.drawing.content)).toHaveLength(1);
    expect(ids(a.drawing.content)[0]).not.toBe(ids(b.drawing.content)[0]);
    expect(a.drawing.content).toContain(`url(#${ids(a.drawing.content)[0]})`);
    expect(a.drawing.content).toContain(`href="#${ids(a.drawing.content)[0]}"`);
  });

  it("draws the first figures of a note with more fences than the service offers, and leaves the rest code", () => {
    const root = document.createElement("div");
    root.innerHTML = Array.from(
      { length: MAX_NOTE_DIAGRAMS + 1 },
      (_, i) => `<pre><code class="language-mermaid">flowchart LR ${i}</code></pre>`,
    ).join("");
    const hosts = mountFigureHosts(root, MAX_NOTE_DIAGRAMS);
    expect(hosts).toHaveLength(MAX_NOTE_DIAGRAMS);
    expect(root.querySelectorAll("pre[hidden]")).toHaveLength(MAX_NOTE_DIAGRAMS);
    // Fewer fences than diagrams, or more without the cap: the page and service disagree, so nothing is drawn.
    expect(mountFigureHosts(root.cloneNode(true) as HTMLElement, 3)).toEqual([]);
  });

  it("offers no passage for a selection across a figure", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>Before.</p><pre hidden><code class="language-mermaid">flowchart LR</code></pre><div data-note-figure="">caption</div><p>After.</p>';
    document.body.append(root);
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 0);
    range.setEnd(root.querySelectorAll("p")[1]!.firstChild!, 5);
    expect(passageOffsets(root, range)).toBeNull();
    const within = document.createRange();
    within.setStart(root.querySelectorAll("p")[1]!.firstChild!, 0);
    within.setEnd(root.querySelectorAll("p")[1]!.firstChild!, 5);
    expect(passageOffsets(root, within)).toEqual({
      start: "Before.flowchart LR".length,
      end: "Before.flowchart LR".length + 5,
    });
    root.remove();
  });
});
