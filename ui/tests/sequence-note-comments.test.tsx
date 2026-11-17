// @vitest-environment jsdom
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { anchorAt, anchorIds, anchorMissing, diagramChoices } from "../src/comments/canvas-anchors";
import { parseThread } from "../src/comments/parse";
import { sequenceSelectionModel } from "../src/selection/sequence-selection";

afterEach(cleanup);
async function drawing(
  source = "sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nopt ready\nNote over A,B: Body MAY be short and stout\nA->>B: Send\nend\n",
) {
  const { compile } = await import(resolve(__dirname, "../../ts/src/mermaid/index.ts"));
  const compiled = await compile(source);
  expect(compiled.diagnostics).toEqual([]);
  const projected = projectEnvelope({
    schemaVersion: 2,
    view: { id: "seq", kind: "sequence", title: "Sequence" },
    revision: `sha256:${"a".repeat(64)}`,
    model: compiled.model,
  });
  if (!projected.ok || projected.type !== "sequence")
    throw new Error(`sequence projection failed: ${JSON.stringify(projected)}`);
  return projected;
}

test("note comments have their own keyboard button and pin, without selecting or clearing messages", async () => {
  const projected = await drawing();
  const layout = computeSequenceLayout(projected.view);
  const handlers = { onNodeClick: vi.fn(), onEdgeClick: vi.fn(), onPaneClick: vi.fn(), onNoteComment: vi.fn() };
  const { container } = render(
    <SequenceCanvas
      layout={layout}
      blockComments
      {...handlers}
      commented={{
        nodeIds: new Set(["note-0"]),
        edgeIds: new Set(),
        groupIds: new Set(),
        nodePins: new Map([["note-0", [{ threadId: "t-note", number: 1, state: "sent" }]]]),
      }}
    />,
  );
  const note = screen.getByRole("button", {
    name: "Note over Client and Server: Body MAY be short and stout, has comments",
  });
  expect(note).toHaveAttribute("tabindex", "0");
  expect(note).not.toHaveAttribute("aria-pressed");
  fireEvent.click(note);
  fireEvent.keyDown(note, { key: "Enter" });
  fireEvent.keyDown(note, { key: " " });
  expect(handlers.onNoteComment.mock.calls).toEqual([["note-0"], ["note-0"], ["note-0"]]);
  expect(handlers.onNodeClick).not.toHaveBeenCalled();
  expect(handlers.onEdgeClick).not.toHaveBeenCalled();
  expect(handlers.onPaneClick).not.toHaveBeenCalled();
  expect(container.querySelector('[data-owner="note-0"] [data-pin-thread="t-note"]')).not.toBeNull();
  const anchor = { kind: "node" as const, id: "note-0", label: "Body MAY be short and stout" };
  expect(anchorAt(note, projected)).toEqual(anchor);
  expect(anchorMissing(projected, anchor)).toBe(false);
  expect(anchorMissing(projected, { ...anchor, id: "note-99" })).toBe(true);
  expect(anchorIds(anchor, projected)).toBeNull();
  expect(diagramChoices(projected, [], []).find((choice) => choice.anchor.kind === "node")).toEqual({
    anchor,
    label: "Note over Client and Server: Body MAY be short and stout",
  });
  const selection = sequenceSelectionModel(projected.view);
  expect(selection.nodeDetails.has("note-0")).toBe(false);
  expect(selection.edgeDetails.has("note-0")).toBe(false);
});

test("the page preserves and validates server-owned note identity metadata", () => {
  const wire = {
    id: "t-note",
    target: "view:seq",
    revision: 1,
    anchor: { kind: "node", id: "note-0", label: "Body MAY be short and stout" },
    status: "sent",
    identity: { version: 1, fingerprint: `sha256:${"a".repeat(64)}`, unique: true },
    comments: [{ id: "c-note", author: "person", body: "Review this note", createdAt: "2026-11-12T12:00:00Z" }],
  };
  expect(parseThread(wire)).toEqual(wire);
  expect(parseThread({ ...wire, identity: { ...wire.identity, fingerprint: "note-0" } })).toBeUndefined();
  expect(parseThread({ ...wire, identity: { ...wire.identity, unique: false } })).toBeUndefined();
  expect(parseThread({ ...wire, orphaned: true, identity: { ...wire.identity, unique: false } })?.orphaned).toBe(true);
});

