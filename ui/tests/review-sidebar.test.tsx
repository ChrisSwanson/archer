// @vitest-environment jsdom
/**
 * The Project review sidebar (decided 2026-10-08): it overlays the
 * canvas instead of narrowing it; tabs (All, Unread, Answered, Drafts) choose
 * what is shown; threads sit under their diagram or note, by recent activity,
 * each collapsed to the same height on a conversation rail; a checkbox per
 * thread selects it, and one action bar acts on the selection or, with nothing
 * selected, on the tab; New comment closes the top section; a thread expands
 * in place so it can be answered there.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import { byRecentActivity, lastActivity, relativeTime } from "../src/comments/state";
import { useReview, type ReviewModel } from "../src/comments/useReview";
import { createReviewEvents } from "../src/comments/events";
import type { Thread } from "../src/comments/contract";
import { installMatchMedia } from "./match-media";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

afterEach(cleanup);

const comment = (id: string, author: "person" | "agent", body: string, createdAt: string, editedAt?: string) => ({
  id,
  author,
  body,
  createdAt,
  ...(editedAt ? { editedAt } : {}),
});

const older: Thread = {
  id: "older",
  revision: 1,
  target: "view:system",
  anchor: { kind: "node", id: "web", label: "Web" },
  status: "answered",
  comments: [
    comment("o1", "person", "Older question", "2026-10-01T09:00:00Z"),
    comment("o2", "agent", "Older answer", "2026-10-01T10:00:00Z"),
  ],
};
const newest: Thread = {
  id: "newest",
  revision: 1,
  target: "view:system",
  anchor: { kind: "node", id: "db", label: "Database" },
  status: "draft",
  comments: [comment("n1", "person", "Newest draft", "2026-10-07T09:00:00Z")],
};
const middle: Thread = {
  id: "middle",
  revision: 1,
  target: "note:notes/auth.md",
  anchor: { kind: "view" },
  status: "resolved",
  comments: [
    comment("m1", "person", "Middle note question", "2026-10-03T09:00:00Z"),
    comment("m2", "agent", "Done", "2026-10-04T09:00:00Z"),
  ],
};

function model(
  threads: readonly Thread[] = [older, middle, newest],
  extra: Partial<ReviewModel["actions"]> = {},
): ReviewModel {
  const byTarget = new Map<Thread["target"], Thread[]>();
  for (const thread of threads) byTarget.set(thread.target, [...(byTarget.get(thread.target) ?? []), thread]);
  return {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: byTarget,
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    isUnread: (thread) => thread.comments.some((c) => c.author === "agent"),
    actions: {
      markSeen: vi.fn(),
      create: vi.fn(async () => null),
      reply: vi.fn(async () => true),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      dismiss: vi.fn(async () => true),
      submitAll: vi.fn(async () => {}),
      openNote: vi.fn(),
      dismissError: vi.fn(),
      markAllSeen: vi.fn(),
      resolveAll: vi.fn(async () => 0),
      dismissAll: vi.fn(async () => 0),
      publishAll: vi.fn(async () => 0),
      ...extra,
    },
  };
}

function renderInbox(held: ReviewModel = model(), more: Record<string, unknown> = {}) {
  installMatchMedia(false);
  const props = {
    mode: "floating" as const,
    model: held,
    open: true,
    compose: null,
    onClose: vi.fn(),
    onCompose: vi.fn(),
    onComposeEnd: () => {},
    diagramChoices: [],
    onOpenTarget: vi.fn(),
    onShowAnchor: vi.fn(),
    ...more,
  };
  render(<ReviewPanel {...props} />);
  return { props, inbox: screen.getByRole("region", { name: "Project Review" }) };
}

const entries = (inbox: HTMLElement): HTMLElement[] =>
  within(inbox)
    .getAllByRole("button", { expanded: false })
    .concat(within(inbox).queryAllByRole("button", { expanded: true }))
    .filter((button) => button.classList.contains("primary-inbox-thread"))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

describe("recency", () => {
  it("takes a thread’s latest comment, reply, answer or edit as its activity", () => {
    expect(lastActivity(older)).toBe(Date.parse("2026-10-01T10:00:00Z"));
    const edited: Thread = {
      ...older,
      comments: [comment("o1", "person", "Edited later", "2026-10-01T09:00:00Z", "2026-10-09T09:00:00Z")],
    };
    expect(lastActivity(edited)).toBe(Date.parse("2026-10-09T09:00:00Z"));
  });

  it("orders the newest activity first, with ties kept in a stable id order", () => {
    const twinA: Thread = { ...newest, id: "a-twin" };
    const twinB: Thread = { ...newest, id: "b-twin" };
    expect(byRecentActivity([older, twinB, middle, twinA]).map((t) => t.id)).toEqual([
      "a-twin",
      "b-twin",
      "middle",
      "older",
    ]);
  });

  it("lists the sidebar newest first within each group, and the group with the newest thread first", () => {
    const fresh: Thread = {
      ...middle,
      id: "fresh",
      comments: [comment("f1", "person", "Fresh note question", "2026-10-06T09:00:00Z")],
    };
    const { inbox } = renderInbox(model([older, middle, newest, fresh]));
    expect(entries(inbox).map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Newest draft"),
      expect.stringContaining("Older answer"),
      expect.stringContaining("Fresh note question"),
      expect.stringContaining("Done"),
    ]);
  });
});

describe("placement", () => {
  it("puts New comment after the tabs and before the action bar and the first entry", () => {
    const { inbox } = renderInbox();
    const tabs = within(inbox).getByRole("tablist", { name: "Show" });
    const create = within(inbox).getByRole("button", { name: "New comment" });
    const bar = within(inbox).getByRole("group", { name: /Act on the 3 threads shown/ });
    const first = entries(inbox)[0]!;
    expect(tabs.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.closest(".primary-inbox-compose")).not.toBeNull();
  });

  it("overlays the canvas: no rule narrows the main column while the sidebar is open", () => {
    const css = readFileSync(resolve(__dirname, "../src/comments/primary-comments.css"), "utf8");
    expect(css).not.toMatch(/data-review-open/);
    expect(css).not.toMatch(/\.archer-main\s*\{[^}]*margin-right/);
    const app = readFileSync(resolve(__dirname, "../src/app/App.tsx"), "utf8");
    expect(app).not.toMatch(/primary-shell"\s+data-review-open/);
  });

  it("slides in from the right and appears without sliding under reduced motion", () => {
    const css = readFileSync(resolve(__dirname, "../src/comments/primary-comments.css"), "utf8");
    expect(css).toMatch(/\.primary-review-inbox\{[^}]*animation:primary-review-in[^}]*\}/);
    expect(css).toMatch(/@keyframes primary-review-in\{from\{transform:translateX\(100%\)\}/);
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.primary-review-inbox\{animation:none\}/);
    expect(css).toMatch(/\.primary-review-inbox\{[^}]*box-shadow:var\(--shadow-panel\)/);
    expect(css).toMatch(/\.primary-review-inbox\{[^}]*z-index:39/);
  });

  it("gives every row of a collapsed thread a fixed height, so every collapsed thread is the same height", () => {
    const css = readFileSync(resolve(__dirname, "../src/comments/primary-comments.css"), "utf8");
    const rule = (selector: string): string =>
      css.match(new RegExp(`${selector.replace(/[.[\]"=]/g, (m) => `\\${m}`)}\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".primary-inbox-headline")).toMatch(/(^|;)height:20px/);
    expect(rule(".primary-inbox-meta")).toMatch(/(^|;)height:20px/);
    expect(rule(".primary-inbox-meta")).toMatch(/overflow:hidden/);
    expect(rule(".primary-inbox-gap")).toMatch(/(^|;)height:18px/);
    expect(rule(".primary-inbox-text")).toMatch(/line-height:18px/);
    expect(rule('.primary-inbox-line[data-line="first"] .primary-inbox-text')).toMatch(
      /-webkit-line-clamp:2;.*height:36px/,
    );
    expect(rule('.primary-inbox-line[data-line="last"] .primary-inbox-text')).toMatch(
      /-webkit-line-clamp:1;.*height:18px/,
    );
  });
});

describe("tabs", () => {
  it("replaces the filter with All, Unread, Answered and Drafts tabs, each with a live count", () => {
    const { inbox } = renderInbox();
    expect(within(inbox).queryByRole("combobox")).toBeNull();
    const tabs = within(inbox).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["All3", "Unread2", "Answered2", "Drafts1"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAccessibleName("All, 3 threads");
  });

  it("shows only the tab’s threads; Answered includes the threads the agent resolved", () => {
    const { inbox } = renderInbox();
    fireEvent.click(within(inbox).getByRole("tab", { name: /Answered/ }));
    expect(entries(inbox).map((e) => e.textContent)).toEqual([
      expect.stringContaining("Done"),
      expect.stringContaining("Older answer"),
    ]);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Drafts/ }));
    expect(entries(inbox).map((e) => e.textContent)).toEqual([expect.stringContaining("Newest draft")]);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Unread/ }));
    expect(entries(inbox)).toHaveLength(2);
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    const { inbox } = renderInbox();
    const [all, unread, , drafts] = within(inbox).getAllByRole("tab");
    expect(all).toHaveAttribute("tabindex", "0");
    expect(unread).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(all!, { key: "ArrowRight" });
    expect(unread).toHaveFocus();
    expect(unread).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(unread!, { key: "End" });
    expect(drafts).toHaveFocus();
    fireEvent.keyDown(drafts!, { key: "ArrowRight" });
    expect(all).toHaveFocus();
  });

  it("says so when a tab has nothing in it", () => {
    const { inbox } = renderInbox(model([newest]));
    fireEvent.click(within(inbox).getByRole("tab", { name: /Answered/ }));
    expect(within(inbox).getByText("Nothing answered yet.")).toBeVisible();
  });

  it("shows Drafts only while there is a draft: comments sent at once never wait (decided 2026-10-29)", () => {
    const { inbox } = renderInbox(model([older]));
    expect(within(inbox).queryByRole("tab", { name: /Drafts/ })).toBeNull();
    expect(
      within(inbox)
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.replace(/\d+/g, "").trim()),
    ).toEqual(["All", "Unread", "Answered"]);
  });
});

describe("grouping and the collapsed thread", () => {
  it("groups threads under their diagram or note, with a count, most recent group first", () => {
    const { inbox } = renderInbox(undefined, { targetTitle: (t: string) => (t === "view:system" ? "System" : "Auth") });
    const headings = within(inbox).getAllByRole("heading", { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(["System2 threads", "Auth (note)1 thread"]);
    expect(entries(inbox).map((e) => e.textContent)).toEqual([
      expect.stringContaining("Newest draft"),
      expect.stringContaining("Older answer"),
      expect.stringContaining("Done"),
    ]);
  });

  it("shows the target, status, message count, the opening message, the gap and the latest reply", () => {
    const many: Thread = {
      ...older,
      id: "many",
      comments: [
        comment("a", "person", "Opening question", "2026-10-01T09:00:00Z"),
        comment("b", "agent", "First answer", "2026-10-01T09:30:00Z"),
        comment("c", "person", "Follow-up", "2026-10-01T09:40:00Z"),
        comment("d", "agent", "Latest answer", "2026-10-01T10:00:00Z"),
      ],
    };
    const { inbox } = renderInbox(model([many, newest]));
    const [draft, long] = entries(inbox);
    expect(long).toHaveTextContent(/Node: Web/);
    expect(long).toHaveTextContent(/Answered/);
    expect(long).toHaveTextContent(/4 messages/);
    expect(long).toHaveTextContent(/You\s*Opening question/);
    expect(long).toHaveTextContent("2 more messages");
    expect(long).toHaveTextContent(/Agent\s*Latest answer/);
    expect(long).not.toHaveTextContent("First answer");
    expect(long).toHaveTextContent("Unread");
    expect(draft).toHaveTextContent("1 message");
    expect(draft).toHaveTextContent("No reply yet");
    expect(draft).not.toHaveTextContent("Unread");
    // Every collapsed entry has the same rows, the gap row empty when there is no gap.
    for (const entry of [draft!, long!]) {
      expect(
        entry.querySelectorAll(
          '.primary-inbox-headline, .primary-inbox-meta, .primary-inbox-line[data-line="first"], .primary-inbox-gap, .primary-inbox-line[data-line="last"]',
        ),
      ).toHaveLength(5);
    }
  });
});

describe("selection", () => {
  it("selects threads one at a time or all shown, with an indeterminate Select all between", () => {
    const { inbox } = renderInbox();
    const all = within(inbox).getByRole("checkbox", { name: "Select all shown threads" }) as HTMLInputElement;
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }));
    expect(all.indeterminate).toBe(true);
    expect(within(inbox).getByRole("group", { name: /1 selected/ })).toHaveTextContent("1 selected");
    fireEvent.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(within(inbox).getByRole("group", { name: /3 selected/ })).toBeVisible();
    fireEvent.click(within(inbox).getByRole("button", { name: "Clear" }));
    expect(within(inbox).getByRole("group", { name: /Act on the 3 threads shown/ })).toBeVisible();
    for (const box of within(inbox).getAllByRole("checkbox")) expect(box).not.toBeChecked();
  });

  it("drops a selection the new tab does not show", () => {
    const { inbox } = renderInbox();
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Database" }));
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }));
    fireEvent.click(within(inbox).getByRole("tab", { name: /Drafts/ }));
    expect(within(inbox).getByRole("group", { name: /1 selected/ })).toBeVisible();
    fireEvent.click(within(inbox).getByRole("tab", { name: /All/ }));
    expect(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" })).not.toBeChecked();
  });

  it("offers only what applies to the selection, and acts on just those threads", async () => {
    const held = model(undefined, { publishAll: vi.fn(async () => 1) });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Database" }));
    const bar = within(inbox).getByRole("group", { name: /1 selected/ });
    expect(within(bar).queryByRole("button", { name: "Mark read" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(held.actions.publishAll).toHaveBeenCalledWith([newest]));
    await waitFor(() => expect(within(inbox).getByRole("group", { name: /Act on the 3 threads shown/ })).toBeVisible());
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }));
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Whole note" }));
    const two = within(inbox).getByRole("group", { name: /2 selected/ });
    expect(within(two).queryByRole("button", { name: "Publish" })).toBeNull();
    fireEvent.click(within(two).getByRole("button", { name: "Mark read" }));
    expect(held.actions.markAllSeen).toHaveBeenCalledWith([older, middle]);
  });

  it("asks before resolving the selection, naming the count", async () => {
    const held = model(undefined, { resolveAll: vi.fn(async () => 2) });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }));
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Whole note" }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve" }));
    const confirm = within(inbox).getByRole("group", { name: "Resolve 2 threads?" });
    expect(within(confirm).getByRole("button", { name: "Keep" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Resolve 2" }));
    await waitFor(() => expect(held.actions.resolveAll).toHaveBeenCalledWith([older, middle]));
  });

  it("tints a selected thread and the bar", () => {
    const { inbox } = renderInbox();
    fireEvent.click(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }));
    expect(within(inbox).getByRole("checkbox", { name: "Select thread on Node: Web" }).closest("li")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(within(inbox).getByRole("group", { name: /1 selected/ })).toHaveAttribute("data-active", "true");
  });
});

describe("the action bar with nothing selected", () => {
  it("offers Mark read (n) and Resolve (n) on All and Unread, Resolve as the primary", () => {
    const held = model();
    const { inbox } = renderInbox(held);
    const markRead = within(inbox).getByRole("button", { name: "Mark read (2)" });
    const resolveAll = within(inbox).getByRole("button", { name: "Resolve (3)" });
    expect(resolveAll).toHaveClass("archer-review-button--primary");
    expect(markRead).not.toHaveClass("archer-review-button--primary");
    fireEvent.click(markRead);
    expect(held.actions.markAllSeen).toHaveBeenCalledWith([older, middle]);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Unread/ }));
    expect(within(inbox).getByRole("button", { name: "Resolve (2)" })).toBeVisible();
  });

  it("offers only Resolve (n) on Answered, and Publish (n) with Resolve (n) on Drafts", async () => {
    const held = model(undefined, { publishAll: vi.fn(async () => 1) });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Answered/ }));
    const bar = within(inbox).getByRole("group", { name: /Act on the 2 threads shown/ });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Resolve (2)"]);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Publish (1)" }));
    await waitFor(() => expect(held.actions.publishAll).toHaveBeenCalledWith([newest]));
  });

  it("disables Mark read with its reason when nothing shown is unread", () => {
    const { inbox } = renderInbox(model([newest]));
    const button = within(inbox).getByRole("button", { name: "Mark read" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Nothing shown is unread.");
  });

  it("asks before resolving, naming the count, and resolves every thread shown", async () => {
    const held = model(undefined, { resolveAll: vi.fn(async () => 3) });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve (3)" }));
    const confirm = within(inbox).getByRole("group", { name: "Resolve 3 threads?" });
    expect(confirm).toHaveTextContent("Resolving removes them for good.");
    expect(within(confirm).getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(held.actions.resolveAll).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Resolve 3" }));
    await waitFor(() => expect(held.actions.resolveAll).toHaveBeenCalledWith([newest, older, middle]));
    await waitFor(() => expect(within(inbox).queryByRole("group", { name: /Resolve 3 threads/ })).toBeNull());
  });

  it("keeps everything when the confirmation is declined, by Keep or Escape, and returns focus", () => {
    const held = model();
    const { inbox, props } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve (3)" }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Keep" }));
    expect(within(inbox).getByRole("button", { name: "Resolve (3)" })).toHaveFocus();
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve (3)" }));
    fireEvent.keyDown(within(inbox).getByRole("button", { name: "Keep" }), { key: "Escape" });
    expect(within(inbox).queryByRole("group", { name: /threads\?/ })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(held.actions.resolveAll).not.toHaveBeenCalled();
  });

  it("shows one busy state while a batch runs, then returns the bar", async () => {
    let finish: (n: number) => void = () => {};
    const held = model(undefined, {
      resolveAll: vi.fn(
        () =>
          new Promise<number>((done) => {
            finish = done;
          }),
      ),
    });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve (3)" }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve 3" }));
    const busy = await within(inbox).findByRole("group", { name: "Resolving 3 threads…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveTextContent("Resolving 3 threads…");
    expect(
      within(busy)
        .queryAllByRole("button")
        .filter((b) => !(b as HTMLButtonElement).disabled),
    ).toEqual([]);
    expect(entries(inbox)).toHaveLength(3);
    await act(async () => {
      finish(3);
    });
    await waitFor(() => expect(within(inbox).queryByRole("group", { name: /Resolving/ })).toBeNull());
    expect(within(inbox).getByRole("group", { name: /Act on the 3 threads shown/ })).toBeVisible();
  });

  it("says Publishing while a publish runs", async () => {
    let finish: (n: number) => void = () => {};
    const held = model(undefined, {
      publishAll: vi.fn(
        () =>
          new Promise<number>((done) => {
            finish = done;
          }),
      ),
    });
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Publish (1)" }));
    expect(await within(inbox).findByRole("group", { name: "Publishing 1 draft…" })).toBeVisible();
    await act(async () => {
      finish(1);
    });
  });
});

describe("a thread answered in the sidebar", () => {
  it("expands in place with the whole thread and saves a reply as a draft through the reply action", async () => {
    const held = model();
    const { inbox, props } = renderInbox(held);
    const entry = entries(inbox).find((e) => e.textContent?.includes("Older answer"))!;
    fireEvent.click(entry);
    expect(entry).toHaveAttribute("aria-expanded", "true");
    const card = within(inbox).getByRole("article", { name: /Web/ });
    expect(within(card).getByText("Older question")).toBeVisible();
    expect(held.actions.markSeen).toHaveBeenCalledWith(older);
    expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull();
    expect(props.onOpenTarget).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Your reply" }), { target: { value: "Answered here" } });
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(held.actions.reply).toHaveBeenCalledWith(older, "Answered here"));
  });

  it("keeps one thread expanded at a time and toggles from the keyboard", () => {
    const { inbox } = renderInbox();
    const [first, second] = entries(inbox);
    fireEvent.click(first!);
    fireEvent.click(second!);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(within(inbox).getAllByRole("article")).toHaveLength(1);
    fireEvent.click(second!);
    expect(second).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses on Escape, returns focus to the entry, and leaves the sidebar open", () => {
    const { inbox, props } = renderInbox();
    const entry = entries(inbox)[0]!;
    fireEvent.click(entry);
    fireEvent.keyDown(within(inbox).getByRole("button", { name: "Reply" }), { key: "Escape" });
    expect(entry).toHaveAttribute("aria-expanded", "false");
    expect(entry).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(entry, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("shows the thread on its diagram from the expanded entry, where its discussion opens", () => {
    const { inbox, props } = renderInbox();
    const entry = entries(inbox).find((e) => e.textContent?.includes("Older answer"))!;
    fireEvent.click(entry);
    fireEvent.click(within(inbox).getByRole("button", { name: "Show on diagram" }));
    expect(props.onOpenTarget).toHaveBeenCalledWith("view:system");
    expect(props.onShowAnchor).toHaveBeenCalledWith(older.anchor);
    expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveTextContent("Older question");
    expect(entry).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps an unread thread listed under Unread while it is open, and lets it go once collapsed", () => {
    const held: ReviewModel = { ...model(), isUnread: undefined };
    const { inbox } = renderInbox(held);
    fireEvent.click(within(inbox).getByRole("tab", { name: /Unread/ }));
    const entry = entries(inbox).find((e) => e.textContent?.includes("Older answer"))!;
    fireEvent.click(entry);
    expect(within(inbox).getByRole("article", { name: /Web/ })).toBeVisible();
    fireEvent.click(entry);
    expect(entries(inbox).some((e) => e.textContent?.includes("Older"))).toBe(false);
  });

  it("names a note thread’s control for the note", () => {
    const { inbox } = renderInbox();
    fireEvent.click(entries(inbox).find((e) => e.textContent?.includes("Done"))!);
    expect(within(inbox).getByRole("button", { name: "Show in note" })).toBeVisible();
  });

  it("moves focus to the next entry when the expanded thread is resolved", async () => {
    installMatchMedia(false);
    const held = model();
    const props = {
      mode: "floating" as const,
      model: held,
      open: true,
      compose: null,
      onClose: () => {},
      onCompose: () => {},
      onComposeEnd: () => {},
      diagramChoices: [],
    };
    const { rerender } = render(<ReviewPanel {...props} />);
    const inbox = screen.getByRole("region", { name: "Project Review" });
    fireEvent.click(entries(inbox)[0]!);
    fireEvent.click(within(inbox).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(held.actions.resolve).toHaveBeenCalledWith(newest));
    // The model answers without the thread, as useReview does once the server has removed it.
    rerender(
      <ReviewPanel
        {...props}
        model={{
          ...held,
          threads: new Map([
            ["view:system", [older]],
            ["note:notes/auth.md", [middle]],
          ]),
        }}
      />,
    );
    await waitFor(() => expect(entries(inbox)[0]).toHaveFocus());
    expect(entries(inbox)[0]).toHaveTextContent("Done");
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  it("says how long ago, briefly", () => {
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(relativeTime(now - 40 * 86_400_000, now)).toMatch(/Aug/);
    expect(relativeTime(Number.NEGATIVE_INFINITY, now)).toBe("");
  });
});

describe("bulk actions in the review model", () => {
  it("resolves several threads with one announcement and reports what failed", async () => {
    localStorage.clear();
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const a = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "One" });
    const b = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Two" });
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(2));
    const threads = result.current.threads.get("view:system")!;
    let resolved = 0;
    await act(async () => {
      resolved = await result.current.actions.resolveAll!(threads);
    });
    expect(resolved).toBe(2);
    expect(transport.store.list("view:system")).toEqual([]);
    expect(result.current.threads.get("view:system")).toEqual([]);
    expect(result.current.announcement?.text).toBe("Resolved 2 threads.");
    expect(result.current.error).toBeNull();
    void a;
    void b;
  });

  it("says how many could not be resolved, and keeps them", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "One" });
    transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Two" });
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(2));
    transport.fail("resolve", "disk full");
    await act(async () => {
      await result.current.actions.resolveAll!(result.current.threads.get("view:system")!);
    });
    expect(result.current.threads.get("view:system")).toHaveLength(1);
    expect(result.current.announcement?.text).toBe("Resolved 1 of 2 threads; 1 could not be resolved: disk full.");
    expect(result.current.error).toBe("Could not resolve 1 thread: disk full");
  });

  /** A transport whose resolves wait to be let go, one by one, in any order; each answered write is followed by its `comments` event, as the service sends it. */
  function gatedResolves(count: number) {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    for (let i = 0; i < count; i += 1)
      transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: `Thread ${i}` });
    const gates: (() => void)[] = [];
    let inFlight = 0,
      most = 0;
    const gated = {
      ...transport,
      resolve: (id: string) =>
        new Promise<void>((done, fail) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          gates.push(() => {
            transport.resolve(id).then(() => {
              inFlight -= 1;
              events.emit({ type: "comments", target: "view:system" });
              done();
            }, fail);
          });
        }),
    };
    return { transport, gated, events, gates, most: () => most };
  }

  it("resolves concurrently, a bounded number at a time, and applies the whole batch in one update", async () => {
    localStorage.clear();
    const { transport, gated, events, gates, most } = gatedResolves(8);
    const seen: (number | undefined)[] = [];
    const { result } = renderHook(() => {
      const review = useReview({
        transport: gated,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      });
      seen.push(review.threads.get("view:system")?.length);
      return review;
    });
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(8));
    let done: Promise<number> = Promise.resolve(0);
    act(() => {
      done = result.current.actions.resolveAll!(result.current.threads.get("view:system")!);
    });
    await waitFor(() => expect(gates).toHaveLength(6));
    // Answers arrive out of order, each with its event; the list holds still.
    for (const at of [3, 0, 5, 1, 4, 2]) {
      await act(async () => {
        gates[at]!();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(result.current.threads.get("view:system")).toHaveLength(8);
    }
    await waitFor(() => expect(gates).toHaveLength(8));
    await act(async () => {
      gates[7]!();
      gates[6]!();
      await done;
    });
    expect(most()).toBe(6);
    expect(transport.store.list("view:system")).toEqual([]);
    await waitFor(() => expect(result.current.threads.get("view:system")).toEqual([]));
    // Never a partial list: eight, then none.
    expect(new Set(seen.filter((n) => n !== undefined))).toEqual(new Set([8, 0]));
    expect(result.current.announcement?.text).toBe("Resolved 8 threads.");
    expect(result.current.error).toBeNull();
  });

  it("removes what went and keeps what failed in the same single update", async () => {
    const { transport, gated, events, gates } = gatedResolves(3);
    const failing = {
      ...gated,
      resolve: (id: string) =>
        id === transport.store.list("view:system")[1]!.id ? Promise.reject(new Error("locked")) : gated.resolve(id),
    };
    const seen: (number | undefined)[] = [];
    const { result } = renderHook(() => {
      const review = useReview({
        transport: failing,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      });
      seen.push(review.threads.get("view:system")?.length);
      return review;
    });
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(3));
    let done: Promise<number> = Promise.resolve(0);
    act(() => {
      done = result.current.actions.resolveAll!(result.current.threads.get("view:system")!);
    });
    await waitFor(() => expect(gates).toHaveLength(2));
    let gone = 0;
    await act(async () => {
      gates[1]!();
      await new Promise((r) => setTimeout(r, 0));
      gates[0]!();
      gone = await done;
    });
    expect(gone).toBe(2);
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(1));
    expect(new Set(seen.filter((n) => n !== undefined))).toEqual(new Set([3, 1]));
    expect(result.current.announcement?.text).toBe("Resolved 2 of 3 threads; 1 could not be resolved: locked.");
    expect(result.current.error).toBe("Could not resolve 1 thread: locked");
  });

  it("resolves a thread the agent resolved by dismissing it, in the same batch", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const done = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "One" });
    transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Two" });
    transport.store.submit();
    transport.store.agentResolve(done.id);
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(2));
    transport.calls.length = 0;
    await act(async () => {
      await result.current.actions.resolveAll!(result.current.threads.get("view:system")!);
    });
    expect(transport.calls.filter((c) => c === "dismiss" || c === "resolve").sort()).toEqual(["dismiss", "resolve"]);
    expect(result.current.threads.get("view:system")).toEqual([]);
    expect(result.current.announcement?.text).toBe("Resolved 2 threads.");
  });

  it("publishes exactly the given drafts, leaves the others held, and shows the result in one update", async () => {
    localStorage.clear();
    const transport = memoryTransport([]),
      events = createReviewEvents();
    for (const body of ["One", "Two", "Three"])
      transport.store.create({ target: "view:system", anchor: { kind: "view" }, body });
    const seen: string[] = [];
    const { result } = renderHook(() => {
      const review = useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      });
      seen.push((review.threads.get("view:system") ?? []).map((t) => t.status).join(","));
      return review;
    });
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(3));
    const [one, two] = result.current.threads.get("view:system")!;
    let published = 0;
    await act(async () => {
      published = await result.current.actions.publishAll!([one!, two!]);
    });
    expect(published).toBe(2);
    await waitFor(() =>
      expect(result.current.threads.get("view:system")!.map((t) => t.status)).toEqual(["sent", "sent", "draft"]),
    );
    // Never one published and one not: the list goes from three drafts to its result at once.
    expect(seen.filter((s) => s !== "")).not.toContain("sent,draft,draft");
    expect(result.current.announcement?.text).toBe("Published 2 threads.");
    expect(result.current.error).toBeNull();
  });

  it("says how many drafts could not be published, and keeps them as drafts", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    for (const body of ["One", "Two"])
      transport.store.create({ target: "view:system", anchor: { kind: "view" }, body });
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(2));
    transport.fail("submitOnce", "locked");
    await act(async () => {
      await result.current.actions.publishAll!(result.current.threads.get("view:system")!);
    });
    await waitFor(() =>
      expect(
        result.current.threads
          .get("view:system")!
          .map((t) => t.status)
          .sort(),
      ).toEqual(["draft", "sent"]),
    );
    expect(result.current.announcement?.text).toBe("Published 1 of 2 threads; 1 could not be published: locked.");
    expect(result.current.error).toBe("Could not publish 1 thread: locked");
  });

  it("dismisses agent-resolved threads in one action", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const t = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "One" });
    transport.store.submit();
    transport.store.agentResolve(t.id);
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:system")?.[0]?.status).toBe("resolved"));
    await act(async () => {
      await result.current.actions.dismissAll!(result.current.threads.get("view:system")!);
    });
    expect(result.current.threads.get("view:system")).toEqual([]);
    expect(result.current.announcement?.text).toBe("Cleared 1 resolved thread.");
  });

  it("marks every given thread read in one action, remembered across reloads", async () => {
    localStorage.clear();
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const t = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "One" });
    transport.store.submit();
    transport.store.agentReply(t.id, "Answer");
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
      }),
    );
    await waitFor(() => expect(result.current.unreadAnswers).toBe(1));
    act(() => result.current.actions.markAllSeen!(result.current.threads.get("view:system")!));
    expect(result.current.unreadAnswers).toBe(0);
    expect(result.current.announcement?.text).toBe("Marked 1 thread read.");
  });

  it("marks a whole set read with one write to browser storage", async () => {
    localStorage.clear();
    const transport = memoryTransport([]),
      events = createReviewEvents();
    for (const body of ["One", "Two", "Three"]) {
      const t = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body });
      transport.store.submit();
      transport.store.agentReply(t.id, `Answer to ${body}`);
    }
    const { result } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
        projectIdentity: "test-project",
      }),
    );
    await waitFor(() => expect(result.current.unreadAnswers).toBe(3));
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => result.current.actions.markAllSeen!(result.current.threads.get("view:system")!));
      expect(write.mock.calls.filter(([key]) => String(key).startsWith("archer-comments-seen:v1:"))).toHaveLength(1);
    } finally {
      write.mockRestore();
    }
    expect(result.current.unreadAnswers).toBe(0);
    expect(result.current.announcement?.text).toBe("Marked 3 threads read.");
  });
});

