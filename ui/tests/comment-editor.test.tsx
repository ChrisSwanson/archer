// @vitest-environment jsdom
// Browser comments.e2e.ts proves real layout. Here the browser observer is
// controlled to prove all three production editors keep and release it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../src/comments/Composer";
import { ThreadCard } from "../src/comments/ThreadCard";
import { MAX_COMMENT_CHARS, type Thread } from "../src/comments/contract";

const thread: Thread = {
  id: "t1",
  target: "view:system",
  anchor: { kind: "view" },
  status: "draft",
  revision: 1,
  comments: [{ id: "c1", author: "person", body: "Initial review", createdAt: "2026-10-04T00:00:00Z" }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["new", "edit", "reply"] as const)(
  "the %s editor keeps its identity while typing and releases its resize observer",
  (kind) => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(element: Element): void {
          observed.push(element);
        }
        disconnect = disconnect;
      },
    );
    const save = vi.fn(async () => true);
    const cancel = vi.fn();
    const component =
      kind === "new" ? (
        <Composer
          requestKey={1}
          anchor={{ kind: "view" }}
          choices={[]}
          anchorLabel="This diagram"
          onSave={save}
          onCancel={cancel}
        />
      ) : (
        <ThreadCard
          thread={thread}
          scope="view"
          onReply={save}
          onEdit={save}
          onDelete={save}
          onResolve={save}
          onDismiss={save}
        />
      );
    const { unmount } = render(component);
    if (kind !== "new") fireEvent.click(screen.getByRole("button", { name: kind === "edit" ? "Edit" : "Reply" }));
    const name = kind === "new" ? "Comment" : kind === "edit" ? "Edit your comment" : "Your reply";
    const editor = screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    expect(editor).toHaveAttribute("maxlength", String(MAX_COMMENT_CHARS));
    expect(observed).toContain(editor);
    fireEvent.change(editor, { target: { value: "A longer review question" } });
    editor.setSelectionRange(3, 8);
    expect(screen.getByRole("textbox", { name })).toBe(editor);
    expect(editor).toHaveFocus();
    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(8);
    // A sizing-only render cannot submit a comment or dismiss the editor.
    expect(save).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  },
);
