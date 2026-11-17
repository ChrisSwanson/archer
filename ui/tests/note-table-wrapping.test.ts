// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { placeNoteHtml, renderNoteMarkdown } from "../src/comments/markdown";

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
});

test("note table cells preserve words when the surrounding prose can break long tokens", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
  document.head.append(style);
  const note = document.createElement("article");
  note.className = "archer-note-body";
  placeNoteHtml(
    note,
    renderNoteMarkdown(
      "| Slot | Reading |\n| --- | --- |\n| Scheme | A listed spelling. |\n| Additions | An optional list. |",
    ),
  );
  document.body.append(note);
  expect(note.querySelectorAll("td, th").length).toBe(6);
  expect(getComputedStyle(note.querySelector("table")!).overflowX).toBe("auto");
  for (const cell of note.querySelectorAll("td, th")) {
    expect(getComputedStyle(cell).overflowWrap).toBe("break-word");
  }
});
