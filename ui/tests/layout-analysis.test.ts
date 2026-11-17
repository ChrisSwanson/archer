import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../ts/src/mermaid/index";
import {
  analyzeDiagram,
  analysisStates,
  computeDiagramGeometry,
  frameDiagramGeometry,
  type DiagramGeometry,
} from "../src/layout/analysis";
import ELK from "elkjs/lib/elk.bundled.js";
import { NestEngine } from "../src/nesting/nest-engine";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeLayout } from "../src/layout/elk-adapter";
import { layoutBounds, fitPadding } from "../src/diagrams/viewport-fit";
import { HEADING_BAND_PX } from "../src/diagrams/chrome-clearance";
import { layoutJourney } from "../src/export/journey";
import { envelopeFor, loadModelEnvelope } from "./fixtures";
async function sourceEnvelope(source: string) {
  const compiled = await compile(source);
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(compiled.model).not.toBeNull();
  const envelope = envelopeFor(compiled.model as unknown as { type: string } & Record<string, unknown>, "measure");
  if (compiled.model?.type === "sequence-trace") envelope.view.kind = "sequence";
  return envelope;
}
const heartbeat = () =>
  sourceEnvelope(readFileSync(resolve(process.cwd(), "../ts/test/fixtures/layout/heartbeat-lr.mmd"), "utf8"));
