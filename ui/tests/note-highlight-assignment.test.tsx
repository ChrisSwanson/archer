// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";
import type { NoteEmphasisRead } from "../src/comments/contract";
import { NO_CAPABILITIES } from "../src/comments/contract";

// Legend previews are under live review; this regression exercises selection and saving only.
vi.mock("../src/comments/NoteEmphasisLegend", () => ({ NoteEmphasisLegend: () => null }));
afterEach(cleanup);

it("offers labels from every set and saves an agent label into person highlights with CAS", async () => {
  const read: NoteEmphasisRead = {
    snapshot: {
      schemaVersion: 1,
      notePath: "notes/test.md",
      revision: 4,
      emphases: [
        {
          id: "review",
          title: "Review",
          author: "agent",
          groups: [{ id: "risk", label: "Risk", palette: "coral", passages: [] }],
        },
        {
          id: "reader-highlights",
          title: "Reader highlights",
          author: "person",
          groups: [{ id: "check", label: "Check", palette: "teal", passages: [] }],
        },
      ],
    },
    orphans: [],
  };
  const save = vi.fn(async () => "saved" as const);
  const model: ReviewModel = {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true, noteEmphasis: true },
    viewId: null,
    viewTarget: null,
    threads: new Map(),
    notes: { status: "ready", notes: [{ path: "notes/test.md", title: "Test" }] },
    noteContents: new Map([
      [
        "notes/test.md",
        {
          status: "ready",
          content: { path: "notes/test.md", frontMatter: {}, markdown: "New passage.", revision: "1" },
        },
      ],
    ]),
    noteEmphases: new Map([["notes/test.md", { status: "ready", read }]]),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: vi.fn(async () => null),
      reply: vi.fn(async () => true),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      dismiss: vi.fn(async () => true),
      submitAll: vi.fn(async () => {}),
      openNote: vi.fn(),
      saveNoteEmphasis: save,
      dismissError: vi.fn(),
    },
  };
  render(<NoteReader model={model} path="notes/test.md" onCompose={() => {}} />);
  const paragraph = screen.getByText("New passage.");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(screen.getByRole("button", { name: "Highlight selection" }));
  const picker = screen.getByRole("combobox", { name: "Highlight group" });
  expect(picker).toHaveTextContent("Risk");
  expect(picker).toHaveTextContent("Check");
  fireEvent.change(picker, { target: { value: JSON.stringify(["review", "risk"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]).toEqual([
    expect.objectContaining({
      id: "reader-highlights",
      expectedRevision: 4,
      groups: [
        expect.objectContaining({ label: "Check" }),
        expect.objectContaining({ label: "Risk", passages: [expect.objectContaining({ quote: "New passage." })] }),
      ],
    }),
  ]);
  expect(read.snapshot.emphases[0]!.groups[0]!.passages).toEqual([]);
});
