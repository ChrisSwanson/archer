// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";
const path = "notes/topics.md";
// Titled apart from the notes' leading "# Topics", which would otherwise repeat the title and not be drawn (G6).
function model(markdown: string, title = "Topic notes"): ReviewModel {
  return {
    capabilities: { comments: false, notes: true },
    notes: { status: "ready", notes: [{ path, title }] },
    threads: new Map(),
    noteContents: new Map([
      [path, { status: "ready", content: { path, frontMatter: {}, markdown, revision: markdown } }],
    ]),
    actions: { openNote: vi.fn() },
  } as unknown as ReviewModel;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("starts a phone note's outline collapsed so reading comes before navigation", async () => {
  vi.stubGlobal("innerWidth", 390);
  render(
    <NoteReader
      model={model("# Topics\n\n## Introduction\n\nOpening passage.\n\n## Conclusion")}
      path={path}
      onCompose={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Introduction" });
  const disclosure = screen.getByText("On this page").closest("details")!;
  expect(disclosure).not.toHaveAttribute("open");
  expect(screen.getByText("Opening passage.")).toBeVisible();
});
it("builds a quiet hierarchical outline from rendered headings, never code fences", async () => {
  render(
    <NoteReader
      model={model("# Topics\n\n## **Café**\n\n### Detail\n\n## Café\n\n```md\n# Not a topic\n```\n\n###### Deep")}
      path={path}
      onCompose={() => {}}
    />,
  );
  const nav = await screen.findByRole("navigation", { name: "Table of contents" });
  expect((await within(nav).findAllByRole("link")).map((link) => link.textContent)).toEqual([
    "Topics",
    "Café",
    "Detail",
    "Café",
    "Deep",
  ]);
  const links = await within(nav).findAllByRole("link");
  expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(5);
  for (const link of links)
    expect(document.getElementById(decodeURIComponent(link.getAttribute("href")!.slice(1)))).not.toBeNull();
  expect(links[2]).toHaveAttribute("data-depth", "2");
});
it("leaves out a leading heading that repeats the note's title: the page's h1 says it (G6)", async () => {
  render(<NoteReader model={model("# Topics\n\n## Café\n\n## Detail", "Topics")} path={path} onCompose={() => {}} />);
  const nav = await screen.findByRole("navigation", { name: "Table of contents" });
  expect((await within(nav).findAllByRole("link")).map((link) => link.textContent)).toEqual(["Café", "Detail"]);
});
it.each([false, true])("moves focus only on explicit jumps; reduced motion = %s", async (reduced) => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduced })),
  );
  const scroll = vi.fn();
  const onOpenLink = vi.fn(() => false);
  const old = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = scroll;
  try {
    render(
      <NoteReader model={model("# Topics\n\n## Detail")} path={path} onCompose={() => {}} onOpenLink={onOpenLink} />,
    );
    const nav = await screen.findByRole("navigation", { name: "Table of contents" });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(await within(nav).findByRole("link", { name: "Detail" }));
    expect(screen.getByRole("heading", { name: "Detail" })).toHaveFocus();
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: reduced ? "instant" : "smooth" }));
  } finally {
    HTMLElement.prototype.scrollTo = old;
  }
});
it("refreshes heading identities after content replacement without jumping the reader", async () => {
  const { rerender } = render(
    <NoteReader model={model("# Topics\n\n## Old topic")} path={path} onCompose={() => {}} />,
  );
  await screen.findByRole("link", { name: "Old topic" });
  rerender(<NoteReader model={model("# Topics\n\n## New topic")} path={path} onCompose={() => {}} />);
  await screen.findByRole("link", { name: "New topic" });
  await waitFor(() => expect(screen.queryByRole("link", { name: "Old topic" })).toBeNull());
});
it("omits empty navigation for prose without headings", async () => {
  render(<NoteReader model={model("Only prose.")} path={path} onCompose={() => {}} />);
  await screen.findByText("Only prose.");
  expect(screen.queryByRole("navigation", { name: "Table of contents" })).toBeNull();
});

