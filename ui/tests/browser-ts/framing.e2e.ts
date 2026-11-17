/**
 * How every diagram type opens, measured in a real browser against the
 * TypeScript service: the size its text is drawn at on screen, whether a wire
 * or an arrowhead crosses a frame's caption, and how a journey uses the width
 * it is given.
 *
 * The second review (2026-10-04) found each type opening at its own scale --
 * an architecture's labels at 19px, a flowchart's captions at 8px, a
 * sequence's fragment conditions at 7px on a phone -- arrowheads on the "Data
 * tier" caption, and a journey board in the top-left corner of a wide canvas.
 * jsdom lays nothing out and can show none of that; these measure it.
 *
 *   npm --workspace ui run build && npm --workspace ui run test:browser:ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The page under test: this checkout's build, or another (`ARCHER_PAGE`) to show a test red against it. */
const PAGE = testPage();
const FIXTURES = resolve(HERE, "../../../ts/test/fixtures");

/** `READING_TEXT_PX` in `viewport-fit.ts`, with a twentieth of a pixel for rounding. */
const READING = { min: 12, max: 13 };
const ROUNDING = 0.05;

const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** Each drawn type: its golden fixture and the kind its manifest names. */
const TYPES = [
  { type: "flowchart", kind: "data-flow" },
  { type: "sequence", kind: "sequence" },
  { type: "state", kind: "state" },
  { type: "er", kind: "entity-relationship" },
  { type: "c4", kind: "c4" },
  { type: "architecture", kind: "architecture" },
] as const;

let project: TsProject | undefined;

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(page: Page, type: string, kind: string, size: { width: number; height: number }): Promise<void> {
  project = await sharedTsProject({
    files: {
      "archer.toml": `version = 1\n\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "The ${type} drawing"\nsource = ".archer/drawing.mmd"\n`,
      ".archer/drawing.mmd": readFileSync(resolve(FIXTURES, type, "widened.mmd"), "utf8"),
    },
  });
  await page.setViewportSize(size);
  await page.goto(project.url);
  await project.present("drawing");
  await settled(page);
}

/** The camera, as the drawing's transform states it: React Flow's, or the sequence canvas's. */
async function camera(page: Page): Promise<string> {
  return page.evaluate(() => {
    const graph = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (graph !== null) return graph.style.transform;
    const sequence = document.querySelector(".archer-seq-viewport");
    if (sequence !== null) return sequence.getAttribute("transform") ?? "";
    return document.querySelector(".archer-journey-board") === null ? "" : "journey";
  });
}

/** Waits until something is drawn and the camera has stopped moving between two looks. */
async function settled(page: Page): Promise<void> {
  let previous = "";
  await expect
    .poll(async () => {
      const now = await camera(page);
      const still = now !== "" && now === previous;
      previous = now;
      return still;
    })
    .toBe(true);
}

/** Marks set small on purpose, which repeat what a shape already says: not what a framing is held to. */
const BADGES = [
  ".archer-node-kind",
  ".archer-er-key",
  ".archer-seq-fragment-chip-text",
  ".archer-seq-message-number text",
  ".archer-canvas-heading",
  // "start" and "end" beside the pseudo-states: the mark says it already.
  ".archer-state-mark-label",
];

/**
 * The size, in screen pixels, of every rendered piece of reading text:
 * computed font size times its camera scale, with visibility reported separately.
 */
async function readingTextPx(page: Page): Promise<{ text: string; px: number; visible: boolean; caption: boolean }[]> {
  return page.evaluate((badges) => {
    const scopes = [
      ...document.querySelectorAll(
        ".react-flow__viewport, .react-flow__edgelabel-renderer, .archer-seq-viewport, .archer-journey-board",
      ),
    ];
    const graphZoom = (() => {
      const transform = document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
      return Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? 1);
    })();
    const found: { text: string; px: number; visible: boolean; caption: boolean }[] = [];
    for (const element of scopes.flatMap((scope) => [...scope.querySelectorAll("*")])) {
      const own = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if (!own || badges.some((badge) => element.closest(badge) !== null)) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const visible = box.right >= 0 && box.bottom >= 0 && box.left < innerWidth && box.top < innerHeight;
      const scale =
        element instanceof SVGElement
          ? ((element as SVGGraphicsElement).getScreenCTM()?.a ?? 1)
          : element.closest(".react-flow__viewport, .react-flow__edgelabel-renderer") !== null
            ? graphZoom
            : 1;
      // An edge's caption, as against a node's name.
      const caption = element.closest(".react-flow__edgelabel-renderer") !== null;
      found.push({
        text: (element.textContent ?? "").trim().slice(0, 30),
        px: Number.parseFloat(getComputedStyle(element).fontSize) * scale,
        visible,
        caption,
      });
    }
    return found;
  }, BADGES);
}