describe("reads for the view on screen (perf #10)", () => {
  it("capabilities arriving in two steps read the threads and the pending list once", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const pending = vi.spyOn(transport, "pending"),
      threads = vi.spyOn(transport, "listThreads"),
      notes = vi.spyOn(transport, "listNotes");
    const { rerender } = renderHook(
      (capabilities: typeof NO_CAPABILITIES) => useReview({ transport, events, capabilities, viewId: "system" }),
      { initialProps: { ...NO_CAPABILITIES, comments: true, notes: false } },
    );
    rerender({ ...NO_CAPABILITIES, comments: true, notes: true });
    await waitFor(() => expect(notes).toHaveBeenCalledTimes(1));
    expect(pending).toHaveBeenCalledTimes(1);
    expect(threads.mock.calls.filter(([target]) => target === "view:system")).toHaveLength(1);
  });
  it("the project-wide pending list is not read again for the next view shown", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    const pending = vi.spyOn(transport, "pending");
    const { rerender } = renderHook(
      (viewId: string) =>
        useReview({ transport, events, capabilities: { ...NO_CAPABILITIES, comments: true, notes: false }, viewId }),
      { initialProps: "system" },
    );
    rerender("other");
    await waitFor(() => expect(transport.listThreads).toBeDefined());
    await act(async () => {});
    expect(pending).toHaveBeenCalledTimes(1);
  });
});

describe("one read per target at a time (perf #10)", () => {
  it("a view's note that is also a project target is read once", async () => {
    const transport = memoryTransport([]),
      events = createReviewEvents();
    transport.store.create({ target: "note:notes/a.md", anchor: { kind: "view" }, body: "On the note" });
    vi.spyOn(transport, "listNotes").mockResolvedValue({
      viewId: "system",
      notes: [{ path: "notes/a.md", title: "A", viewIds: ["system"] }],
    } as never);
    const threads = vi.spyOn(transport, "listThreads");
    renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
        viewId: "system",
        targets: ["view:system", "note:notes/a.md"],
      }),
    );
    await waitFor(() => expect(threads.mock.calls.some(([target]) => target === "note:notes/a.md")).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(threads.mock.calls.filter(([target]) => target === "note:notes/a.md")).toHaveLength(1);
  });
});
