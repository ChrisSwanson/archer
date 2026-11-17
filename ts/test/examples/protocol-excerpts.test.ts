import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { renderNoteMarkdown } from "../../../shared/note-markdown.mts";
import { noteContent } from "../../src/comments/notes.ts";
import { findProject } from "../../src/project/index.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const cases = [
  { project: "rfc-2324-htcpcp", sources: ["rfc2324.txt"], quotes: 1 },
  { project: "rfc-1149-ipoac", sources: ["rfc1149.txt", "rfc2549.txt"], quotes: 2 },
] as const;

test("avian casebook introduces its questions and preserved sources before the first case", () => {
  const root = resolve(import.meta.dirname, "../../../examples/rfc-1149-ipoac");
  const note = noteContent(findProject(root), "notes/reading-guide.md");
  const document: Document = new JSDOM(renderNoteMarkdown(note.markdown)).window.document;
  const introduction = document.querySelector(".archer-note-h1")!.nextElementSibling!;
  expect(introduction.tagName).toBe("P");
  expect(introduction.textContent).toMatch(/agent-authored/);
  const opening = note.markdown.split("## When can a carrier leave?")[0]!;
  expect(opening).toContain("RFC 1149");
  expect(opening).toContain("RFC 2549");
  expect(opening).toContain("](rfc1149.md)");
  expect(opening).toContain("](rfc2549.md)");
});

test("coffee 406 excerpt starts at the source sentence boundary", () => {
  const root = resolve(import.meta.dirname, "../../../examples/rfc-2324-htcpcp");
  const note = noteContent(findProject(root), "notes/reading-guide.md");
  const document: Document = new JSDOM(renderNoteMarkdown(note.markdown)).window.document;
  const excerpt = normalize(document.querySelector("blockquote")!.textContent ?? "");
  expect(excerpt).toMatch(/^This return code is normally interpreted as/);
  expect(normalize(readFileSync(join(root, "sources/rfc2324.txt"), "utf8"))).toContain(excerpt);
  expect(document.body.textContent).not.toContain("The excerpt begins mid-sentence");
});

test.each(cases)("$project: prose excerpts wrap as verbatim blockquotes", ({ project: name, sources, quotes }) => {
  const root = resolve(import.meta.dirname, "../../../examples", name);
  const note = noteContent(findProject(root), "notes/reading-guide.md");
  const document: Document = new JSDOM(renderNoteMarkdown(note.markdown)).window.document;
  const excerpts = Array.from(document.querySelectorAll("blockquote"));
  expect(excerpts).toHaveLength(quotes);
  const originals = sources.map((file) => normalize(readFileSync(join(root, "sources", file), "utf8")));
  for (const excerpt of excerpts) {
    const text = normalize(excerpt.textContent ?? "");
    expect(text.length).toBeGreaterThan(100);
    expect(
      originals.some((source) => source.includes(text)),
      text,
    ).toBe(true);
    expect(excerpt.querySelector("pre, code")).toBeNull();
  }
  for (const code of Array.from(document.querySelectorAll("pre")))
    expect(code.textContent).not.toMatch(
      /headers sent in the request|The service level is indicated|The IP datagram is printed/,
    );
});