it("omits a lone heading and exposes safe text without interpreting HTML", async () => {
  const { rerender } = render(<NoteReader model={model("# Only topic")} path={path} onCompose={() => {}} />);
  await screen.findByRole("heading", { name: "Only topic" });
  expect(screen.queryByRole("navigation", { name: "Table of contents" })).toBeNull();
  rerender(
    <NoteReader
      model={model('# Only topic\n\n## <script>alert("x")</script>\n\n## 你好 🌿\n\n### !')}
      path={path}
      onCompose={() => {}}
    />,
  );
  const nav = await screen.findByRole("navigation", { name: "Table of contents" });
  expect(nav.querySelector("script")).toBeNull();
  expect(await within(nav).findByRole("link", { name: '<script>alert("x")</script>' })).toBeVisible();
  expect(within(nav).getByRole("link", { name: "你好 🌿" })).toHaveAttribute(
    "href",
    "#note-section-%E4%BD%A0%E5%A5%BD",
  );
});
it("suffixes cannot collide with a literal suffixed title", async () => {
  render(<NoteReader model={model("# A\n\n## A\n\n## A-2\n\n## A")} path={path} onCompose={() => {}} />);
  const nav = await screen.findByRole("navigation", { name: "Table of contents" });
  expect(new Set((await within(nav).findAllByRole("link")).map((link) => link.getAttribute("href"))).size).toBe(4);
});

it("retains every authored heading level even when the renderer maps HTML tags", async () => {
  render(
    <NoteReader
      model={model(Array.from({ length: 6 }, (_, i) => `${"#".repeat(i + 1)} Level ${i + 1}`).join("\n\n"))}
      path={path}
      onCompose={() => {}}
    />,
  );
  const nav = await screen.findByRole("navigation", { name: "Table of contents" });
  expect((await within(nav).findAllByRole("link")).map((link) => link.dataset.depth)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
});

it("allocates duplicate heading identities with linear collision checks", async () => {
  const count = 400;
  const has = Set.prototype.has;
  let checks = 0;
  const probe = vi.spyOn(Set.prototype, "has").mockImplementation(function (this: Set<unknown>, value: unknown) {
    if (typeof value === "string" && value.startsWith("note-section-")) checks++;
    return has.call(this, value);
  });
  try {
    render(
      <NoteReader
        model={model(Array.from({ length: count }, () => "## Repeat").join("\n\n"))}
        path={path}
        onCompose={() => {}}
      />,
    );
    const nav = await screen.findByRole("navigation", { name: "Table of contents" });
    expect(await within(nav).findAllByRole("link")).toHaveLength(count);
    expect(checks).toBeLessThan(count * 10);
  } finally {
    probe.mockRestore();
  }
});

it.each(["loading", "prose"])("clears old topic targets when switching to a %s note", async (next) => {
  const { rerender } = render(
    <NoteReader model={model("# Topics\n\n## Old topic")} path={path} onCompose={() => {}} />,
  );
  await screen.findByRole("link", { name: "Old topic" });
  const otherPath = "notes/other.md";
  const other = {
    ...model("Only prose."),
    notes: { status: "ready", notes: [{ path: otherPath, title: "Other" }] },
    noteContents: new Map([
      [
        otherPath,
        next === "loading"
          ? { status: "loading" }
          : { status: "ready", content: { path: otherPath, frontMatter: {}, markdown: "Only prose.", revision: "2" } },
      ],
    ]),
  } as unknown as ReviewModel;
  rerender(<NoteReader model={other} path={otherPath} onCompose={() => {}} />);
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Table of contents" })).toBeNull());
});

it("computes outline depth without passing the document to a variadic numeric function", async () => {
  const minimum = Math.min;
  let largestCall = 0;
  const probe = vi.spyOn(Math, "min").mockImplementation((...values) => {
    largestCall = Math.max(largestCall, values.length);
    return minimum(...values);
  });
  try {
    render(
      <NoteReader
        model={model(Array.from({ length: 400 }, (_, i) => `${"#".repeat(1 + (i % 6))} Topic ${i}`).join("\n\n"))}
        path={path}
        onCompose={() => {}}
      />,
    );
    await screen.findByRole("navigation", { name: "Table of contents" });
    expect(largestCall).toBeLessThanOrEqual(2);
  } finally {
    probe.mockRestore();
  }
});

it("keeps the topic outline beside a document with a narrow desktop discussion gutter", async () => {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("primary-note-reader")) return new DOMRect(64, 76, 1376, 824);
    if (this.classList.contains("primary-note-document-column")) return new DOMRect(218, 112, 780, 3000);
    return measure.call(this);
  });
  try {
    render(
      <NoteReader model={model("# Topics\n\n## Introduction\n\n### Café details")} path={path} onCompose={() => {}} />,
    );
    const nav = await screen.findByRole("navigation", { name: "Table of contents" });
    const outline = nav.closest(".primary-note-outline")!;
    await waitFor(() => expect(outline).toHaveClass("primary-note-outline--margin"));
    expect(outline).toHaveStyle({ width: "118px", left: "-142px" });
  } finally {
    vi.restoreAllMocks();
  }
});
