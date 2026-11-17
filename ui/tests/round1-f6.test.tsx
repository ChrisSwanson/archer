/**
 * Round 1 (UI/UX) pass 2, batch F6: canvas focus, type scale, front door.
 * Each block pins one row of the pass's fix list; every one failed before its fix.
 */
import { throughTokens } from "./stylesheet";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameClearOfChrome } from "../src/diagrams/chrome-clearance";
import { TYPE_FLOOR_PX, revealShift, uncoveredArea, type Box } from "../src/diagrams/viewport-fit";
import { MARKER_FONT_PX, emphasisMarkerSvg } from "../src/emphasis/EmphasisMarker";
import { NODE_KIND_FONT_PX } from "../src/layout/graph-metrics";

describe("a: keyboard focus is brought into the canvas the panel and controls leave (R1-codex-19)", () => {
  // A 936x695 canvas at (64, 105); the diagram panel lies over its right 340 px.
  const canvas: Box = { x: 64, y: 105, width: 936, height: 695 };
  const panel: Box = { x: 660, y: 105, width: 340, height: 695 };
  const tools: Box = { x: 80, y: 515, width: 50, height: 270 };
  const inside = (box: Box, x: number, y: number): boolean =>
    x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
  const covered = (x: number, y: number): boolean =>
    !inside(canvas, x, y) || inside(panel, x, y) || inside(tools, x, y);

  it("finds the part of the canvas no panel covers", () => {
    const free = uncoveredArea(canvas, covered);
    expect(free.x).toBe(64);
    expect(free.x + free.width).toBeLessThanOrEqual(660);
    expect(free.x + free.width).toBeGreaterThan(640);
    expect(free.y).toBe(105);
    expect(free.height).toBe(695);
  });

  it("moves a node under the panel just into the free area", () => {
    const free = uncoveredArea(canvas, covered);
    const node: Box = { x: 700, y: 300, width: 160, height: 60 };
    const shift = revealShift(node, free, covered);
    expect(shift).not.toBeNull();
    const moved = { ...node, x: node.x + shift!.dx, y: node.y + shift!.dy };
    expect(moved.x + moved.width).toBeLessThanOrEqual(free.x + free.width);
    expect(moved.y).toBe(node.y);
  });

  it("finds the part above a phone's dock sheet that covers more than half the canvas", () => {
    const phone: Box = { x: 0, y: 105, width: 390, height: 739 };
    const sheet: Box = { x: 0, y: 420, width: 390, height: 424 };
    const under = (x: number, y: number): boolean => !inside(phone, x, y) || inside(sheet, x, y);
    const free = uncoveredArea(phone, under);
    expect(free.y).toBe(105);
    expect(free.y + free.height).toBeLessThanOrEqual(420);
    expect(free.y + free.height).toBeGreaterThan(400);
    expect(free.width).toBeGreaterThan(380);
    const node: Box = { x: 100, y: 450, width: 180, height: 60 };
    const shift = revealShift(node, free, under)!;
    expect(node.y + shift.dy + node.height).toBeLessThanOrEqual(420);
  });

  it("leaves a node that is already in the clear where it is", () => {
    expect(revealShift({ x: 200, y: 150, width: 160, height: 60 }, uncoveredArea(canvas, covered), covered)).toBeNull();
  });

  it("centres a node a floating control would still cover", () => {
    const free = uncoveredArea(canvas, covered);
    const node: Box = { x: 60, y: 600, width: 120, height: 40 };
    const shift = revealShift(node, free, covered)!;
    const moved = { ...node, x: node.x + shift.dx, y: node.y + shift.dy };
    expect(Math.abs(moved.x + moved.width / 2 - (free.x + free.width / 2))).toBeLessThan(1);
    expect(Math.abs(moved.y + moved.height / 2 - (free.y + free.height / 2))).toBeLessThan(1);
  });
});

describe("b: the chrome's off-scale font sizes are on the type ramp (V1)", () => {
  const css = (path: string): string =>
    readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every font-size a rule for `selector` sets in `file`. */
  const sizes = (file: string, selector: string): string[] => {
    const text = css(file);
    const out: string[] = [];
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, "g"))) {
      for (const size of match[1]!.matchAll(/font-size:\s*([^;]+)/g)) out.push(size[1]!.trim());
    }
    return out;
  };
  const onRamp = /^var\(--type-(floor|small|body|title|display)\)$/;
  for (const [file, selector, why] of [
    ["app/ProjectTitle.css", ".archer-project-title h1", "the project headline, 30px (24px on a phone)"],
    ["app/ProjectTitle.css", ".archer-project-title-description", "the project description, 15px"],
    ["app/ProjectBrowser.css", ".archer-browser-dialog-heading h2", "the Project Filters heading, 24px"],
    ["app/ProjectBrowser.css", ".archer-project-browser .archer-filter-count", "the filter count, inherited 16px"],
    ["accuracy/accuracy.css", ".accuracy-header h2", "the Compare revisions heading, 18px"],
    ["app/ProjectPages.css", ".archer-search-empty", "the empty search's sentence, inherited 16px"],
    [
      "app/SourceDocumentPage.css",
      '.archer-source-reader>:is([role="alert"],[role="status"])',
      "the document page's error, inherited 16px",
    ],
  ] as const) {
    it(`${why}: ${selector}`, () => {
      const found = sizes(file, selector);
      expect(found.length).toBeGreaterThan(0);
      for (const size of found) expect(size).toMatch(onRamp);
    });
  }
});