test("editing keeps note picking while the read-only canvas offers comments", async () => {
  const layout = computeSequenceLayout((await drawing()).view);
  const onPartClick = vi.fn(),
    onNoteComment = vi.fn();
  const { container } = render(
    <SequenceCanvas
      layout={layout}
      blockComments
      onPartClick={onPartClick}
      onParticipantMove={vi.fn()}
      {...{ onNoteComment }}
    />,
  );
  fireEvent.click(container.querySelector('[data-seq-part="note"] path')!);
  expect(onPartClick).toHaveBeenCalledExactlyOnceWith("note", "note-0", false);
  expect(onNoteComment).not.toHaveBeenCalled();
});

test("a note draft refuses save after positional ids may have shifted and keeps the words", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const onSave = vi.fn(async () => true);
  const props = {
    requestKey: 1,
    anchor: { kind: "node" as const, id: "note-0", label: "Original note" },
    anchorLabel: "Original note",
    choices: [],
    onSave,
    onCancel: vi.fn(),
    scopeGuard: () => "note" as const,
    keep: { scope: "note-stale", target: "view:seq" as const, baseRevision: `sha256:${"a".repeat(64)}` },
  };
  const { rerender } = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Original note question" } });
  rerender(<Composer {...props} keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }} />);
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Original note question");
  expect(screen.getByText(/The diagram changed/)).toHaveTextContent("intended note");
  expect(onSave).not.toHaveBeenCalled();
});

test("an orphan note explains safe recovery and does not leave a pin on a reused positional id", async () => {
  const { ThreadCard } = await import("../src/comments/ThreadCard");
  const { commentPins } = await import("../src/comments/state");
  const thread = {
    id: "t-orphan-note",
    target: "view:seq" as const,
    revision: 1,
    anchor: { kind: "node" as const, id: "note-0", label: "Original note" },
    status: "sent" as const,
    orphaned: true,
    identity: { version: 1 as const, fingerprint: `sha256:${"a".repeat(64)}`, unique: false },
    comments: [
      { id: "c-note", author: "person" as const, body: "Original note question", createdAt: "2026-11-12T12:00:00Z" },
    ],
  };
  render(
    <ThreadCard
      thread={thread}
      scope="view"
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  expect(screen.getByText(/This note cannot be identified safely/)).toHaveTextContent(
    "Start a new comment on the intended note",
  );
  expect(commentPins([thread]).nodePins.size).toBe(0);
});

test("a positional note id shared with a participant is refused by the real projection", async () => {
  const { compile } = await import(resolve(__dirname, "../../ts/src/mermaid/index.ts"));
  const compiled = await compile(
    "sequenceDiagram\nparticipant note-0\nparticipant A as Client\nparticipant B as Server\nNote over A,B: Body MAY be short and stout\nA->>B: Send\n",
  );
  expect(compiled.diagnostics).toEqual([]);
  expect(
    projectEnvelope({
      schemaVersion: 2,
      view: { id: "seq", kind: "sequence", title: "Sequence" },
      revision: `sha256:${"a".repeat(64)}`,
      model: compiled.model,
    }),
  ).toEqual({ ok: false, errors: [{ code: "duplicate_note_id", message: "duplicate_note_id" }] });
});

test("a participant whose authored id resembles a note is not guarded as a positional annotation", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const props = {
    requestKey: 1,
    anchor: { kind: "node" as const, id: "note-0", label: "Participant" },
    anchorLabel: "Participant",
    choices: [],
    onSave: vi.fn(async () => true),
    onCancel: vi.fn(),
    scopeGuard: (anchor: import("../src/comments/contract").Anchor) =>
      anchor.kind === "group" ? ("block" as const) : undefined,
    keep: { scope: "participant-note-id", target: "view:seq" as const, baseRevision: `sha256:${"a".repeat(64)}` },
  };
  const { rerender } = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Participant question" } });
  rerender(<Composer {...props} keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }} />);
  expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled();
});

