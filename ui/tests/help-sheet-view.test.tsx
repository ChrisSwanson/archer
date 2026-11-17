// @vitest-environment jsdom
//
// The cheat sheet must describe the canvas that is on screen.
//
// `DiagramCanvas` mounts `SequenceCanvas` for a sequence view, and that canvas
// has no React Flow: no marquee and no Space+drag. Those rows are false there
// -- and a false row is worse than an absent one, because the reader stops
// looking for the gesture that does work. What it does share with the graph
// canvas, emphasis included, it must list.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import {
  COMMENTING_SECTION,
  HOTKEYS,
  SEARCH_SECTION,
  SEQUENCE_HOTKEYS,
  WALK_COMMENTING_SECTION,
  commentingSection,
  hotkeysFor,
} from "../src/app/HelpOverlay";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";
import { loadValidFixture } from "./fixtures";

const SEQUENCE_ENVELOPE = loadValidFixture("minimal-sequence.json");

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

const rowsOf = (sections: readonly { keys: readonly (readonly [string, string, ...unknown[]])[] }[]) =>
  sections.flatMap((section) => section.keys);

describe("the sequence list promises only what SequenceCanvas honours", () => {
  it("is a different list from the graph one", () => {
    expect(hotkeysFor("graph")).toBe(HOTKEYS);
    expect(hotkeysFor("sequence")).toBe(SEQUENCE_HOTKEYS);
    expect(SEQUENCE_HOTKEYS).not.toBe(HOTKEYS);
  });

  it("names no gesture the canvas cannot perform", () => {
    const rows = rowsOf(SEQUENCE_HOTKEYS);
    const text = rows.map(([key, meaning]) => `${key} ${meaning}`).join("\n");

    // A drag on this canvas PANS; there is no marquee, additive or otherwise.
    expect(text).not.toMatch(/marquee/i);
    // Space is the selection key here and nothing else: a plain drag already
    // pans, so there is no Space+drag.
    expect(rows.some(([key]) => /Space \+ drag/.test(key))).toBe(false);
    // The things selected are participants and messages, not nodes and edges.
    expect(text).not.toMatch(/\bnodes?\b|\bedges?\b/i);
  });

  it("promises the selection and traversal gestures the canvas now has", () => {
    const rows = rowsOf(SEQUENCE_HOTKEYS);
    const meaningOf = (pattern: RegExp): string | undefined => rows.find(([key]) => pattern.test(key))?.[1];

    // The delegated click handler in `SequenceCanvas`.
    expect(meaningOf(/^Click$/)).toMatch(/participant.*message/i);
    expect(meaningOf(/^⇧ Click$/)).toMatch(/add to or remove/i);
    // The delegated keydown handler, over `sequence-nav.ts`.
    expect(meaningOf(/^Enter \/ Space$/)).toMatch(/select/i);
    expect(meaningOf(/^⇧ Enter \/ ⇧ Space$/)).toMatch(/add to or remove/i);
    expect(meaningOf(/^Tab$/)).toMatch(/participants.*messages/i);
    expect(meaningOf(/^← \/ →$/)).toMatch(/participant/i);
    expect(meaningOf(/^↑ \/ ↓$/)).toMatch(/message/i);
    // The page-level handler in `App`.
    expect(meaningOf(/^⌘\/Ctrl A$/)).toMatch(/select every/i);
    expect(meaningOf(/^Esc$/)).toMatch(/clear/i);
  });

  it("promises the emphasis gestures, which this canvas honours as the graph's does", () => {
    // `set_emphasis` draws on a sequence view, with the graph's legend beside
    // it (`useEmphasisSurface`), so both of its gestures are true here. That
    // each one WORKS is `sequence-emphasis.test.tsx` (the legend row) and
    // `sequence-emphasis-shell.test.tsx` (Esc).
    const section = SEQUENCE_HOTKEYS.find((entry) => entry.section === "Highlights");
    expect(section, "the sequence sheet has no Emphasis section").toBeDefined();
    const graph = HOTKEYS.find((entry) => entry.section === "Highlights")!;
    // The same gestures in the same words: one surface, one promise.
    expect(section!.keys).toEqual(graph.keys);
    expect(section!.keys.map(([key]) => key)).toEqual(["Hover a legend row", "Esc", "?"]);
  });

  it("keeps the pan, zoom and fit rows, which it does honour", () => {
    const rows = rowsOf(SEQUENCE_HOTKEYS);
    const meaningOf = (pattern: RegExp): string | undefined => rows.find(([key]) => pattern.test(key))?.[1];

    // `handleWheel`, plain wheel branch.
    expect(meaningOf(/Two-finger scroll/)).toMatch(/pan/i);
    // `handleMouseDown` / `handleMouseMove`, button 0 and button 1.
    expect(meaningOf(/^Drag$/)).toMatch(/pan/i);
    expect(meaningOf(/Middle-drag/)).toMatch(/pan/i);
    // `handleWheel`, ctrl/meta branch.
    expect(meaningOf(/scroll \/ pinch/)).toMatch(/zoom/i);
    // `handleFit`, over `useCanvasShortcuts`.
    expect(meaningOf(/^1$/)).toMatch(/fit/i);
    // The toggle in `App`, which is live on every view.
    expect(meaningOf(/^\?$/)).toBeDefined();
  });
});