describe("c: the node-kind eyebrow and the group numbers reach the type floor (V6)", () => {
  it("measures the kind caption at the size the stylesheet draws it, no smaller than the floor", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    // Through its canvas token (redesign slice 8).
    const token = /\.archer-node-kind \{[^}]*font-size: (var\(--[\w-]+\))/.exec(styles)?.[1] ?? "";
    const drawn = /^(\d+)px$/.exec(throughTokens(styles.replace(/\/\*[\s\S]*?\*\//g, ""), token))?.[1];
    expect(NODE_KIND_FONT_PX).toBeGreaterThanOrEqual(TYPE_FLOOR_PX);
    expect(Number(drawn)).toBe(NODE_KIND_FONT_PX);
  });
  it("draws the group number no smaller than the floor, on the canvas and in export", () => {
    expect(MARKER_FONT_PX).toBeGreaterThanOrEqual(TYPE_FLOOR_PX);
    expect(emphasisMarkerSvg(1, 0, 0, "red")).toContain(`font-size="${MARKER_FONT_PX}"`);
  });
});

describe("follow-up: on a touch screen the framing keeps the 44 px cue's band free", () => {
  afterEach(() => vi.unstubAllGlobals());
  const frameTop = (): number =>
    frameClearOfChrome<number>({
      base: { top: 24, right: 24, bottom: 24, left: 24 },
      controls: null,
      frameWith: () => 0,
      overflowOf: () => [{ side: "bottom", count: 3 }] as never,
      hits: () => false,
    }).padding.top;
  const pointer = (coarse: boolean): void => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: coarse && query.includes("pointer: coarse"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  };

  it("reserves the cue's inset, its 44 px touch height and the gap under a coarse pointer", () => {
    pointer(true);
    expect(frameTop()).toBe(10 + 44 + 12);
  });
  it("keeps the 26 px pill's band under a fine pointer", () => {
    pointer(false);
    expect(frameTop()).toBe(10 + 26 + 12);
  });
  it("the stylesheet no longer pulls the touch cue up to make room", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(styles).not.toMatch(/archer-overview-cue\) \{ top: 4px/);
  });
});

describe('follow-up: the note\'s "On this page" list is on the type ramp (V1)', () => {
  it("sets its summary and links at --type-small, not 13px", () => {
    const outline = readFileSync(new URL("../src/comments/NoteOutline.css", import.meta.url), "utf8");
    for (const selector of [".primary-note-outline-disclosure>summary", ".primary-note-outline a"]) {
      const body =
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`).exec(outline)?.[1] ?? "";
      expect(body, selector).toContain("font-size:var(--type-small)");
    }
  });
});

describe("follow-up: the note pages' long-form reading scale is named on the ramp (request: add a reading scale)", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  const styles = read("../src/styles.css");
  const notes = read("../src/comments/primary-comments.css");
  const rule = (css: string, selector: string): string =>
    new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("declares prose 15px, section headings 22.5px and the title 26px in rem on the root", () => {
    expect(styles).toMatch(/--type-reading: 0\.9375rem;/);
    expect(styles).toMatch(/--type-reading-heading: 1\.40625rem;/);
    expect(styles).toMatch(/--type-reading-title: 1\.625rem;/);
  });
  it("sets the note prose, its section headings and its title from them", () => {
    expect(rule(notes, ".primary-note-reader .archer-note-body")).toContain("font-size:var(--type-reading)");
    expect(rule(notes, ".primary-note-reader .archer-note-body :is(h1,h2)")).toContain(
      "font-size:var(--type-reading-heading)",
    );
    expect(rule(notes, ".primary-note-title")).toContain("font-size:var(--type-reading-title)");
  });
  it('sets the figure caption and "Committed …" as metadata, at --type-small', () => {
    expect(rule(notes, ".archer-note-figure-caption")).toContain("font-size:var(--type-small)");
    expect(rule(notes, ".primary-note-meta")).toContain("font-size:var(--type-small)");
  });
  it("is counted by the token census", async () => {
    // @ts-expect-error -- an untyped devkit module
    const { TYPE_TOKENS } = await import("../../tools/devkit/harness/tokens.mjs");
    expect(TYPE_TOKENS).toEqual(
      expect.arrayContaining(["--type-reading", "--type-reading-heading", "--type-reading-title"]),
    );
  });
});
