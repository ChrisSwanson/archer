// What the page keeps of a note's embedded diagrams and freshness: a shape it
// does not know is dropped, never half-applied.
import { describe, expect, it } from "vitest";
import { parseEmbeddedDiagram, parseFreshness, parseNoteContent } from "../src/comments/parse";

const summary = {
  name: "login-flow",
  address: "notes/a.md#login-flow",
  explicit: false,
  ordinal: 1,
  heading: "Login flow",
  kind: "freeform",
  line: 5,
  bodyLine: 6,
  writable: true,
  sourceRevision: "sha256:x",
};

describe("parse", () => {
  it("keeps a note's diagrams and freshness, and skips a diagram it cannot read", () => {
    const note = parseNoteContent({
      path: "notes/a.md",
      frontMatter: {},
      markdown: "",
      revision: "r",
      diagrams: [summary, { name: 3 }],
      freshness: { status: "not-in-git" },
    });
    // One it cannot read drops the list: figures pair with fences by order.
    expect(note?.diagrams).toBeUndefined();
    expect(note?.freshness).toEqual({ status: "not-in-git" });
    const clean = parseNoteContent({
      path: "notes/a.md",
      frontMatter: {},
      markdown: "",
      revision: "r",
      diagrams: [summary],
      freshness: { status: "not-in-git" },
    });
    expect(clean).toMatchObject({ diagrams: [summary], freshness: { status: "not-in-git" } });
  });

  it.each([
    [{ status: "committed", commit: "1a2b3c4", committedAt: "2026-10-07T09:30:00Z", uncommitted: false }, true],
    [{ status: "committed", commit: "1a2b3c4", committedAt: "2026-10-07T09:30:00Z" }, false],
    [{ status: "never-committed" }, true],
    [{ status: "not-in-git" }, true],
    [{ status: "unavailable", reason: "git_unavailable" }, true],
    [{ status: "soon" }, false],
  ])("freshness %o", (raw, kept) => expect(parseFreshness(raw) !== undefined).toBe(kept));

  it("reads an embedded diagram, and refuses one without its source", () => {
    const full = {
      ...summary,
      notePath: "notes/a.md",
      source: "flowchart LR\n",
      diagnostics: [],
      envelope: null,
      freshness: { status: "not-in-git" },
    };
    expect(parseEmbeddedDiagram(full)).toEqual(full);
    expect(parseEmbeddedDiagram({ ...full, source: undefined })).toBeUndefined();
  });
});
