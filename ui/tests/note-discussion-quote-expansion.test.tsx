// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Thread } from "../src/comments/contract";
import { NoteDiscussionRail } from "../src/comments/NoteDiscussionRail";

afterEach(cleanup);

it("bounds the whole open discussion to the visible reader, including a maximum-length quote", () => {
  const quote = "A lengthy passage for review. ".repeat(40).slice(0, 1000);
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      x: 0,
      y: 64,
      top: 64,
      bottom: 364,
      left: 0,
      right: 264,
      width: 264,
      height: this.classList.contains("primary-note-discussion") ? 1200 : 300,
      toJSON: () => ({}),
    };
  });
  const thread: Thread = {
    id: "max-quote",
    revision: 1,
    target: "note:notes/reader.md",
    anchor: { kind: "passage", quote, prefix: "", suffix: "" },
    status: "draft",
    comments: [],
  };
  const actions = {
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const root = useRef<HTMLElement>(null);
    const text = useRef<HTMLDivElement>(null);
    return (
      <article ref={root}>
        <div ref={text}>
          <mark data-thread-id={thread.id}>{quote}</mark>
        </div>
        <NoteDiscussionRail
          threads={[thread]}
          actions={actions}
          expandedThreadId={thread.id}
          scrollRoot={root}
          documentRoot={text}
          onExpandedThreadChange={() => {}}
          onFocusedThreadChange={() => {}}
        />
      </article>
    );
  }
  try {
    const { container } = render(<Example />);
    expect(container.querySelector('.primary-note-discussion[data-expanded="true"]')).toHaveStyle({
      maxHeight: "276px",
    });
  } finally {
    geometry.mockRestore();
  }
});

it("expands a long quote independently while preserving its open discussion and reply draft", () => {
  const quote = "The parser accepts nearby tokens while preserving the exact surrounding passage for careful review.";
  const thread: Thread = {
    id: "long-quote",
    revision: 1,
    target: "note:notes/reader.md",
    anchor: { kind: "passage", quote, prefix: "", suffix: "" },
    status: "draft",
    comments: [
      { id: "comment", author: "person", body: "Please verify this claim.", createdAt: "2026-10-11T12:00:00Z" },
    ],
  };
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <NoteDiscussionRail
        threads={[thread]}
        actions={actions}
        expandedThreadId={expanded}
        onExpandedThreadChange={setExpanded}
        onFocusedThreadChange={() => {}}
      />
    );
  }

  render(<Example />);
  const header = screen.getByRole("button", { name: `Open discussion on “${quote}”` });
  fireEvent.click(header);
  const compactQuote = header.querySelector(".primary-note-discussion-quote")!;
  expect(compactQuote.textContent).toContain("...");
  expect(compactQuote.textContent!.startsWith("The parser accepts")).toBe(true);
  expect(compactQuote.textContent!.endsWith("careful review.")).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), {
    target: { value: "Keep this unfinished reply" },
  });

  fireEvent.click(screen.getByRole("button", { name: `Show full quoted passage “${quote}”` }));
  expect(screen.getByRole("button", { name: `Collapse quoted passage “${quote}”` })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(compactQuote).toHaveTextContent(quote);
  expect(screen.getByRole("textbox", { name: "Your reply" })).toHaveValue("Keep this unfinished reply");
  expect(screen.getByText("Please verify this claim.")).toBeVisible();
  expect(screen.getAllByText(quote)).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: `Collapse quoted passage “${quote}”` }));
  expect(screen.getByRole("button", { name: `Show full quoted passage “${quote}”` })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("textbox", { name: "Your reply" })).toHaveValue("Keep this unfinished reply");
});
