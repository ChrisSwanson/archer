// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteItem } from "../src/comments/NoteItem";
import type { NoteEmphasis, Thread } from "../src/comments/contract";

afterEach(() => cleanup());

const emphasis: NoteEmphasis = {
  id: "design-review",
  title: "Design review",
  author: "agent",
  groups: [
    {
      id: "boundary",
      label: "<Trust boundary>",
      description: "Confirm café 😀 stays literal & safe.",
      palette: "coral",
      passages: [{ kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: "." }],
    },
  ],
};

function noteElement(
  threads: readonly Thread[] = [],
  onOpenThread = vi.fn(),
  focusedThreadId?: string | null,
  onOpenThreads?: (ids: readonly string[]) => void,
) {
  return (
    <NoteItem
      direct
      note={{ path: "notes/context.md", title: "Context" }}
      state={{
        status: "ready",
        content: {
          path: "notes/context.md",
          frontMatter: {},
          markdown: "The **client sends** café 😀 token.",
          revision: "1",
        },
      }}
      threads={threads}
      commentsEnabled
      activeEmphasis={emphasis}
      onOpen={() => {}}
      onCompose={() => {}}
      onMissing={() => {}}
      onOpenThread={onOpenThread}
      onOpenThreads={onOpenThreads}
      focusedThreadId={focusedThreadId}
    />
  );
}

function note(threads: readonly Thread[] = [], onOpenThread = vi.fn()) {
  return render(noteElement(threads, onOpenThread));
}

it("shows safe label and description from a painted highlight on hover, focus, and Escape", async () => {
  note();
  await waitFor(() => expect(document.querySelectorAll("mark.archer-note-highlight")).toHaveLength(2));
  const marks = [...document.querySelectorAll<HTMLElement>("mark.archer-note-highlight")];
  expect(marks.map((mark) => mark.tabIndex)).toEqual([0, -1]);

  fireEvent.mouseOver(marks[1]!);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("<Trust boundary>");
  expect(tooltip).toHaveTextContent("Confirm café 😀 stays literal & safe.");
  expect(tooltip.querySelector("b")).toBeNull();

  fireEvent.mouseOut(marks[1]!, { relatedTarget: tooltip });
  expect(screen.getByRole("tooltip")).toBeVisible();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

  marks[0]!.focus();
  fireEvent.focusIn(marks[0]!);
  expect(screen.getByRole("tooltip")).toBeVisible();
});

