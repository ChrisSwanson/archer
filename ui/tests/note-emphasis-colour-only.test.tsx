// @vitest-environment jsdom
// ADR 0030 on the note page: nobody picks a colour, groups are coloured by
// position (teal, violet, coral, never amber), and the legend row is the
// group's name and why, with no colour words or counts.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteHighlightEditor } from "../src/comments/NoteHighlightEditor";
import { NoteEmphasisGroupRow } from "../src/comments/NoteEmphasisLegend";
import { NoteItem } from "../src/comments/NoteItem";
import { appendPersonHighlight } from "../src/comments/useNoteEmphasis";
import type { NoteEmphasis, NoteEmphasisRead } from "../src/comments/contract";

afterEach(cleanup);

const passage = (quote: string) => ({ kind: "passage" as const, quote, prefix: "", suffix: "" });

it("offers no colour choice and saves a new group by its label alone", async () => {
  const onSave = vi.fn(async () => ({ ok: true as const }));
  render(
    <NoteHighlightEditor
      groups={[{ key: "k", id: "risk", label: "Risk", author: "agent", setTitle: "Review" }]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  expect(screen.queryByRole("combobox", { name: "Color" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Highlight group" })).not.toHaveTextContent(/teal|violet|coral|amber/i);
  fireEvent.change(screen.getByRole("textbox", { name: "Group label" }), { target: { value: "Needs evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Needs evidence", expect.any(Function)));
});

const reader = (groups: { id: string; label: string }[]): NoteEmphasisRead => ({
  snapshot: {
    schemaVersion: 1,
    notePath: "n.md",
    revision: 2,
    emphases: [
      {
        id: "reader-highlights",
        title: "Reader highlights",
        author: "person",
        groups: groups.map((group, index) => ({
          ...group,
          palette: (["teal", "violet", "coral"] as const)[index]!,
          passages: [passage(group.id)],
        })),
      },
    ],
  },
  orphans: [],
});

it("builds reader highlights without palettes, at most three groups, with legend-sized labels", () => {
  const built = appendPersonHighlight(reader([{ id: "a", label: "A" }]), "Second", passage("b"));
  expect(built).toMatchObject({ ok: true });
  if (!built.ok) throw new Error("expected a request");
  expect(built.input.groups.map((group) => Object.keys(group).includes("palette"))).toEqual([false, false]);

  const full = reader([
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ]);
  expect(appendPersonHighlight(full, "Fourth", passage("d"))).toEqual({
    ok: false,
    problem: expect.stringContaining("3 groups"),
  });
  expect(appendPersonHighlight(full, "B", passage("d"))).toMatchObject({ ok: true });
  expect(appendPersonHighlight(reader([]), "one two three four five", passage("d"))).toEqual({
    ok: false,
    problem: expect.stringContaining("4 words"),
  });
  expect(appendPersonHighlight(reader([]), "x".repeat(33), passage("d"))).toEqual({
    ok: false,
    problem: expect.stringContaining("32 characters"),
  });
});

it("a legend row is a swatch, a label and why: no colour name and no passage count", () => {
  render(
    <ul>
      <NoteEmphasisGroupRow
        index={1}
        orphanCount={0}
        pressed={false}
        group={{
          id: "g",
          label: "Trust boundary",
          description: "Confirm the handoff",
          palette: "coral",
          passages: [passage("x"), passage("y")],
        }}
      />
    </ul>,
  );
  const row = screen.getByRole("listitem");
  expect(row).toHaveClass("archer-emph-palette-violet");
  expect(row).toHaveTextContent("Trust boundary · Confirm the handoff");
  expect(row).not.toHaveTextContent(/amber|violet|passage/i);
});

it("passages are painted by group order, whatever palette the wire names", () => {
  const emphasis: NoteEmphasis = {
    id: "e",
    author: "agent",
    groups: [
      { id: "first", label: "First", palette: "coral", passages: [passage("Alpha")] },
      { id: "second", label: "Second", palette: "coral", passages: [passage("beta")] },
    ],
  };
  const { container } = render(
    <NoteItem
      direct
      note={{ path: "n.md", title: "N" }}
      commentsEnabled={false}
      threads={[]}
      activeEmphasis={emphasis}
      state={{
        status: "ready",
        content: { path: "n.md", frontMatter: {}, markdown: "Alpha and beta.", revision: "1" },
      }}
      onOpen={() => {}}
      onCompose={() => {}}
      onMissing={() => {}}
    />,
  );
  const marks = [...container.querySelectorAll<HTMLElement>("mark.archer-note-highlight")];
  expect(marks.map((mark) => [mark.dataset.groupId, mark.className.match(/archer-emph-palette-(\w+)/)?.[1]])).toEqual([
    ["first", "teal"],
    ["second", "violet"],
  ]);
});
