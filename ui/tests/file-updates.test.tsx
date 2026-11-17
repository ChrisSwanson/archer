// @vitest-environment jsdom
// ADR 0028 change cues: a transient popup next to the notifications inbox says "<file> updated".
// It fades, is never kept in the inbox, coalesces bursts and stays quiet for the person's own saves.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileUpdatesPopup } from "../src/app/FileUpdatesPopup";
import {
  announceFiles,
  expectOwnWrite,
  parseFilesEvent,
  resetFileUpdates,
  COALESCE_MS,
  SHOWN_MS,
} from "../src/app/file-updates";

beforeEach(() => {
  vi.useFakeTimers();
  resetFileUpdates();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The polite live region the popup speaks through. */
const live = (): HTMLElement => document.querySelector<HTMLElement>(".archer-file-updates-live")!;
const entry = (path: string, revision = "sha256:" + "a".repeat(64)) => ({
  path,
  kind: (path.endsWith(".md") ? "note" : "diagram") as "note" | "diagram",
  revision,
});

it("names one updated file by its file name, then fades away on its own", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/notes/plan.md")], added: [], removed: [] });
  });
  expect(live()).toHaveTextContent(/^$/);
  act(() => {
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("plan.md updated");
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS + 1000);
  });
  expect(screen.queryByText("plan.md updated")).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});

it("coalesces a burst into one popup", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/a.mmd")], added: [], removed: [] });
    announceFiles({
      changed: [],
      added: [entry(".archer/notes/b.md"), entry(".archer/notes/c.md"), entry(".archer/notes/d.md")],
      removed: [],
    });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(document.querySelectorAll(".archer-file-updates")).toHaveLength(1);
  expect(live()).toHaveTextContent("a.mmd, b.md and 2 more updated");
});

it("says when the burst was larger than the service would list", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/a.mmd")], added: [], removed: [], truncated: true });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("a.mmd and more updated");
});

it("stays quiet for the person's own save: an exact revision, or a short window for a note", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/diagrams/x.mmd", "sha256:" + "b".repeat(64))], added: [], removed: [] });
    expectOwnWrite(".archer/diagrams/x.mmd", "sha256:" + "b".repeat(64));
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent(/^$/);
  // Someone else's later write of the same file is not the person's own.
  act(() => {
    announceFiles({ changed: [entry(".archer/diagrams/x.mmd", "sha256:" + "c".repeat(64))], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("x.mmd updated");
});

it("pauses while hovered and can be dismissed; it never enters the notifications inbox", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/a.mmd")], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  const popup = screen.getByRole("button", { name: "Dismiss" }).parentElement!;
  fireEvent.mouseEnter(popup);
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS * 3);
  });
  expect(live()).toHaveTextContent("a.mmd updated");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(live()).toHaveTextContent(/^$/);
});

it("says removed for a file that went away", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [], added: [], removed: [{ path: ".archer/old.mmd", kind: "diagram" }] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("old.mmd removed");
});

it("parses only the bounded, well-formed shape of the event", () => {
  expect(parseFilesEvent({ changed: [entry(".archer/a.mmd")], added: [], removed: [] })).not.toBeNull();
  expect(parseFilesEvent({ changed: "x" })).toBeNull();
  expect(
    parseFilesEvent({ changed: [{ path: "/abs/x.mmd", kind: "diagram" }], added: [], removed: [] })?.changed,
  ).toEqual([]);
  expect(
    parseFilesEvent({
      changed: Array.from({ length: 500 }, (_, i) => entry(`.archer/${i}.mmd`)),
      added: [],
      removed: [],
    })?.changed,
  ).toHaveLength(200);
});

it("keeps the latest state of a path in a burst: updated then removed is removed", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/a.mmd")], added: [], removed: [] });
    announceFiles({ changed: [], added: [], removed: [{ path: ".archer/a.mmd", kind: "diagram" }] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("a.mmd removed");
});

it("an embedded save quiets only the next change of that note, never its removal", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    expectOwnWrite(".archer/notes/plan.md", null);
    announceFiles({ changed: [entry(".archer/notes/plan.md")], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent(/^$/);
  act(() => {
    announceFiles({ changed: [entry(".archer/notes/plan.md", "sha256:" + "d".repeat(64))], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("plan.md updated");
  act(() => {
    expectOwnWrite(".archer/notes/other.md", null);
    announceFiles({ changed: [], added: [], removed: [{ path: ".archer/notes/other.md", kind: "note" }] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  expect(live()).toHaveTextContent("other.md removed");
});

it("a focus hold and a hover hold are separate, and a dismissed popup leaves no hold behind", () => {
  render(<FileUpdatesPopup />);
  act(() => {
    announceFiles({ changed: [entry(".archer/a.mmd")], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  const button = screen.getByRole("button", { name: "Dismiss" }),
    popup = button.parentElement!;
  act(() => {
    button.focus();
  });
  fireEvent.mouseEnter(popup);
  fireEvent.mouseLeave(popup);
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS * 2);
  });
  expect(live()).toHaveTextContent("a.mmd updated");
  fireEvent.click(button);
  act(() => {
    announceFiles({ changed: [entry(".archer/b.mmd")], added: [], removed: [] });
    vi.advanceTimersByTime(COALESCE_MS);
  });
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS);
  });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});