it("keeps the discussion button behavior while its nested highlight explains itself on focus", async () => {
  const thread: Thread = {
    id: "passage",
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: "." },
    comments: [{ id: "agent", author: "agent", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  };
  const openThread = vi.fn();
  note([thread], openThread);
  const discussion = await screen.findByRole("button", { name: "Open discussion on this passage" });
  discussion.focus();
  fireEvent.focusIn(discussion);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("Discussion");
  expect(tooltip).toHaveTextContent("Open discussion on this passage");
  expect(tooltip).toHaveTextContent("<Trust boundary>");
  expect(tooltip).toHaveTextContent("Confirm café 😀 stays literal & safe.");
  expect(discussion).toHaveAttribute("data-thread-id", "passage");

  fireEvent.click(discussion);
  expect(openThread).toHaveBeenCalledTimes(1);
  openThread.mockClear();
  fireEvent.keyDown(discussion, { key: "Enter" });
  expect(openThread).toHaveBeenCalledTimes(1);
  openThread.mockClear();
  fireEvent.keyDown(discussion, { key: " " });
  expect(openThread).toHaveBeenCalledTimes(1);
});

it("dismisses an overlapping highlight tooltip when its discussion opens", async () => {
  const thread: Thread = {
    id: "passage",
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: "." },
    comments: [{ id: "agent", author: "agent", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  };
  const openThread = vi.fn();
  note([thread], openThread);
  const discussion = await screen.findByRole("button", { name: "Open discussion on this passage" });
  expect(discussion.querySelector("mark.archer-note-highlight")).not.toBeNull();

  fireEvent.focusIn(discussion);
  const keyboardTooltip = screen.getByRole("tooltip");
  expect(discussion).toHaveAttribute("aria-describedby", keyboardTooltip.id);
  fireEvent.keyDown(discussion, { key: "Enter" });
  expect(openThread).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(discussion).not.toHaveAttribute("aria-describedby");

  fireEvent.focusIn(discussion);
  const pointerTooltip = screen.getByRole("tooltip");
  expect(discussion).toHaveAttribute("aria-describedby", pointerTooltip.id);
  fireEvent.click(discussion);
  expect(openThread).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(discussion).not.toHaveAttribute("aria-describedby");
});

it("focuses a margin-thread quote without repainting its mark or disturbing keyboard activation", async () => {
  const thread: Thread = {
    id: "passage",
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: "." },
    comments: [{ id: "agent", author: "agent", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  };
  const openThread = vi.fn();
  const rendered = render(noteElement([thread], openThread, null));
  const discussion = await screen.findByRole("button", { name: "Open discussion on this passage" });
  discussion.focus();

  rendered.rerender(noteElement([thread], openThread, "passage"));
  expect(screen.getAllByRole("button", { name: "Open discussion on this passage" })[0]).toBe(discussion);
  expect(discussion).toHaveFocus();
  expect(discussion).toHaveAttribute("data-active-discussion", "true");
  fireEvent.keyDown(discussion!, { key: "Enter" });
  expect(openThread).toHaveBeenCalledTimes(1);

  rendered.rerender(noteElement([thread], openThread, null));
  expect(discussion).not.toHaveAttribute("data-active-discussion");
  expect(discussion).toHaveFocus();
});

it("segments exact overlapping discussions into one keyboard target while every markup fragment stays clickable", async () => {
  const base: Omit<Thread, "id"> = {
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: "." },
    comments: [{ id: "agent", author: "agent", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  };
  const threads = [
    { ...base, id: "first" },
    { ...base, id: "second" },
  ];
  const openThread = vi.fn();
  const openThreads = vi.fn();
  const rendered = render(noteElement(threads, openThread, null, openThreads));

  const trigger = await screen.findByRole("button", { name: "Open 2 discussions on this passage" });
  const fragments = [...document.querySelectorAll<HTMLElement>('mark[data-thread-ids="first second"]')];
  expect(fragments).toHaveLength(2);
  expect(fragments.some((mark) => mark.querySelector("mark[data-thread-id]"))).toBe(false);
  expect(fragments.filter((mark) => mark.tabIndex === 0)).toEqual([trigger]);
  fireEvent.focusIn(trigger);
  expect(screen.getByRole("tooltip")).toHaveTextContent("2 discussions");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Open discussions on this passage");

  fireEvent.click(fragments[1]!);
  expect(openThreads).toHaveBeenCalledWith(["first", "second"]);
  expect(openThread).not.toHaveBeenCalled();

  rendered.rerender(noteElement(threads, openThread, "second", openThreads));
  expect(fragments[0]).toHaveAttribute("data-thread-id", "second");
  expect(fragments[0]).toHaveAttribute("data-active-discussion", "true");
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(openThread).toHaveBeenCalledWith("second");
});

it("segments partial overlaps without nesting and gives each logical discussion one keyboard route", async () => {
  const make = (id: string, quote: string, prefix: string, suffix: string): Thread => ({
    id,
    revision: 1,
    target: "note:notes/context.md",
    status: "sent",
    anchor: { kind: "passage", quote, prefix, suffix },
    comments: [{ id: `${id}-agent`, author: "agent", body: "Check this", createdAt: "2026-10-11T12:00:00Z" }],
  });
  const threads = [
    make("first", "client sends café", "The ", " 😀 token."),
    make("second", "sends café 😀 token", "The client ", "."),
  ];
  const openThreads = vi.fn();
  render(noteElement(threads, vi.fn(), null, openThreads));

  expect(await screen.findAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Open discussion on this passage" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open 2 discussions on this passage" })).toBeVisible();
  const overlap = document.querySelector<HTMLElement>('mark[data-thread-ids="first second"]');
  expect(overlap).not.toBeNull();
  expect(document.querySelector("mark[data-thread-id] mark[data-thread-id]")).toBeNull();
  fireEvent.click(overlap!);
  expect(openThreads).toHaveBeenCalledWith(["first", "second"]);
});

it("dismisses a fixed highlight tooltip when scrolling or resizing invalidates its coordinates", async () => {
  note();
  const mark = await waitFor(() => document.querySelector<HTMLElement>("mark.archer-note-highlight")!);
  fireEvent.mouseOver(mark);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toBeVisible();
  expect(mark).toHaveAttribute("aria-describedby", tooltip.id);
  fireEvent.scroll(tooltip);
  expect(screen.getByRole("tooltip")).toBeVisible();
  expect(mark).toHaveAttribute("aria-describedby", tooltip.id);
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.mouseOver(mark);
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
