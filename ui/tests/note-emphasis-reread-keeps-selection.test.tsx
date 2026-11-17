// @vitest-environment jsdom
// O40: a re-read of the note's highlights that says nothing new (the event
// stream's echo of a write the page already re-read) handed NoteItem new
// objects for the same active set. The note was laid down again for them,
// which took the reader's selection out of the document while "Comment on
// selection" stayed on screen, so the click did nothing.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteItem } from "../src/comments/NoteItem";
import type { NoteEmphasis, NoteEmphasisOrphan } from "../src/comments/contract";

afterEach(cleanup);

const emphasis: NoteEmphasis = {
  id: "reader-highlights",
  title: "Reader highlights",
  author: "person",
  groups: [
    {
      id: "follow-up",
      label: "Follow up",
      palette: "teal",
      passages: [{ kind: "passage", quote: "Later prose", prefix: "token. ", suffix: " remains" }],
    },
  ],
};
const orphans: NoteEmphasisOrphan[] = [];

function selectText(root: HTMLElement, wanted: string): void {
  const node = [...root.querySelectorAll("p")]
    .flatMap((p) => [...p.childNodes])
    .find((child): child is Text => child instanceof Text && child.data.includes(wanted))!;
  const from = node.data.indexOf(wanted);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, from + wanted.length);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

it("keeps the reader's selection, and Comment on selection working, when the same highlights are read again", async () => {
  const onCompose = vi.fn();
  const base = {
    note: { path: "notes/context.md", title: "Context" },
    state: {
      status: "ready" as const,
      content: {
        path: "notes/context.md",
        frontMatter: {},
        markdown: "The client sends a token. Later prose remains selectable, and the end.",
        revision: "1",
      },
    },
    threads: [],
    commentsEnabled: true,
    emphasisEnabled: true,
    direct: true,
    onOpen: vi.fn(),
    onCompose,
    onMissing: vi.fn(),
  };
  const view = render(<NoteItem {...base} activeEmphasis={emphasis} emphasisOrphans={orphans} />);
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).not.toBeNull());
  const body = screen.getByRole("document", { name: "Note: Context" });
  const mark = document.querySelector("mark.archer-note-highlight")!;
  selectText(body, "the end");
  await screen.findByRole("button", { name: "Comment on selection" });

  // The same set and orphans, as a fresh parse of the same answer gives them.
  view.rerender(
    <NoteItem {...base} activeEmphasis={structuredClone(emphasis)} emphasisOrphans={structuredClone(orphans)} />,
  );

  expect(document.querySelector("mark.archer-note-highlight")).toBe(mark);
  expect(document.getSelection()!.toString()).toBe("the end");
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
  expect(onCompose).toHaveBeenCalledWith(
    "note:notes/context.md",
    expect.objectContaining({ kind: "passage", quote: "the end" }),
  );
});

it("still repaints when the active set's passages change", async () => {
  const base = {
    note: { path: "notes/context.md", title: "Context" },
    state: {
      status: "ready" as const,
      content: {
        path: "notes/context.md",
        frontMatter: {},
        markdown: "The client sends a token. Later prose remains selectable, and the end.",
        revision: "1",
      },
    },
    threads: [],
    commentsEnabled: true,
    emphasisEnabled: true,
    direct: true,
    onOpen: vi.fn(),
    onCompose: vi.fn(),
    onMissing: vi.fn(),
  };
  const view = render(<NoteItem {...base} activeEmphasis={emphasis} emphasisOrphans={orphans} />);
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).toHaveTextContent("Later prose"));
  const moved: NoteEmphasis = {
    ...emphasis,
    groups: [
      { ...emphasis.groups[0]!, passages: [{ kind: "passage", quote: "client", prefix: "The ", suffix: " sends" }] },
    ],
  };
  view.rerender(<NoteItem {...base} activeEmphasis={moved} emphasisOrphans={orphans} />);
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).toHaveTextContent(/^client$/));
  // An orphan for the active set takes its passage off the page.
  view.rerender(
    <NoteItem
      {...base}
      activeEmphasis={moved}
      emphasisOrphans={[{ emphasisId: moved.id, groupId: "follow-up", passageIndex: 0 } as NoteEmphasisOrphan]}
    />,
  );
  await waitFor(() => expect(document.querySelector("mark.archer-note-highlight")).toBeNull());
});
