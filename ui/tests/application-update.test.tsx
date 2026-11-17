// @vitest-environment jsdom
// ADR 0032: after `archer restart` brings a new version, the page reloads itself when nothing would be
// lost, and otherwise shows one quiet cue, "Archer was updated · Reload".
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cueLayoutStartFailure,
  holdForUnsavedWork,
  observeApplicationVersion,
  openDraft,
  reloadDecision,
  resetApplicationUpdate,
  restoreScrollAfterUpdate,
  TYPING_QUIET_MS,
} from "../src/app/application-update";
import { ApplicationUpdateCue } from "../src/app/ApplicationUpdateCue";
import { createHttpConnection } from "../src/app/http-connection";

let reload: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  reload = vi.fn<() => void>();
  resetApplicationUpdate({ reload });
  sessionStorage.clear();
  document.body.replaceChildren();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetApplicationUpdate();
});

describe("reloadDecision", () => {
  it.each([
    [{ unsavedWork: false, draftOpen: false, typing: false }, "reload"],
    [{ unsavedWork: false, draftOpen: false, typing: true }, "wait"],
    [{ unsavedWork: true, draftOpen: false, typing: false }, "cue"],
    [{ unsavedWork: false, draftOpen: true, typing: true }, "cue"],
  ] as const)("%o → %s", (safety, expected) => {
    expect(reloadDecision(safety)).toBe(expected);
  });
});

describe("openDraft", () => {
  const page = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body;
  };
  it("is nothing on a page with no open input", () => {
    expect(
      openDraft(page(`<main><input type="search" value="x"><textarea class="archer-composer-text"></textarea></main>`)),
    ).toBe(false);
  });
  it.each([
    [
      "an open comment composer",
      `<form class="archer-composer"><textarea class="archer-composer-text"></textarea></form>`,
    ],
    ["an open node label field", `<textarea class="archer-node-label-input"></textarea>`],
    ["an open editor label field", `<textarea class="authoring-inline-text"></textarea>`],
    ["an open dialog", `<dialog open></dialog>`],
  ])("sees %s", (_label, html) => {
    expect(openDraft(page(html))).toBe(true);
  });
  // Codex review (ADR 0032): a note-highlight label form and a sequence-note textarea hold local text too.
  it.each([
    [
      "any textarea with text (a sequence note)",
      `<div><textarea class="authoring-sequence-note"></textarea></div>`,
      "textarea",
    ],
    [
      "a text field with text (a highlight label)",
      `<form class="note-emphasis-label"><input type="text"></form>`,
      "input",
    ],
  ])("sees %s", (_label, html, selector) => {
    const root = page(html);
    (root.querySelector(selector) as HTMLInputElement).value = "unsaved words";
    expect(openDraft(root)).toBe(true);
  });
  it("does not count a search field's text as a draft", () => {
    const root = page(`<header role="search"><input type="text" class="filter"></header><input type="search">`);
    for (const input of root.querySelectorAll("input")) input.value = "query";
    expect(openDraft(root)).toBe(false);
  });
  it("sees a reply with draft text", () => {
    const root = page(`<form class="archer-thread-form"><textarea class="archer-composer-text"></textarea></form>`);
    root.querySelector("textarea")!.value = "half a reply";
    expect(openDraft(root)).toBe(true);
  });
});

