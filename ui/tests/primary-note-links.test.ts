// @vitest-environment jsdom
import { expect, test } from "vitest";
import { renderNoteMarkdown, placeNoteHtml } from "../src/comments/markdown";
test("opt-in document links retain text/anchors while unsafe URLs remain inert and legacy output stays unchanged", () => {
  const source =
    "[diagram](../diagrams/other.mmd) [note](./other.md) [script](javascript:alert(1)) [host](//evil.example/a.md) [file](file:///tmp/x.md)";
  const options = { internalLinks: true, headingOffset: 1 };
  const root = document.createElement("div");
  placeNoteHtml(root, renderNoteMarkdown(source, options));
  expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "../diagrams/other.mmd",
    "./other.md",
  ]);
  const legacy = document.createElement("div");
  placeNoteHtml(legacy, renderNoteMarkdown(source));
  expect(legacy.querySelectorAll("a")).toHaveLength(0);
  placeNoteHtml(root, renderNoteMarkdown("# Body title", options));
  expect(root.querySelector("h2")?.textContent).toBe("Body title");
});