for (const size of SIZES) {
  test.describe(`every type opens at reading size: ${size.name} ${size.width}x${size.height}`, () => {
    for (const { type, kind } of TYPES) {
      test(`${type}: its smallest reading text is drawn at 12 to 13px`, async ({ page }) => {
        await open(page, type, kind, size);
        const text = await readingTextPx(page);
        expect(text.length, "rendered reading text").toBeGreaterThan(0);
        // Framing protects the globally smallest reading face. The compact
        // rail can leave every 12px state caption outside the phone viewport
        // while its visible 14px names remain readable at the protected scale.
        const visible = text.filter((piece) => piece.visible);
        expect(visible.length, "reading text visible on screen").toBeGreaterThan(0);
        for (const piece of visible)
          expect(piece.px, `visible: "${piece.text}"`).toBeGreaterThanOrEqual(READING.min - ROUNDING);
        const smallest = text.reduce((a, b) => (b.px < a.px ? b : a));
        expect(smallest.px, `smallest: "${smallest.text}"`).toBeGreaterThanOrEqual(READING.min - ROUNDING);
        expect(smallest.px, `smallest: "${smallest.text}" -- magnified past reading size`).toBeLessThanOrEqual(
          READING.max + ROUNDING,
        );
      });
    }

    test("journey: nothing on the board is set under 12px", async ({ page }) => {
      await open(page, "journey", "journey", size);
      const text = await readingTextPx(page);
      expect(text.length).toBeGreaterThan(0);
      for (const piece of text) expect(piece.px, `"${piece.text}"`).toBeGreaterThanOrEqual(READING.min - ROUNDING);
    });
  });
}

type Rect = { x: number; y: number; width: number; height: number };

/** What the edges draw, on screen: points along every wire, a box for every arrowhead, every caption plate. */
async function edgeMarks(page: Page): Promise<{ id: string; wire: { x: number; y: number }[]; heads: Rect[] }[]> {
  return page.evaluate(() => {
    const zoom = Number(
      /scale\(([^)]+)\)/.exec(
        document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "",
      )?.[1] ?? 1,
    );
    // The closed arrowhead is drawn about ten units long and ten across.
    const reach = 10 * zoom;
    return [...document.querySelectorAll<SVGGElement>(".react-flow__edge")].map((edge) => {
      const path = edge.querySelector<SVGPathElement>(".react-flow__edge-path")!;
      const matrix = path.getScreenCTM()!;
      const at = (length: number) => {
        const point = path.getPointAtLength(length);
        return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
      };
      const total = path.getTotalLength();
      const wire = Array.from({ length: Math.ceil(total / 2) + 1 }, (_, i) => at(Math.min(total, i * 2)));
      const head = (tip: { x: number; y: number }, back: { x: number; y: number }): Rect => {
        const horizontal = Math.abs(tip.x - back.x) >= Math.abs(tip.y - back.y);
        return {
          x: Math.min(tip.x, back.x) - (horizontal ? 0 : reach / 2),
          y: Math.min(tip.y, back.y) - (horizontal ? reach / 2 : 0),
          width: Math.abs(tip.x - back.x) + (horizontal ? 0 : reach),
          height: Math.abs(tip.y - back.y) + (horizontal ? reach : 0),
        };
      };
      const heads: Rect[] = [];
      if (path.getAttribute("marker-end")) heads.push(head(at(total), at(Math.max(0, total - reach))));
      if (path.getAttribute("marker-start")) heads.push(head(at(0), at(Math.min(total, reach))));
      return { id: edge.getAttribute("data-id") ?? "", wire, heads };
    });
  });
}

