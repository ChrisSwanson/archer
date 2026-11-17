/// <reference lib="dom" />

import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFilmPlayer,
  FILM_FRAMES,
  FILM_HIGHLIGHTS,
  filmView,
  SEQUENCE_HIGHLIGHT,
  WALKS,
} from "../../../site/.vitepress/theme/landing-film.mts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
afterEach(() => vi.useRealTimers());

it("plays the design's story in order and loops", () => {
  const leads = FILM_FRAMES.map((frame) => frame.lead);
  // The story the owner's design tells: the drawing, its walk, a pointed question, the agent's next turn, the
  // revision, then the same proposal in order.
  expect([...new Set(leads)]).toEqual([
    "With Archer.",
    "Walk through it.",
    "Point at it.",
    "It waits.",
    "Its next turn.",
    "Revised.",
    "Another view.",
    "Its highlights.",
    "Zoom in.",
  ]);
  expect(filmView(FILM_FRAMES.length)).toEqual(filmView(0));
  expect(filmView(-1)).toEqual(filmView(FILM_FRAMES.length - 1));
  for (const frame of FILM_FRAMES) expect(frame.ms).toBeGreaterThanOrEqual(800);
});

it("never claims the app marks changes in amber, and says what each frame shows", () => {
  for (const frame of FILM_FRAMES) {
    expect(`${frame.lead} ${frame.cap}`).not.toMatch(/amber/i);
    expect(frame.cap.length).toBeGreaterThan(0);
  }
});

it("walks the proposal three steps, each lighting its own parts, then restores the view", () => {
  const lit = FILM_FRAMES.map((_, index) => filmView(index))
    .filter((view) => view.drawing === "proposal")
    .map((view) => view.highlight);
  expect(lit).toContain("proposal-1");
  expect(lit.indexOf("proposal-2")).toBeGreaterThan(lit.indexOf("proposal-1"));
  expect(lit.indexOf("proposal-3")).toBeGreaterThan(lit.indexOf("proposal-2"));
  // Leaving the walkthrough restores the view before the reader selects a part.
  const selecting = FILM_FRAMES.findIndex((frame) => frame.selected);
  expect(filmView(selecting).highlight).toBeNull();
  expect(filmView(selecting).panel).toBe("comments");
});

it("selects the charge connection, comments on it, waits for the agent's next turn and shows the revision", () => {
  const views = FILM_FRAMES.map((_, index) => filmView(index));
  const commenting = views.findIndex((view) => view.comment === "draft");
  expect(views[commenting]!.selection).toBe("charge");
  expect(views[commenting]!.pin).toBe(true);
  const waiting = views.findIndex((view) => view.comment === "waiting");
  expect(waiting).toBeGreaterThan(commenting);
  expect(views[waiting]!.toast).toBe(false);
  const turn = views.findIndex((view) => view.toast);
  expect(turn).toBeGreaterThan(waiting);
  const revised = views.findIndex((view) => view.drawing === "revised");
  expect(revised).toBeGreaterThan(turn);
  expect(views[revised]!.comment).toBe("replied");
  // The agent shows what it changed with Archer's own highlight; the selection is gone.
  expect(views[revised]!.highlight).toBe("revised-agent");
  expect(views[revised]!.selection).toBeNull();
  const sequence = views.findIndex((view) => view.drawing === "sequence");
  expect(sequence).toBeGreaterThan(revised);
  expect(views.slice(sequence).every((view) => view.drawing === "sequence")).toBe(true);
});

it("shows the sequence diagram with the agent's highlights, never a walkthrough (Archer has none there)", () => {
  const views = FILM_FRAMES.map((_, index) => filmView(index)).filter((view) => view.drawing === "sequence");
  expect(views.length).toBeGreaterThan(0);
  for (const view of views) {
    expect(view.step, view.cap).toBe(0);
    expect(view.panel, view.cap).not.toBe("walkthrough");
    expect(`${view.lead} ${view.cap}`).not.toMatch(/walkthrough/i);
  }
  // With no walkthrough open the app shows the agent's highlights at once, with their legend; then the reader zooms in.
  expect(views[0]!.highlight).toBe("sequence-agent");
  expect(views.every((view) => view.highlight === "sequence-agent" && view.panel === "highlights")).toBe(true);
  const zoomed = views.findIndex((view) => view.zoom !== null);
  expect(zoomed).toBeGreaterThan(0);
  // Up to three groups, in Archer's order of colours, each named.
  expect(SEQUENCE_HIGHLIGHT.groups.length).toBeGreaterThan(0);
  expect(SEQUENCE_HIGHLIGHT.groups.length).toBeLessThanOrEqual(3);
  for (const group of SEQUENCE_HIGHLIGHT.groups) expect(group.label.length).toBeGreaterThan(0);
});