describe("source layout analysis", () => {
  test("comment-thread reports small fit text as information without changing suggestion thresholds", async () => {
    const envelope = await sourceEnvelope(
      readFileSync(resolve(process.cwd(), "../examples/archer-tour/.archer/diagrams/comment-thread.mmd"), "utf8"),
    );
    const result = await analyzeDiagram(envelope);
    expect(result.states[0].minimumTextPxAtFit).toBeCloseTo(6.1901, 4);
    expect(result.suggestions).toEqual([]);
    expect(result.notes).toEqual([
      expect.objectContaining({
        code: "text_below_reading_floor_at_fit",
        level: "info",
        stateIndex: 0,
        message: expect.stringMatching(/6\.19px.*12px reading floor.*Zoom in/),
      }),
    ]);
    const roomy = await analyzeDiagram(envelope, { viewport: { canvas: { width: 4000, height: 4000 } } });
    expect(roomy.suggestions).toEqual([]);
    expect(roomy.notes ?? []).toEqual([]);
  });
  test("heartbeat measures full source and fresh collapsed state and explains the width", async () => {
    const result = await analyzeDiagram(await heartbeat());
    expect(result.states).toHaveLength(2);
    expect(result.states[0].bounds).toMatchObject({ width: 3615, height: 278 });
    expect(result.states[0].spanScreens).toEqual({ x: 3.4155, y: 0.3026 });
    expect(result.states[0].minimumTextPxAtFit).toBeCloseTo(3.5134, 4);
    expect(result.states[0].overflowAtAutomaticFrame).toEqual([{ side: "right", count: 7 }]);
    expect(result.states[1]).toMatchObject({
      mode: "nested",
      open: [],
      route: "canonical-fresh",
      bounds: { width: 1937, height: 123.6667 },
      spanScreens: { x: 1.8301, y: 0.1346 },
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ code: "layout_wide_at_reading_zoom", stateIndex: 0 });
    expect(result.suggestions[0].message).toContain("3.42");
    expect(result.suggestions[0].message).toContain("1.83");
    expect(result.suggestions[0].message.length).toBeLessThanOrEqual(400);
  });
  test("canonical nested states reject unknown and unreachable ids before laying out", async () => {
    const envelope = await sourceEnvelope(
      "flowchart TB\n subgraph outer[Outer]\n subgraph inner[Inner]\n a[A]\n end\n end\n b[B]\n a e@--> b\n",
    );
    expect(() => analysisStates(envelope, [{ mode: "nested", open: ["inner"] }])).toThrow(/unreachable/);
    expect(() => analysisStates(envelope, [{ mode: "nested", open: ["nope"] }])).toThrow(/unknown/);
    expect(() =>
      analysisStates(
        envelope,
        Array.from({ length: 9 }, () => ({ mode: "full" as const })),
      ),
    ).toThrow(/eight|8/);
    const result = await analyzeDiagram(envelope, { states: [{ mode: "nested", open: ["inner", "outer"] }] });
    expect(result.states[0]).toMatchObject({ open: ["inner", "outer"], route: "canonical-fresh" });
  });
  test("sequence collapse is refused and tall conversations receive no horizontal advice", async () => {
    const envelope = await sourceEnvelope(
      `sequenceDiagram\n participant a as Reader\n participant b as Agent\n${Array.from({ length: 50 }, () => " a->>b: Explain").join("\n")}\n`,
    );
    expect(() => analysisStates(envelope, [{ mode: "nested", open: [] }])).toThrow(/nested|collapse/);
    const result = await analyzeDiagram(envelope);
    expect(result.states).toHaveLength(1);
    expect(result.states[0].spanScreens!.y).toBeGreaterThan(2);
    expect(result.suggestions).toEqual([]);
  });
  test("an intentionally wide ordered timeline is measured and advisory; meaning stays in source", async () => {
    const source = `flowchart LR\n${Array.from({ length: 18 }, (_, i) => ` n${i}[Year ${2000 + i}]`).join("\n")}\n${Array.from({ length: 17 }, (_, i) => ` n${i} year_${i}@--> n${i + 1}`).join("\n")}\n`;
    const envelope = await sourceEnvelope(source),
      before = JSON.stringify(envelope);
    const result = await analyzeDiagram(envelope);
    expect(result.states[0].spanScreens!.x).toBeGreaterThan(2);
    expect(result.suggestions[0].message).toMatch(/intentional/);
    expect(JSON.stringify(envelope)).toBe(before);
  });
  test("all seven renderer families use production geometry and journey is an honest static board", async () => {
    const sources = [
      "flowchart LR\n a[A]\n b[B]\n a e@--> b\n",
      "sequenceDiagram\n participant a\n participant b\n a->>b: Message\n",
    ];
    const cases = [
      ...(await Promise.all(sources.map(sourceEnvelope))),
      loadModelEnvelope("state", "widened"),
      loadModelEnvelope("er", "widened"),
      loadModelEnvelope("c4", "nested"),
      loadModelEnvelope("architecture", "widened"),
      loadModelEnvelope("journey", "widened"),
    ];
    for (const envelope of cases) {
      const result = await analyzeDiagram(envelope);
      expect(result.states[0].bounds.width).toBeGreaterThan(0);
      expect(result.states[0].bounds.height).toBeGreaterThan(0);
      if (result.basis === "static-export-board") {
        expect(result.states[0].fitZoom).toBeNull();
        expect(result.states[0].spanScreens).toBeNull();
        expect(result.readingZoom).toBeNull();
        expect(result.suggestions).toEqual([]);
      }
    }
  });
  test("canonical measurement is fresh even after a different live expansion history", async () => {
    const envelope = await heartbeat();
    const projection = projectEnvelope(envelope);
    if (!projection.ok || projection.type !== "graph") throw new Error("expected graph");
    const live = new NestEngine({ kernel: new ELK() });
    const key = live.open({ full: projection.view, typeface: "fira", revision: envelope.revision });
    await live.layout(key, []).complete;
    await live.layout(key, ["showing"], { from: [], toggled: "showing" }).complete;
    const historical = await live.layout(key, ["showing", "big_picture"], { from: ["showing"], toggled: "big_picture" })
      .complete;
    const first = await computeDiagramGeometry(envelope, {
      states: [
        { mode: "nested", open: ["showing"] },
        { mode: "nested", open: ["showing", "big_picture"] },
      ],
    });
    const fresh = await computeDiagramGeometry(envelope, {
      states: [{ mode: "nested", open: ["big_picture", "showing"] }],
    });
    expect(first.states[1].bounds).toEqual(fresh.states[0].bounds);
    expect(first.states[1].across).toEqual(fresh.states[0].across);
    expect(layoutBounds(historical)).not.toEqual(fresh.states[0].bounds);
    expect(fresh.limitations.join(" ")).toContain("live expansion history");
    expect(fresh.states[0].route).toBe("canonical-fresh");
  });
  test("long labels, cycles and return-edge captions share the page's complete bounds", async () => {
    const envelope = await sourceEnvelope(
      "flowchart LR\n a[An unusually long first label that wraps over several lines]\n b[Another long label with enough detail to affect its shape]\n c[Return]\n a e1@-->|A relationship with a caption| b\n b e2@--> c\n c e3@-->|A routed return| a\n",
    );
    const projection = projectEnvelope(envelope);
    if (!projection.ok || projection.type !== "graph") throw new Error("expected graph");
    const bounds = layoutBounds(await computeLayout(projection.view))!;
    const measured = (await analyzeDiagram(envelope)).states[0].bounds;
    for (const key of ["x", "y", "width", "height"] as const) expect(measured[key]).toBeCloseTo(bounds[key], 4);
  });
  test("requested legend and heading reservations use the page's helpers", async () => {
    const raw = await computeDiagramGeometry(await heartbeat());
    const canvas = { width: 1025, height: 896 };
    const report = frameDiagramGeometry(raw, { canvas, reserveLegend: true, reserveHeading: true });
    const padding = fitPadding(canvas, true);
    expect(report.viewport.padding).toEqual({ ...padding, top: Math.max(padding.top, HEADING_BAND_PX) });
    expect(report.states[0].spanScreens!.x).toBeGreaterThan(frameDiagramGeometry(raw).states[0].spanScreens!.x);
    expect(() => frameDiagramGeometry(raw, { canvas: { width: 48, height: 48 } })).toThrow(/padding/);
  });
  test("journey bounds come from the same board measurements the export painter uses", async () => {
    const envelope = loadModelEnvelope("journey", "widened");
    const projection = projectEnvelope(envelope);
    if (!projection.ok || projection.type !== "journey") throw new Error("expected journey");
    const painting = layoutJourney(projection.view);
    const report = await analyzeDiagram(envelope);
    expect(report.states[0].bounds).toEqual({ x: 0, y: 0, width: painting.width, height: painting.height });
  });
  test("viewport applies after geometry and never silently selects a phone profile", async () => {
    const geometry = await computeDiagramGeometry(await heartbeat()),
      desktop = frameDiagramGeometry(geometry),
      phone = frameDiagramGeometry(geometry, { canvas: { width: 390, height: 685 } });
    expect(desktop.viewport).toMatchObject({ canvas: { width: 1025, height: 896 }, basis: "desktop-profile" });
    expect(phone.states[0].bounds).toEqual(desktop.states[0].bounds);
    expect(phone.states[0].spanScreens!.x).toBeGreaterThan(desktop.states[0].spanScreens!.x);
  });
});
function geometry(width: number, height: number): DiagramGeometry {
  return {
    engineVersion: "test",
    typeface: "fira",
    basis: "source-layout",
    readingZoom: { min: 1, max: 1 },
    smallestTextPx: 12,
    limitations: [],
    states: [
      {
        stateIndex: 0,
        mode: "full",
        open: null,
        bounds: { x: 0, y: 0, width, height },
        entry: null,
        across: [],
        down: [],
        groups: [],
      },
    ],
  };
}
describe("layout suggestion policy", () => {
  const viewport = { canvas: { width: 1000, height: 1000 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
  test.each([
    [100, 10, undefined],
    [2000, 500, undefined],
    [2001, 500, "layout_wide_at_reading_zoom"],
    [2001, 1100, undefined],
    [2400, 1200, undefined],
    [1600, 1500, undefined],
    [1500, 1600, undefined],
    [1501, 1501, "layout_two_axis_navigation"],
    [600, 5000, undefined],
  ])("%s by %s respects strict thresholds", (width, height, code) => {
    const result = frameDiagramGeometry(geometry(width as number, height as number), viewport);
    expect(result.suggestions[0]?.code).toBe(code);
  });
});

test("fit text uses Show all zoom even when automatic framing stops at the reading floor", () => {
  const report = frameDiagramGeometry(geometry(4000, 1000), {
    canvas: { width: 1000, height: 1000 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  expect(report.states[0].fitZoom).toBe(0.25);
  expect(report.states[0].minimumTextPxAtFit).toBe(3);
  expect(report.states[0].overflowAtAutomaticFrame).toEqual([{ side: "right", count: 0 }]);
});
