// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { addressDocumentLinks, SourceDocumentPage } from "../src/app/SourceDocumentPage";
import { forgetProjectCatalogs } from "../src/app/project-directory";
import type { SourceDocument } from "../src/app/source-documents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});

// A document page (the project README, outside the Archer folder) is served at its project route, so its relative
// links resolve against that route, not the physical server path. Under the live page's identity address codec the
// rewritten href is the logical route itself.
function rewritten(path: string, hrefs: readonly string[], catalog: readonly SourceDocument[] | null = null): string[] {
  const root = document.createElement("div");
  root.innerHTML = hrefs.map((href) => `<a href="${href}">link</a>`).join("");
  // The Archer diagram `.archer/diagrams/flow.mmd`, as the inventory names it (by its Archer-folder path).
  addressDocumentLinks(root, "archer-tour", path, catalog, [
    { id: "flow", sourcePath: "diagrams/flow.mmd", registration: "durable" },
  ]);
  return [...root.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? "");
}

it("resolves a README's relative diagram, note and file links to the same project's routes", () => {
  expect(
    rewritten("README.md", [
      ".archer/diagrams/heartbeat.mmd",
      "./.archer/notes/what-is-archer.md",
      "NOTICE.md",
      "docs/guide%20one.md",
    ]),
  ).toEqual([
    "/projects/archer-tour/.archer/diagrams/heartbeat.mmd",
    "/projects/archer-tour/.archer/notes/what-is-archer.md",
    "/projects/archer-tour/NOTICE.md",
    "/projects/archer-tour/docs/guide%20one.md",
  ]);
});

it("resolves a nested document's parent-relative link within the project", () => {
  expect(rewritten("docs/casebook/index.md", ["../../NOTICE.md", "../overview.md"])).toEqual([
    "/projects/archer-tour/NOTICE.md",
    "/projects/archer-tour/docs/overview.md",
  ]);
});

it("leaves anchors, schemes and protocol-relative links as written", () => {
  const untouched = ["#install", "https://example.com/a.md", "mailto:someone@example.com", "//cdn.example.com/x.md"];
  expect(rewritten("README.md", untouched)).toEqual(untouched);
});

const entry = (path: string, legacy?: SourceDocument["legacy"]): SourceDocument => ({
  source: { path },
  kind: path.endsWith(".mmd") ? "mermaid" : "markdown",
  title: path,
  capabilities: { read: true, sourceWrite: false, comments: false, emphasis: false },
  ...(legacy === undefined ? {} : { legacy }),
});
// `docs/guide.md` beside the Archer folder's own `docs/guide.md` (a note): the clean address opens the note, so the
// repository's document keeps its explicit address (`-/repo/`), which the catalog says it needs.
const shadowing = [
  entry("README.md"),
  entry("docs/guide.md"),
  entry("docs/other.md"),
  entry(".archer/docs/guide.md", { notePath: "docs/guide.md" }),
  entry(".archer/diagrams/flow.mmd", { viewId: "flow" }),
  entry("diagrams/flow.mmd"),
];

it("keeps a shadowed repository document at its explicit address, from its own page and from others", () => {
  expect(rewritten("docs/guide.md", ["guide.md", "other.md", "../README.md"], shadowing)).toEqual([
    "/projects/archer-tour/-/repo/docs/guide.md",
    "/projects/archer-tour/docs/other.md",
    "/projects/archer-tour/README.md",
  ]);
  expect(rewritten("README.md", ["docs/guide.md", "diagrams/flow.mmd", ".archer/docs/guide.md"], shadowing)).toEqual([
    "/projects/archer-tour/-/repo/docs/guide.md",
    "/projects/archer-tour/-/repo/diagrams/flow.mmd",
    "/projects/archer-tour/.archer/docs/guide.md",
  ]);
});

// Through the page: a project with diagrams and no notes. `.archer/diagrams/flow.mmd` is the diagram whose clean
// address is `/projects/<name>/diagrams/flow.mmd`; the repository's own `diagrams/flow.mmd` keeps `-/repo/`.
it("keeps a repository diagram an Archer diagram shadows at its explicit address, in a project with no notes", async () => {
  const slug = "diagrams-only-1234";
  window.history.replaceState(null, "", `/projects/${slug}/README.md`);
  const markdown = "# Diagrams only\n\nSee [the flow](diagrams/flow.mmd) and [the other](diagrams/other.mmd).\n";
  const catalog = {
    complete: true,
    diagnostics: [],
    documents: [
      entry("README.md"),
      entry("diagrams/flow.mmd"),
      entry("diagrams/other.mmd"),
      entry(".archer/diagrams/flow.mmd", { viewId: "flow" }),
    ],
  };
  const inventory = {
    schemaVersion: 1,
    views: [{ id: "flow", kind: "flowchart", title: "Flow", registration: "durable", sourcePath: "diagrams/flow.mmd" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://x",
      );
      const body = url.pathname.endsWith("/api/documents/content")
        ? {
            source: { path: "README.md" },
            kind: "markdown",
            revision: `sha256:${"a".repeat(64)}`,
            text: markdown,
            markdown,
            embedded: [],
          }
        : url.pathname.endsWith("/api/documents")
          ? catalog
          : url.pathname.endsWith("/api/diagrams")
            ? inventory
            : null;
      return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
    }),
  );
  render(createElement(SourceDocumentPage, { projectSlug: slug, path: "README.md" }));
  const flow = await screen.findByRole("link", { name: "the flow" });
  await waitFor(() => expect(flow).toHaveAttribute("href", `/projects/${slug}/-/repo/diagrams/flow.mmd`));
  expect(screen.getByRole("link", { name: "the other" })).toHaveAttribute(
    "href",
    `/projects/${slug}/diagrams/other.mmd`,
  );
});