/** Every box drawn by `selector`, with its text. */
async function drawn(page: Page, selector: string): Promise<{ name: string; box: Rect }[]> {
  return page.locator(selector).evaluateAll((spans) =>
    spans.map((span) => {
      const box = span.getBoundingClientRect();
      return { name: span.textContent ?? "", box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }),
  );
}

const inside = (point: { x: number; y: number }, box: Rect): boolean =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const type of ["architecture", "c4"] as const) {
  test(`${type}: no wire, arrowhead or edge caption crosses a frame's caption`, async ({ page }) => {
    await open(page, type, type, { width: 1440, height: 900 });
    const named = await drawn(page, ".archer-frame-caption");
    const plates = await drawn(page, ".archer-edge-label");
    expect(named.length, "the fixture has captioned frames").toBeGreaterThan(0);
    const marks = await edgeMarks(page);
    expect(marks.length).toBeGreaterThan(0);
    const crossings: string[] = [];
    for (const { name, box } of named) {
      for (const edge of marks) {
        if (edge.wire.some((point) => inside(point, box))) crossings.push(`${edge.id}'s wire crosses "${name}"`);
        if (edge.heads.some((head) => overlaps(head, box))) crossings.push(`${edge.id}'s arrowhead is on "${name}"`);
      }
      for (const plate of plates) {
        if (overlaps(plate.box, box)) crossings.push(`the caption "${plate.name}" is on "${name}"`);
      }
    }
    expect(crossings).toEqual([]);
  });
}

test.describe("journey: a composition at desktop width, and stacked on a phone", () => {
  /** Each section's box, and the journey canvas's. */
  async function boxes(page: Page): Promise<{ canvas: Rect; sections: Rect[] }> {
    return page.evaluate(() => {
      const of = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        canvas: of(document.querySelector(".archer-journey")!),
        sections: [...document.querySelectorAll(".archer-journey-section")].map(of),
      };
    });
  }

  test("at 1440 the sections share the width as equal columns, centred, using most of it", async ({ page }) => {
    await open(page, "journey", "journey", { width: 1440, height: 900 });
    const { canvas, sections } = await boxes(page);
    expect(sections).toHaveLength(3);
    const left = Math.min(...sections.map((s) => s.x));
    const right = Math.max(...sections.map((s) => s.x + s.width));
    // Most of the canvas, not a 700px strip in its top-left corner.
    // (Or as wide as the board goes: its columns are capped for a readable
    // card, and with the comments drawer collapsed to its rail the canvas at
    // 1440 is wider than three capped columns.)
    expect(right - left).toBeGreaterThanOrEqual(Math.min(canvas.width * 0.75, 900));
    // Centred: as much room either side.
    expect(Math.abs(left - canvas.x - (canvas.x + canvas.width - right))).toBeLessThanOrEqual(2);
    // Equal columns, each wide enough for a card's longest line.
    for (const section of sections) {
      expect(section.width).toBeGreaterThanOrEqual(260);
      expect(Math.abs(section.width - sections[0].width)).toBeLessThanOrEqual(1);
    }
  });

  test("on a phone the sections stack, each filling the available canvas", async ({ page }) => {
    await open(page, "journey", "journey", { width: 390, height: 844 });
    const { canvas, sections } = await boxes(page);
    for (let i = 1; i < sections.length; i += 1) expect(sections[i].y).toBeGreaterThan(sections[i - 1].y);
    for (const section of sections) {
      // The compact navigation rail reserves part of the phone viewport;
      // sections fill the drawing canvas, as the desktop assertion measures.
      expect(section.width).toBeGreaterThanOrEqual(canvas.width - 2 * 16 - 2);
      expect(section.x).toBeGreaterThanOrEqual(canvas.x);
      expect(section.x + section.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("phone state framing keeps the globally smallest captions at 12px while visible names remain readable", async ({
  page,
}) => {
  await open(page, "state", "state", { width: 390, height: 844 });
  const text = await readingTextPx(page);
  expect(Math.min(...text.map((piece) => piece.px))).toBe(12);
  // The names in view stay at 14px. Captions in view may be at the 12px floor: the canvas is the
  // window's whole width now that the sidebar is a drawer, so more of the drawing fits.
  const visible = text.filter((piece) => piece.visible && !piece.caption);
  expect(visible.length).toBeGreaterThan(0);
  expect(Math.min(...visible.map((piece) => piece.px))).toBe(14);
});