it("names highlight members that exist in the walk it belongs to", () => {
  expect(Object.keys(FILM_HIGHLIGHTS).sort()).toEqual(
    ["proposal-1", "proposal-2", "proposal-3", "revised-agent", "sequence-agent"].sort(),
  );
  expect(Object.keys(WALKS)).toEqual(["proposal"]);
  expect(WALKS.proposal).toHaveLength(3);
  // A walk's line brings the boxes at its ends, as the app's walkthrough does.
  for (const step of WALKS.proposal)
    for (const edge of step.edges) {
      expect(step.nodes).toContain(edge.source);
      expect(step.nodes).toContain(edge.target);
    }
});

it("gives every frame an address, a title, a caption and the terminal's scroll and follow-up", () => {
  const first = filmView(0);
  expect(first.address).toBe("127.0.0.1:4317/projects/shop/notes/proposals/payment-worker.md#flow");
  expect(first.terminalAtEnd).toBe(false);
  expect(first.followUp).toBe(false);
  expect(filmView(1).terminalAtEnd).toBe(true);
  const lastSequence = filmView(FILM_FRAMES.length - 1);
  expect(lastSequence.address.endsWith("#sequence")).toBe(true);
  expect(lastSequence.followUp).toBe(true);
  expect(lastSequence.step).toBe(0);
});

function fixture(options: { reducedMotion?: boolean } = {}) {
  vi.useFakeTimers();
  const dom = new JSDOM('<div id="film"></div>', { url: "https://example.test/archer/", pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis;
  let visible: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  (win as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      visible = callback;
    }
    observe() {}
    disconnect() {}
  };
  const frames: number[] = [];
  const player = createFilmPlayer({
    win,
    root: win.document.getElementById("film")!,
    durations: FILM_FRAMES.map((frame) => frame.ms),
    reducedMotion: options.reducedMotion ?? false,
    onFrame: (index) => frames.push(index),
  });
  const show = (on: boolean) => visible?.([{ isIntersecting: on }]);
  const hide = (hidden: boolean) => {
    Object.defineProperty(win.document, "hidden", { value: hidden, configurable: true });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
  };
  return { player, frames, show, hide };
}

it("plays on its own once on screen, frame after frame, and loops", () => {
  const { player, frames, show } = fixture();
  expect(player.state()).toEqual({ paused: false, running: false, frame: 0 });
  show(true);
  expect(player.state().running).toBe(true);
  vi.advanceTimersByTime(FILM_FRAMES[0]!.ms);
  expect(frames).toEqual([1]);
  vi.advanceTimersByTime(FILM_FRAMES.reduce((sum, frame) => sum + frame.ms, 0));
  expect(frames).toContain(0);
  player.dispose();
});

it("starts paused under reduced motion, and plays only when asked", () => {
  const { player, frames, show } = fixture({ reducedMotion: true });
  show(true);
  expect(player.state()).toEqual({ paused: true, running: false, frame: 0 });
  vi.advanceTimersByTime(60_000);
  expect(frames).toEqual([]);
  player.toggle();
  expect(player.state()).toEqual({ paused: false, running: true, frame: 0 });
  vi.advanceTimersByTime(FILM_FRAMES[0]!.ms);
  expect(frames).toEqual([1]);
  player.dispose();
});

it("holds still off screen and in a hidden tab, and resumes the frame it was on", () => {
  const { player, frames, show, hide } = fixture();
  show(true);
  vi.advanceTimersByTime(FILM_FRAMES[0]!.ms - 10);
  show(false);
  expect(player.state().running).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(frames).toEqual([]);
  show(true);
  hide(true);
  expect(player.state().running).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(frames).toEqual([]);
  hide(false);
  expect(player.state()).toEqual({ paused: false, running: true, frame: 0 });
  vi.advanceTimersByTime(FILM_FRAMES[0]!.ms);
  expect(frames).toEqual([1]);
  player.dispose();
});

it("respects the reader's Pause: coming back on screen or to the tab does not start it again", () => {
  const { player, frames, show, hide } = fixture();
  show(true);
  player.toggle();
  expect(player.state()).toEqual({ paused: true, running: false, frame: 0 });
  show(false);
  show(true);
  hide(true);
  hide(false);
  vi.advanceTimersByTime(60_000);
  expect(frames).toEqual([]);
  expect(player.state().paused).toBe(true);
  player.toggle();
  vi.advanceTimersByTime(FILM_FRAMES[0]!.ms);
  expect(frames).toEqual([1]);
  player.dispose();
  vi.advanceTimersByTime(60_000);
  expect(frames).toEqual([1]);
});
