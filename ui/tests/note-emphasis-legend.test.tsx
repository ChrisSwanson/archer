// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteEmphasisLegend } from "../src/comments/NoteEmphasisLegend";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";

afterEach(cleanup);

const state = {
  status: "ready" as const,
  read: {
    snapshot: {
      schemaVersion: 1 as const,
      notePath: "notes/context.md",
      revision: 1,
      emphases: [
        {
          id: "design-review",
          title: "Design review changes",
          author: "agent" as const,
          groups: [
            {
              id: "boundary",
              label: "Trust boundary",
              description: "Confirm the handoff",
              palette: "coral" as const,
              passages: [{ kind: "passage" as const, quote: "token", prefix: "a ", suffix: " crosses" }],
            },
          ],
        },
      ],
    },
    orphans: [],
  },
};

it("marks the production legend as a viewport-pinned bottom-right dock", () => {
  render(
    <NoteEmphasisLegend state={state} activeId="design-review" onSelect={() => {}} onClear={vi.fn(async () => true)} />,
  );
  const legend = screen.getByRole("region", { name: "Note highlights" });
  expect(legend).toHaveClass("primary-note-emphasis-legend--pinned");
  expect(legend).toHaveAttribute("data-placement", "viewport-bottom-right");
});

it("does not reserve a dock footprint when the note has no named highlights", () => {
  const model = {
    capabilities: { comments: true, notes: true, noteEmphasis: true },
    viewId: null,
    viewTarget: null,
    threads: new Map(),
    notes: { status: "ready", notes: [{ path: "notes/context.md", title: "Context" }] },
    noteContents: new Map([
      [
        "notes/context.md",
        { status: "ready", content: { path: "notes/context.md", frontMatter: {}, markdown: "Text", revision: "1" } },
      ],
    ]),
    noteEmphases: new Map([
      [
        "notes/context.md",
        {
          status: "ready",
          read: {
            snapshot: { schemaVersion: 1, notePath: "notes/context.md", revision: 0, emphases: [] },
            orphans: [],
          },
        },
      ],
    ]),
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
      saveNoteEmphasis: vi.fn(),
      dismissError: vi.fn(),
    },
  } as unknown as ReviewModel;
  render(<NoteReader model={model} path="notes/context.md" onCompose={() => {}} />);
  expect(screen.getByRole("article", { name: "Reading Context" })).not.toHaveClass("primary-note-reader--has-emphasis");
});
