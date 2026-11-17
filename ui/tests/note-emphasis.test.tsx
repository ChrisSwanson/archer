// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteReader } from "../src/comments/NoteReader";
import type { NoteEmphasisRead, Thread, UpsertNoteEmphasisInput } from "../src/comments/contract";
import type { ReviewModel } from "../src/comments/useReview";

afterEach(cleanup);

function reviewModel(
  options: {
    read?: NoteEmphasisRead;
    save?: (input: UpsertNoteEmphasisInput) => Promise<"saved" | "refused" | "uncertain">;
    threads?: readonly Thread[];
    enabled?: boolean;
  } = {},
): ReviewModel {
  const save = options.save ?? vi.fn(async () => "saved" as const);
  const read = options.read ?? {
    snapshot: { schemaVersion: 1 as const, notePath: "notes/context.md", revision: 0, emphases: [] },
    orphans: [],
  };
  return {
    capabilities: { comments: true, notes: true, noteEmphasis: options.enabled ?? true } as ReviewModel["capabilities"],
    viewId: null,
    viewTarget: null,
    threads: new Map(options.threads === undefined ? [] : [["note:notes/context.md", options.threads]]),
    notes: { status: "ready", notes: [{ path: "notes/context.md", title: "Context" }] },
    noteContents: new Map([
      [
        "notes/context.md",
        {
          status: "ready",
          content: { path: "notes/context.md", frontMatter: {}, markdown: "Alpha café 😀 beta.", revision: "note-1" },
        },
      ],
    ]),
    noteEmphases: new Map([["notes/context.md", { status: "ready" as const, read }]]),
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
}

function selectText(text: Text, start = 0, end = text.data.length): void {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const stored = (groups: NoteEmphasisRead["snapshot"]["emphases"][number]["groups"]): NoteEmphasisRead => ({
  snapshot: {
    schemaVersion: 1,
    notePath: "notes/context.md",
    revision: 2,
    emphases: [{ id: "reader-highlights", title: "Reader highlights", author: "person", groups }],
  },
  orphans: [],
});

it("offers a persistent highlight action for selected note text", async () => {
  render(<NoteReader model={reviewModel()} path="notes/context.md" onCompose={() => {}} />);
  const paragraph = await screen.findByText("Alpha café 😀 beta.");
  selectText(paragraph.firstChild as Text);
  expect(screen.getByRole("button", { name: "Highlight selection" })).toBeVisible();
});

it("saves a standalone selection without creating a discussion, then renders its durable legend and mark", async () => {
  let sent: UpsertNoteEmphasisInput | undefined;
  const save = vi.fn(async (input: UpsertNoteEmphasisInput) => {
    sent = input;
    return "saved" as const;
  });
  const onCompose = vi.fn();
  const rendered = render(<NoteReader model={reviewModel({ save })} path="notes/context.md" onCompose={onCompose} />);
  const paragraph = await screen.findByText("Alpha café 😀 beta.");
  selectText(paragraph.firstChild as Text, 6, 13);
  fireEvent.click(screen.getByRole("button", { name: "Highlight selection" }));
  const label = screen.getByRole("textbox", { name: "Group label" });
  expect(label).toHaveFocus();
  fireEvent.change(label, { target: { value: "Needs evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(onCompose).not.toHaveBeenCalled();
  expect(sent).toMatchObject({
    notePath: "notes/context.md",
    id: "reader-highlights",
    title: "Reader highlights",
    expectedRevision: 0,
    groups: [{ label: "Needs evidence", passages: [{ kind: "passage", quote: "café 😀" }] }],
  });

  const group = sent!.groups[0]!;
  rendered.rerender(
    <NoteReader
      model={reviewModel({ save, read: stored([{ ...group, palette: "teal" }]) })}
      path="notes/context.md"
      onCompose={onCompose}
    />,
  );
  const legend = await screen.findByRole("region", { name: "Note highlights" });
  expect(legend).toHaveTextContent("Reader highlights");
  expect(await within(legend).findByText("Needs evidence")).toBeVisible();
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).toHaveTextContent("café 😀"));
  expect(screen.getByRole("document", { name: "Note: Context" })).toHaveTextContent("Alpha café 😀 beta.");
});

it("keeps comment keyboard behavior when a standalone highlight overlaps it", async () => {
  const thread: Thread = {
    id: "passage",
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote: "café 😀", prefix: "Alpha ", suffix: " beta." },
    comments: [{ id: "person", author: "person", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  };
  const read = stored([
    {
      id: "evidence",
      label: "Evidence",
      palette: "coral",
      passages: [{ kind: "passage", quote: "café 😀", prefix: "Alpha ", suffix: " beta." }],
    },
  ]);
  const onOpenThread = vi.fn();
  render(
    <NoteReader
      model={reviewModel({ read, threads: [thread] })}
      path="notes/context.md"
      onCompose={() => {}}
      onOpenThread={onOpenThread}
    />,
  );
  const comment = await screen.findByRole("button", { name: "Open discussion on this passage" });
  expect(comment).toHaveClass("archer-passage--person");
  expect(comment.querySelector(".archer-note-highlight")).toHaveTextContent("café 😀");
  fireEvent.keyDown(comment, { key: "Enter" });
  expect(onOpenThread).not.toHaveBeenCalled();
  expect(screen.getByRole("complementary", { name: "Note discussions" })).toHaveTextContent("Check this");
  expect(screen.getByRole("document", { name: "Note: Context" })).toHaveTextContent("Alpha café 😀 beta.");
});

it("hides named highlights without removing their non-color legend labels", async () => {
  const read = stored([
    {
      id: "risk",
      label: "<b>Risk</b>",
      description: "Review this",
      palette: "coral",
      passages: [{ kind: "passage", quote: "Alpha", prefix: "", suffix: " café" }],
    },
  ]);
  render(<NoteReader model={reviewModel({ read })} path="notes/context.md" onCompose={() => {}} />);
  const legend = await screen.findByRole("region", { name: "Note highlights" });
  expect(await within(legend).findByText("<b>Risk</b>")).toBeVisible();
  expect(document.querySelector(".primary-note-emphasis-groups b")).toBeNull();
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).toBeNull());
  expect(screen.getByRole("button", { name: /Reader highlights/ })).toBeVisible();
});

it("keeps the legacy selection popup unchanged when the capability is absent", async () => {
  render(<NoteReader model={reviewModel({ enabled: false })} path="notes/context.md" onCompose={() => {}} />);
  const paragraph = await screen.findByText("Alpha café 😀 beta.");
  selectText(paragraph.firstChild as Text);
  expect(screen.getByRole("button", { name: "Comment on selection" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Highlight selection" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Note highlights" })).not.toBeInTheDocument();
});

it("shows the newest named set when the first agent highlight arrives live", async () => {
  const rendered = render(<NoteReader model={reviewModel()} path="notes/context.md" onCompose={() => {}} />);
  expect(document.querySelector("mark.archer-note-highlight")).toBeNull();
  const agentRead: NoteEmphasisRead = {
    snapshot: {
      schemaVersion: 1,
      notePath: "notes/context.md",
      revision: 1,
      emphases: [
        {
          id: "agent-review",
          title: "Agent review",
          author: "agent",
          groups: [
            {
              id: "risk",
              label: "Risk",
              palette: "coral",
              passages: [{ kind: "passage", quote: "Alpha", prefix: "", suffix: " café" }],
            },
          ],
        },
      ],
    },
    orphans: [],
  };
  rendered.rerender(
    <NoteReader model={reviewModel({ read: agentRead })} path="notes/context.md" onCompose={() => {}} />,
  );
  await waitFor(() =>
    expect(document.querySelector('mark[data-emphasis-id="agent-review"]')).toHaveTextContent("Alpha"),
  );
  expect(screen.getByRole("button", { name: /Agent review Agent/ })).toHaveAttribute("aria-pressed", "true");
});

it("preserves an invalid local highlight draft and explains it without sending a write", async () => {
  const duplicate = { kind: "passage" as const, quote: "café 😀", prefix: "Alpha ", suffix: " beta." };
  const save = vi.fn(async () => "saved" as const);
  render(
    <NoteReader
      model={reviewModel({
        save,
        read: stored([{ id: "same", label: "Same", palette: "teal", passages: [duplicate] }]),
      })}
      path="notes/context.md"
      onCompose={() => {}}
    />,
  );
  await screen.findByRole("document", { name: "Note: Context" });
  const highlighted = document.querySelector("mark.archer-note-highlight")!;
  selectText(highlighted.firstChild as Text);
  fireEvent.click(screen.getByRole("button", { name: "Highlight selection" }));
  const label = screen.getByRole("textbox", { name: "Group label" });
  fireEvent.change(label, { target: { value: "Same" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That passage is already in this highlight group.");
  expect(label).toHaveValue("Same");
  expect(save).not.toHaveBeenCalled();
});

it("explains a full local group without sending a write", async () => {
  const save = vi.fn(async () => "saved" as const);
  const passages = Array.from({ length: 64 }, (_, at) => ({
    kind: "passage" as const,
    quote: `missing ${at}`,
    prefix: "",
    suffix: "",
  }));
  render(
    <NoteReader
      model={reviewModel({ save, read: stored([{ id: "full", label: "Full", palette: "teal", passages }]) })}
      path="notes/context.md"
      onCompose={() => {}}
    />,
  );
  const paragraph = await screen.findByText("Alpha café 😀 beta.");
  selectText(paragraph.firstChild as Text, 6, 13);
  fireEvent.click(screen.getByRole("button", { name: "Highlight selection" }));
  const label = screen.getByRole("textbox", { name: "Group label" });
  fireEvent.change(label, { target: { value: "Full" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A group holds at most 64 passages.");
  expect(label).toHaveValue("Full");
  expect(save).not.toHaveBeenCalled();
});

it("keeps explicitly hidden highlights hidden when a newer set arrives", async () => {
  const first = stored([
    {
      id: "risk",
      label: "Risk",
      palette: "coral",
      passages: [{ kind: "passage", quote: "Alpha", prefix: "", suffix: " café" }],
    },
  ]);
  const rendered = render(
    <NoteReader model={reviewModel({ read: first })} path="notes/context.md" onCompose={() => {}} />,
  );
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  const newer: NoteEmphasisRead = {
    ...first,
    snapshot: {
      ...first.snapshot,
      revision: 3,
      emphases: [
        ...first.snapshot.emphases,
        {
          id: "agent-new",
          title: "Agent new",
          author: "agent",
          groups: [
            {
              id: "new",
              label: "New",
              palette: "coral",
              passages: [{ kind: "passage", quote: "beta", prefix: "😀 ", suffix: "." }],
            },
          ],
        },
      ],
    },
  };
  rendered.rerender(<NoteReader model={reviewModel({ read: newer })} path="notes/context.md" onCompose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true"));
  expect(document.querySelector("mark.archer-note-highlight")).toBeNull();
});

it("does not offer to clear a matching-title imported person set", async () => {
  const imported: NoteEmphasisRead = {
    snapshot: {
      schemaVersion: 1,
      notePath: "notes/context.md",
      revision: 2,
      emphases: [
        {
          id: "reader-highlights-imported",
          title: "Reader highlights",
          author: "person",
          groups: [
            {
              id: "risk",
              label: "Risk",
              palette: "coral",
              passages: [{ kind: "passage", quote: "Alpha", prefix: "", suffix: " café" }],
            },
          ],
        },
      ],
    },
    orphans: [],
  };
  render(<NoteReader model={reviewModel({ read: imported })} path="notes/context.md" onCompose={() => {}} />);
  expect(await screen.findByRole("button", { name: /Reader highlights You/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Clear Reader highlights/ })).not.toBeInTheDocument();
});