describe("a new application version", () => {
  // Codex review (ADR 0032): a page loaded from the old service just before a hand-over first negotiates
  // with the new one; the version the page was served with is its own, named in its head.
  it("compares with the version the page was served with, when the page names it", () => {
    const meta = document.createElement("meta");
    meta.name = "archer-application-version";
    meta.content = "0.1.0";
    document.head.append(meta);
    try {
      observeApplicationVersion("0.2.0");
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      meta.remove();
    }
  });

  it("reloads a page with nothing to lose, keeping the reader's scroll for the reloaded page", () => {
    document.body.innerHTML = `<article class="primary-note-reader"></article>`;
    document.querySelector(".primary-note-reader")!.scrollTop = 420;
    observeApplicationVersion("0.1.0");
    observeApplicationVersion("0.1.0");
    expect(reload).not.toHaveBeenCalled();
    observeApplicationVersion("0.2.0");
    expect(reload).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(sessionStorage.getItem(`archer:update-scroll:${location.href}`)!);
    expect(saved.roots).toEqual([{ selector: ".primary-note-reader", top: 420 }]);
    // Once: later answers do not reload again.
    observeApplicationVersion("0.3.0");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the cue instead while an editor holds unsaved changes; Reload reloads", () => {
    render(<ApplicationUpdateCue />);
    expect(screen.queryByText(/Archer was updated/)).toBeNull();
    const release = holdForUnsavedWork();
    observeApplicationVersion("0.1.0");
    act(() => observeApplicationVersion("0.2.0"));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Archer was updated");
    release();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the same cue when background layout could not start, announced, and never reloads by itself", () => {
    render(<ApplicationUpdateCue />);
    act(() => cueLayoutStartFailure());
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Layout could not start");
    // A version change after it is the better reason: the cue says so.
    observeApplicationVersion("0.1.0");
    holdForUnsavedWork();
    act(() => observeApplicationVersion("0.2.0"));
    expect(screen.getByRole("status").textContent).toContain("Archer was updated");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the cue while a comment is being written", () => {
    document.body.innerHTML = `<form class="archer-composer"><textarea class="archer-composer-text"></textarea></form>`;
    observeApplicationVersion("0.1.0");
    observeApplicationVersion("0.2.0");
    expect(reload).not.toHaveBeenCalled();
    render(<ApplicationUpdateCue />);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("waits for typing to pause, then reloads", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    const field = document.querySelector("input")!;
    field.focus();
    observeApplicationVersion("0.1.0");
    observeApplicationVersion("0.2.0");
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TYPING_QUIET_MS - 500);
    fireEvent.keyDown(field, { key: "a" });
    vi.advanceTimersByTime(TYPING_QUIET_MS - 100);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is noticed through the HTTP connection after a reconnect to an upgraded service", async () => {
    vi.useFakeTimers();
    const info = {
      browserProtocolMajor: 1,
      supportedBrowserProtocolMajors: [1],
      serverEpoch: "12345678-1234-1234-1234-123456789abc",
      capabilities: [],
      applicationVersion: "0.1.0",
      semanticSchemaVersion: 2,
    };
    const sources: {
      onopen: ((event: Event) => void) | null;
      onerror: ((event: Event) => void) | null;
      close: () => void;
      addEventListener: () => void;
    }[] = [];
    vi.stubGlobal(
      "EventSource",
      class {
        onopen = null;
        onerror = null;
        close = vi.fn();
        addEventListener = vi.fn();
        constructor() {
          sources.push(this);
        }
      },
    );
    let version = "0.1.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...info, applicationVersion: version }) })),
    );
    try {
      const connection = createHttpConnection(vi.fn());
      sources[0]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).not.toHaveBeenCalled();
      version = "0.2.0";
      sources[0]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).toHaveBeenCalledTimes(1);
      connection.disconnect();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("restoreScrollAfterUpdate", () => {
  it("puts the saved scroll back once, for the same address only", () => {
    sessionStorage.setItem(
      `archer:update-scroll:${location.href}`,
      JSON.stringify({ window: 0, roots: [{ selector: ".primary-note-reader", top: 300 }] }),
    );
    document.body.innerHTML = `<article class="primary-note-reader"></article>`;
    const reader = document.querySelector<HTMLElement>(".primary-note-reader")!;
    restoreScrollAfterUpdate();
    expect(reader.scrollTop).toBe(300);
    expect(sessionStorage.getItem(`archer:update-scroll:${location.href}`)).toBeNull();
    reader.scrollTop = 0;
    restoreScrollAfterUpdate();
    expect(reader.scrollTop).toBe(0);
  });
});