test("an opened note draft keeps its revision guard when source replaces it with a participant", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const props = {
    requestKey: 1,
    anchor: { kind: "node" as const, id: "note-0", label: "Original note" },
    anchorLabel: "Original note",
    choices: [],
    onSave: vi.fn(async () => true),
    onCancel: vi.fn(),
    scopeGuard: () => "note" as const,
    keep: {
      scope: "note-replaced-by-participant",
      target: "view:seq" as const,
      baseRevision: `sha256:${"a".repeat(64)}`,
    },
  };
  const { rerender } = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Original note question" } });
  rerender(
    <Composer {...props} scopeGuard={undefined} keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }} />,
  );
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Original note question");
});

test("a restored note draft retains its comment scope even if its id now names a participant", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const props = {
    requestKey: 1,
    anchor: { kind: "node" as const, id: "note-0", label: "Same words" },
    anchorLabel: "Same words",
    choices: [],
    onSave: vi.fn(async () => true),
    onCancel: vi.fn(),
    scopeGuard: () => "note" as const,
    keep: {
      scope: "restored-note-to-participant",
      target: "view:seq" as const,
      baseRevision: `sha256:${"a".repeat(64)}`,
    },
  };
  const first = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
    target: { value: "Original annotation question" },
  });
  first.unmount();
  render(
    <Composer {...props} scopeGuard={undefined} keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }} />,
  );
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Original annotation question");
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
});

test("the note comment button retains a screen hit floor after zooming out", async () => {
  const layout = computeSequenceLayout((await drawing()).view);
  const { container } = render(<SequenceCanvas layout={layout} blockComments onNoteComment={vi.fn()} />);
  for (let i = 0; i < 15; i++)
    fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { ctrlKey: true, deltaY: 100 });
  const scale = Number(
    /scale\(([^)]+)\)/.exec(container.querySelector(".archer-seq-viewport")!.getAttribute("transform")!)![1],
  );
  const hit = container.querySelector(".archer-seq-note-comment-hit");
  expect(hit).not.toBeNull();
  expect(Number(hit!.getAttribute("width")) * scale).toBeGreaterThanOrEqual(24);
  expect(Number(hit!.getAttribute("height")) * scale).toBeGreaterThanOrEqual(24);
});

test("choosing a note in About persists its scope before any further typing", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const whole = { anchor: { kind: "view" as const }, label: "Whole diagram" };
  const annotation = {
    anchor: { kind: "node" as const, id: "note-0", label: "Same words" },
    label: "Note over Client: Same words",
  };
  const props = {
    requestKey: 1,
    anchor: whole.anchor,
    anchorLabel: whole.label,
    choices: [whole, annotation],
    onSave: vi.fn(async () => true),
    onCancel: vi.fn(),
    scopeGuard: (anchor: import("../src/comments/contract").Anchor) =>
      anchor.kind === "node" ? ("note" as const) : anchor.kind === "group" ? ("block" as const) : undefined,
    keep: { scope: "note-picked-in-about", target: "view:seq" as const, baseRevision: `sha256:${"a".repeat(64)}` },
  };
  const first = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Note question" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Comment on" }), { target: { value: "1" } });
  first.unmount();
  render(
    <Composer
      {...props}
      anchor={annotation.anchor}
      anchorLabel={annotation.label}
      scopeGuard={undefined}
      keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Note question");
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
});
