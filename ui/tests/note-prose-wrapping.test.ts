// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { placeNoteHtml, renderNoteMarkdown } from "../src/comments/markdown";

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
});

test("note prose uses pretty wrapping without changing code whitespace", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
  document.head.append(style);
  const note = document.createElement("article");
  note.className = "archer-note-body";
  placeNoteHtml(
    note,
    renderNoteMarkdown("A reading paragraph.\n\n- A reading list item.\n\n> A quotation.\n\n```text\n  verbatim\n```"),
  );
  document.body.append(note);
  for (const prose of note.querySelectorAll("p, li, blockquote"))
    expect(getComputedStyle(prose).getPropertyValue("text-wrap")).toBe("pretty");
  expect(getComputedStyle(note.querySelector("pre")!).whiteSpace).toBe("pre");
});
