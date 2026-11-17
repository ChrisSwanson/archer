// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteEmphasisGroupRow } from "../src/comments/NoteEmphasisLegend";
import { NoteItem } from "../src/comments/NoteItem";
import { useLegendFocus } from "../src/emphasis/useLegendFocus";
import type { NoteEmphasis } from "../src/comments/contract";
import type { JSX } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const productionStyles = document.createElement("style");
productionStyles.textContent = readFileSync(resolve("src/comments/primary-comments.css"), "utf8");
document.head.append(productionStyles);

afterEach(cleanup);

const groups: NoteEmphasis["groups"] = [
  {
    id: "risk",
    label: "Risk",
    palette: "coral",
    passages: [{ kind: "passage", quote: "Alpha", prefix: "", suffix: " beta" }],
  },
  {
    id: "detail",
    label: "Detail",
    palette: "teal",
    passages: [{ kind: "passage", quote: "beta", prefix: "Alpha ", suffix: "." }],
  },
];

function Rows(): JSX.Element {
  const focus = useLegendFocus(
    "notes/context.md\0review",
    groups.map((group) => group.id),
  );
  return (
    <ul>
      {groups.map((group, index) => (
        <NoteEmphasisGroupRow
          key={group.id}
          group={group}
          index={index}
          orphanCount={0}
          pressed={focus.heldId === group.id}
          bindings={focus.bind(group.id)}
        />
      ))}
    </ul>
  );
}

it("uses canonical native rows for temporary previews and click-held focus", () => {
  render(<Rows />);
  const risk = screen.getByRole("button", { name: /Risk/ });
  const detail = screen.getByRole("button", { name: /Detail/ });
  fireEvent.mouseEnter(risk);
  fireEvent.click(risk);
  fireEvent.mouseLeave(risk);
  expect(risk).toHaveAttribute("aria-pressed", "true");
  fireEvent.mouseEnter(detail);
  expect(detail).toHaveAttribute("aria-pressed", "false");
  fireEvent.mouseLeave(detail);
  expect(risk).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(risk, { detail: 0 });
  expect(risk).toHaveAttribute("aria-pressed", "false");
});

it("changes note focus attributes without replacing highlight or discussion marks", async () => {
  const emphasis: NoteEmphasis = { id: "review", title: "Review", author: "agent", groups };
  const base = {
    note: { path: "notes/context.md", title: "Context" },
    state: {
      status: "ready" as const,
      content: { path: "notes/context.md", frontMatter: {}, markdown: "Alpha beta.", revision: "1" },
    },
    threads: [],
    commentsEnabled: true,
    direct: true,
    activeEmphasis: emphasis,
    onOpen: vi.fn(),
    onCompose: vi.fn(),
    onMissing: vi.fn(),
  };
  const view = render(<NoteItem {...base} focusedHighlightGroupId={null} />);
  await waitFor(() => expect(document.querySelectorAll("mark.archer-note-highlight")).toHaveLength(2));
  const mark = document.querySelector<HTMLElement>('mark[data-group-id="risk"]')!;
  view.rerender(<NoteItem {...base} focusedHighlightGroupId="risk" />);
  expect(mark).toHaveAttribute("data-highlight-focused", "true");
  expect(document.querySelector('mark[data-group-id="risk"]')).toBe(mark);
  view.rerender(<NoteItem {...base} focusedHighlightGroupId={null} />);
  expect(mark).not.toHaveAttribute("data-highlight-focused");
});

it("lets an active discussion own the paint when its passage overlaps focused emphasis", async () => {
  const emphasis: NoteEmphasis = { id: "review", title: "Review", author: "agent", groups: [groups[0]!] };
  render(
    <NoteItem
      note={{ path: "notes/context.md", title: "Context" }}
      state={{
        status: "ready",
        content: { path: "notes/context.md", frontMatter: {}, markdown: "Alpha beta.", revision: "1" },
      }}
      threads={[
        {
          id: "thread",
          revision: 1,
          target: "note:notes/context.md",
          status: "sent",
          anchor: { kind: "passage", quote: "Alpha", prefix: "", suffix: " beta" },
          comments: [{ id: "comment", author: "person", body: "Review this", createdAt: "2026-10-12T00:00:00Z" }],
        },
      ]}
      commentsEnabled
      direct
      activeEmphasis={emphasis}
      focusedHighlightGroupId="risk"
      focusedThreadId="thread"
      onOpen={vi.fn()}
      onCompose={vi.fn()}
      onMissing={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(
      document.querySelector(
        'mark[data-active-discussion="true"] .archer-note-highlight[data-highlight-focused="true"]',
      ),
    ).not.toBeNull(),
  );
  const discussion = document.querySelector<HTMLElement>('mark[data-active-discussion="true"]')!;
  const highlight = discussion.querySelector<HTMLElement>(".archer-note-highlight")!;
  expect(getComputedStyle(highlight).fontWeight).toBe("inherit");
  expect(getComputedStyle(highlight).backgroundColor).toBe("rgba(0, 0, 0, 0)");
});
