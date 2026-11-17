// Finding 11: references read each file, parse each note and build the inventory at most once per get_comments
// call, and the inventory only when a thread on a diagram needs it.
import { expect, test } from "vitest";
import type { ViewEntry } from "../../src/application/diagrams.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { ReferenceReads, referencesFor, type ReferenceSources } from "../../src/comments/references.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, tempDir } from "../mcp/support.ts";

const NOTE = "# Auth\n\nTokens matter.\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  a[A] e1@--> b[B]\n```\n";
const thread = (id: string, target: Thread["target"], anchor: Thread["anchor"]): Thread => ({
  id,
  target,
  anchor,
  status: "sent",
  revision: 1,
  comments: [{ id: `c${id}`, author: "person", body: "?", createdAt: "2026-10-01T00:00:00Z" }],
});

function counting(): { sources: ReferenceSources; calls: Record<string, number> } {
  const calls: Record<string, number> = { views: 0, source: 0, embeddedIn: 0, note: 0 };
  const views: ViewEntry[] = [
    { id: "flow", source: "flow.mmd", registration: "durable" } as unknown as ViewEntry,
    { id: "notes/auth.md#login", source: "notes/auth.md", registration: "embedded" } as unknown as ViewEntry,
  ];
  const sources: ReferenceSources = {
    views: () => {
      calls.views!++;
      return views;
    },
    source: () => {
      calls.source!++;
      return FLOW;
    },
    embeddedIn: () => {
      calls.embeddedIn!++;
      return [{ name: "login", source: "flowchart LR\n  a[A] e1@--> b[B]\n", bodyLine: 7 } as never];
    },
    note: () => {
      calls.note!++;
      return NOTE;
    },
  };
  return { sources, calls };
}

test("every read happens once for the call, however many threads ask", () => {
  const project = findProject(tempDir({ ".archer/flow.mmd": FLOW }));
  const { sources, calls } = counting();
  const reads = new ReferenceReads(sources);
  const threads = [
    thread("1", "view:flow", { kind: "node", id: "a", label: "" }),
    thread("2", "view:flow", { kind: "view" }),
    thread("3", "view:notes/auth.md#login", { kind: "view" }),
    thread("4", "view:notes/auth.md#login", { kind: "node", id: "a", label: "" }),
    thread("5", "note:notes/auth.md", { kind: "passage", quote: "Tokens matter", prefix: "", suffix: "" }),
    thread("6", "note:notes/auth.md", { kind: "passage", quote: "matter", prefix: "Tokens ", suffix: "." }),
  ];
  const refs = threads.map((t) => referencesFor(project, t, reads));
  expect(refs.map((r) => r.lines)).toEqual([
    { start: 2, end: 2 },
    { start: 1, end: 2 },
    { start: 7, end: 8 },
    { start: 8, end: 8 },
    { start: 3, end: 3 },
    { start: 3, end: 3 },
  ]);
  expect(calls).toEqual({ views: 1, source: 1, embeddedIn: 1, note: 1 });
});

test("project and note threads never build the inventory", () => {
  const project = findProject(tempDir({ ".archer/flow.mmd": FLOW }));
  const { sources, calls } = counting();
  const reads = new ReferenceReads(sources);
  referencesFor(project, thread("p", "project:", { kind: "project" }), reads);
  referencesFor(
    project,
    thread("n", "note:notes/auth.md", { kind: "passage", quote: "Tokens", prefix: "", suffix: "" }),
    reads,
  );
  expect(calls.views).toBe(0);
});

test("the rendered note's text is traced to the source line of every kind of block", async () => {
  const { renderedNoteLines, renderedNoteText } = await import("../../src/comments/note-text.ts");
  const md = [
    "# Title", // 0
    "", // 1
    "A paragraph that", // 2
    "wraps onto **two** lines.", // 3
    "", // 4
    "- first item", // 5
    "- second item", // 6
    "", // 7
    "| a | b |", // 8
    "|---|---|", // 9
    "| cell one | cell two |", // 10
    "", // 11
    "```text", // 12
    "code line one", // 13
    "code line two", // 14
    "```", // 15
  ].join("\n");
  const text = renderedNoteText(md);
  const lineOf = renderedNoteLines(md, text)!;
  const at = (quote: string): number | null => lineOf(text.indexOf(quote));
  expect(["Title", "A paragraph", "two", "second item", "cell two", "code line two"].map(at)).toEqual([
    0, 2, 3, 6, 10, 14,
  ]);
});
