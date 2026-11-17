// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewModel } from "../src/comments/useReview";

vi.mock("../src/comments/NoteEmphasisLegend", async (load) => {
  const actual = await load<typeof import("../src/comments/NoteEmphasisLegend")>();
  return {
    ...actual,
    NoteEmphasisLegend: (props: Parameters<typeof actual.NoteEmphasisLegend>[0]) => {
      const read = props.state?.status === "ready" ? props.state.read : undefined;
      const active = read?.snapshot.emphases.find((item) => item.id === props.activeId);
      return (
        <ul>
          {active?.groups.map((group, index) => (
            <actual.NoteEmphasisGroupRow
              key={group.id}
              group={group}
              index={index}
              orphanCount={0}
              pressed={props.focusedGroupId === group.id}
              bindings={props.groupBindings?.(group.id)}
            />
          ))}
        </ul>
      );
    },
  };
});

import { NoteReader } from "../src/comments/NoteReader";

afterEach(cleanup);

const emphasis = {
  id: "review",
  title: "Review",
  author: "agent" as const,
  groups: [
    {
      id: "risk",
      label: "Risk",
      palette: "coral" as const,
      passages: [{ kind: "passage" as const, quote: "Alpha", prefix: "", suffix: " beta" }],
    },
    {
      id: "detail",
      label: "Detail",
      palette: "teal" as const,
      passages: [{ kind: "passage" as const, quote: "beta", prefix: "Alpha ", suffix: "." }],
    },
  ],
};

const modelWith = (
  orphans: readonly { emphasisId: string; groupId: string; passageIndex: number; reason: string }[] = [],
  selected = emphasis,
): ReviewModel =>
  ({
    capabilities: { comments: true, notes: true, noteEmphasis: true },
    viewId: null,
    viewTarget: null,
    threads: new Map(),
    notes: { status: "ready", notes: [{ path: "notes/context.md", title: "Context" }] },
    noteContents: new Map([
      [
        "notes/context.md",
        {
          status: "ready",
          content: { path: "notes/context.md", frontMatter: {}, markdown: "Alpha beta.", revision: "1" },
        },
      ],
    ]),
    noteEmphases: new Map([
      [
        "notes/context.md",
        {
          status: "ready",
          read: {
            snapshot: { schemaVersion: 1, notePath: "notes/context.md", revision: 1, emphases: [selected] },
            orphans,
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
  }) as unknown as ReviewModel;

it("connects the shared legend controller to existing note marks", async () => {
  render(<NoteReader model={modelWith()} path="notes/context.md" onCompose={() => {}} />);
  await waitFor(() => expect(document.querySelectorAll("mark.archer-note-highlight")).toHaveLength(2));
  const original = document.querySelector('mark[data-group-id="risk"]');
  const risk = screen.getByRole("button", { name: /Risk/ });
  fireEvent.mouseEnter(risk);
  expect(original).toHaveAttribute("data-highlight-focused", "true");
  fireEvent.click(risk);
  fireEvent.mouseLeave(risk);
  expect(original).toHaveAttribute("data-highlight-focused", "true");
  expect(document.querySelector('mark[data-group-id="risk"]')).toBe(original);
});

it("does not let a fully unavailable group dim the note", async () => {
  render(
    <NoteReader
      model={modelWith([{ emphasisId: "review", groupId: "risk", passageIndex: 0, reason: "not_found" }])}
      path="notes/context.md"
      onCompose={() => {}}
    />,
  );
  await screen.findByRole("button", { name: /Risk/ });
  expect(document.querySelector('mark[data-group-id="risk"]')).toBeNull();
  fireEvent.mouseEnter(screen.getByRole("button", { name: /Risk/ }));
  fireEvent.click(screen.getByRole("button", { name: /Risk/ }));
  expect(screen.getByRole("document", { name: "Note: Context" })).not.toHaveAttribute("data-highlight-focus");
});

it("does not let an empty group dim the note", async () => {
  const empty = { ...emphasis, groups: [{ ...emphasis.groups[0]!, passages: [] }] };
  render(<NoteReader model={modelWith([], empty)} path="notes/context.md" onCompose={() => {}} />);
  const risk = await screen.findByRole("button", { name: /Risk/ });
  fireEvent.mouseEnter(risk);
  fireEvent.click(risk);
  expect(screen.getByRole("document", { name: "Note: Context" })).not.toHaveAttribute("data-highlight-focus");
});