/** `SEARCH_SECTION` (/ and G, `useShellShortcuts`) and the Panels section's Esc, added by `App` on every web page. */
const SHELL_ROWS = [...SEARCH_SECTION.keys.map(([key]) => key), "Esc"];

describe("the presented view decides which list the reader is shown", () => {
  it("shows the sequence rows, and none of the graph-only ones, over a sequence diagram", async () => {
    await mountAgentPresented(<App />, {
      envelope: SEQUENCE_ENVELOPE,
      ready: (container) => {
        expect(container.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
      },
    });

    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");

    const shown = [...dialog.querySelectorAll("dt kbd")].map((kbd) => kbd.textContent);
    // The canvas's rows, then the shell's own (search, and Esc for the panels), which work over any view.
    expect(shown).toEqual([...rowsOf(SEQUENCE_HOTKEYS).map(([key]) => key), ...SHELL_ROWS]);
    expect(shown).toContain("⌘/Ctrl A");
    expect(dialog.textContent).not.toMatch(/Marquee/);
  });

  it("still shows the graph rows over a graph diagram", async () => {
    await mountAgentPresented(<App />);

    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");

    const shown = [...dialog.querySelectorAll("dt kbd")].map((kbd) => kbd.textContent);
    expect(shown).toEqual([...rowsOf(HOTKEYS).map(([key]) => key), ...SHELL_ROWS]);
  });
});

/**
 * Commenting is shown over any diagram the server takes comments on, so its rows are as canvas-bound as the
 * canvas's own: a sequence block or note is clickable only on `SequenceCanvas`, and a graph's sheet that offered one
 * would send the reader looking for something that is not there.
 */
describe("the Commenting rows describe the canvas on screen", () => {
  const SEQUENCE_ROW = "Sequence block / note";
  const keys = (section: { keys: readonly (readonly [string, ...unknown[]])[] }) => section.keys.map(([key]) => key);

  it("offers no sequence block or note over a graph or a journey, walking or not", () => {
    for (const view of ["graph", "journey"] as const)
      for (const walking of [false, true]) {
        const section = commentingSection(view, walking);
        expect(section.section).toBe("Commenting");
        expect(keys(section), `${view}, walking ${walking}`).not.toContain(SEQUENCE_ROW);
        expect(section.keys.map(([, meaning]) => meaning).join("\n")).not.toMatch(/blocks and notes/i);
      }
    expect(commentingSection("graph", false)).toBe(COMMENTING_SECTION);
    expect(commentingSection("graph", true)).toBe(WALK_COMMENTING_SECTION);
  });

  it("offers them over a sequence, after the queued send and before the pins", () => {
    for (const walking of [false, true]) {
      const shown = keys(commentingSection("sequence", walking));
      const base = keys(walking ? WALK_COMMENTING_SECTION : COMMENTING_SECTION);
      const at = base.indexOf("A numbered pin");
      expect(shown).toEqual([...base.slice(0, at), SEQUENCE_ROW, ...base.slice(at)]);
    }
    const row = commentingSection("sequence", false).keys.find(([key]) => key === SEQUENCE_ROW)!;
    expect(row[1]).toMatch(/Click, Enter or Space/);
  });
});
