/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { renderNoteMarkdown } from "../../../shared/note-markdown.mjs";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const root = resolve(import.meta.dirname, "../../..");

it("keeps casebook table code tokens intact while the table can scroll", () => {
  const note = readFileSync(resolve(root, "examples/rfc-2324-htcpcp/.archer/notes/reading-guide.md"), "utf8");
  const document: Document = new JSDOM(`<article class="archer-note-body">${renderNoteMarkdown(note)}</article>`).window
    .document;
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "ui/src/styles.css"), "utf8");
  document.head.append(style);
  const token = Array.from(document.querySelectorAll("td code")).find(
    (element) => element.textContent === 'coffee-scheme ":"',
  );
  expect(token).toBeDefined();
  const computedStyle = document.defaultView!.getComputedStyle(token!);
  expect(computedStyle.whiteSpace).toBe("nowrap");
  expect(document.defaultView!.getComputedStyle(token!.closest("table")!).overflowX).toBe("auto");
});
